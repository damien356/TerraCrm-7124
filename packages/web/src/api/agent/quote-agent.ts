import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { gateway } from "./gateway";
import { draftBundleWording } from "./bundle-wording";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { checkQuote, type CheckLine } from "../lib/quote-check";
import { liveSellFor } from "../lib/live-sell";
import { sellExGstWithMarkup, markupOf } from "../lib/pricing";
import { discountLimit, discountPercentOf } from "../routes/quotes";
import { bundlesFor } from "../routes/quoteBundles";

/**
 * The quote agent. It reads the quote, searches the price book and the
 * labour rate book, runs the pre-send check and writes client wording. It
 * never changes the quote itself: anything it wants to change comes back as
 * a proposal, and a person taps Apply. Apply goes through the same quote
 * procedures as the builder, so the discount, cost and locking rules hold.
 *
 * Office never sees cost or markup through it. Cost only goes into the
 * model's context, and out of its tools, when the person asking is an Admin.
 */

export const LOCKED = ["accepted", "declined", "expired"];
const KINDS = ["supply", "labour", "prep", "removal", "accessory", "other"] as const;
const UNITS = ["m2", "lm", "each", "hour", "job"] as const;

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const qtyText = (n: number) => String(round2(n));
const seesCost = (a: Pick<Actor, "role">) => a.role === "admin";

export function productName(p: { brand: string; range: string; colour: string; sku?: string | null }) {
  const named = [p.brand, p.range].filter(Boolean).join(" ");
  const out = p.colour ? (named ? `${named} in ${p.colour}` : p.colour) : named;
  return out || p.sku || "Product";
}

/* -------------------------------- proposals ------------------------------- */

export const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_product"),
    productId: z.number().int(),
    qty: z.number().positive(),
  }),
  z.object({
    type: z.literal("add_labour"),
    itemId: z.number().int(),
    qty: z.number().positive(),
    description: z.string().max(300).optional().describe("Only to override the rate book name on the line."),
  }),
  z.object({
    type: z.literal("add_custom"),
    kind: z.enum(KINDS),
    description: z.string().min(1).max(300),
    qty: z.number().positive(),
    unit: z.enum(UNITS),
    unitPrice: z.number().min(0).describe("Sell price ex GST per unit. Only when the user gave it."),
  }),
  z.object({
    type: z.literal("update_line"),
    itemId: z.number().int(),
    qty: z.number().positive().optional(),
    unitPrice: z.number().min(0).optional().describe("Only when the user asked for a price."),
    description: z.string().min(1).max(300).optional(),
  }),
  z.object({ type: z.literal("remove_line"), itemId: z.number().int() }),
  z.object({
    type: z.literal("set_wording"),
    key: z.string().min(1).max(40).describe("Bundle key from the quote."),
    wording: z.string().min(1).max(6000),
  }),
]);
export type ProposalAction = z.infer<typeof actionSchema>;
export type ProposalStep = ProposalAction & {
  /** Built here from the database, never by the model. What the person reads before tapping Apply. */
  label: string;
  status?: "applied" | "failed" | "skipped";
  error?: string;
};
export type Proposal = { summary: string; actions: ProposalStep[] };

type QuoteState = Awaited<ReturnType<typeof loadQuoteState>>;

/** Check one proposed change against the database and describe it. Throws a plain message the model can act on. */
export async function describeAction(a: ProposalAction, state: QuoteState, actor: Pick<Actor, "role">): Promise<string> {
  const line = (id: number) => {
    const l = state.items.find((i) => i.id === id);
    if (!l) throw new Error(`Line ${id} is not on this quote.`);
    return l;
  };
  switch (a.type) {
    case "add_product": {
      const [p] = await db.select().from(schema.products).where(eq(schema.products.id, a.productId));
      if (!p || !p.active) throw new Error(`Product ${a.productId} is not in the price book. Search again.`);
      const sell = await liveSellFor(p);
      const price = sell > 0 ? `at ${money(sell)} per ${p.unit}` : "with no sell price yet, it will need one";
      return `Add ${productName(p)}, ${qtyText(a.qty)} ${p.unit} ${price}`;
    }
    case "add_labour": {
      const [item] = await db.select().from(schema.labourRateItems).where(eq(schema.labourRateItems.id, a.itemId));
      if (!item) throw new Error(`Labour item ${a.itemId} is not in the rate book. Search again.`);
      const rate = await standardRate(item.id);
      if (!rate) throw new Error(`${item.name} has no standard rate yet, so it cannot be added. Tell the user an Admin has to price it in the rate book first.`);
      const sell = sellExGstWithMarkup(rate.amount, item.markupPercent);
      return `Add labour: ${a.description?.trim() || item.name}, ${qtyText(a.qty)} ${item.unit} at ${money(sell)} per ${item.unit}`;
    }
    case "add_custom":
      return `Add ${a.kind} line: ${a.description}, ${qtyText(a.qty)} ${a.unit} at ${money(a.unitPrice)} per ${a.unit}`;
    case "update_line": {
      const l = line(a.itemId);
      const parts: string[] = [];
      if (a.description !== undefined && a.description !== l.description) parts.push(`wording to "${a.description}"`);
      if (a.qty !== undefined && a.qty !== l.qty) parts.push(`qty ${qtyText(l.qty)} to ${qtyText(a.qty)} ${l.unit}`);
      if (a.unitPrice !== undefined && Math.abs(a.unitPrice - l.unitPrice) >= 0.005) {
        parts.push(`price ${money(l.unitPrice)} to ${money(a.unitPrice)} per ${l.unit}`);
      }
      if (!parts.length) throw new Error(`That leaves line ${a.itemId} as it is. Drop it from the proposal.`);
      return `Change ${l.description}: ${parts.join(", ")}`;
    }
    case "remove_line": {
      const l = line(a.itemId);
      if (!seesCost(actor)) throw new Error("Only an Admin can remove a line. Tell the user to ask an Admin, or offer to set the quantity instead.");
      return `Remove ${l.description}`;
    }
    case "set_wording": {
      const b = state.bundles.find((x) => x.key === a.key);
      if (!b) throw new Error(`There is no section "${a.key}" on this quote. Keys: ${state.bundles.map((x) => x.key).join(", ")}.`);
      return `Wording for "${b.title}"`;
    }
  }
}

async function standardRate(itemId: number) {
  const on = new Date().toISOString().slice(0, 10);
  const rates = await db
    .select()
    .from(schema.labourRates)
    .where(and(eq(schema.labourRates.itemId, itemId), isNull(schema.labourRates.installerId)));
  return (
    rates
      .filter((r) => r.effectiveFrom <= on && (!r.effectiveTo || r.effectiveTo >= on))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null
  );
}

/* --------------------------------- quote --------------------------------- */

/** Everything the agent and the check need about one quote. */
export async function loadQuoteState(quoteId: number) {
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!quote) throw new Error("Quote not found");
  const rows = await db
    .select({ item: schema.quoteItems, product: schema.products })
    .from(schema.quoteItems)
    .leftJoin(schema.products, eq(schema.products.id, schema.quoteItems.productId))
    .where(eq(schema.quoteItems.quoteId, quoteId))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
  const items = await Promise.all(
    rows.map(async ({ item, product }) => ({
      ...item,
      productCategory: product?.category ?? null,
      liveSell: product ? await liveSellFor(product) : null,
    })),
  );
  const [contact] = quote.contactId
    ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, quote.contactId))
    : [];
  const [company] = quote.companyId
    ? await db.select().from(schema.companies).where(eq(schema.companies.id, quote.companyId))
    : [];
  const { bundles } = await bundlesFor(quote);
  return {
    quote,
    items,
    customer: company?.name ?? (contact ? `${contact.firstName} ${contact.lastName}`.trim() : null),
    bundles,
    discountPct: discountPercentOf(items),
    discountLimit: await discountLimit(),
  };
}

export function runCheck(state: QuoteState, actor: Pick<Actor, "role" | "canSeeCosts">) {
  const lines: CheckLine[] = state.items.map((i) => ({
    id: i.id,
    kind: i.kind,
    lineType: i.lineType,
    description: i.description,
    qty: i.qty,
    unit: i.unit,
    unitPrice: i.unitPrice,
    listUnitPrice: i.listUnitPrice,
    unitCost: i.unitCost,
    productId: i.productId,
    productCategory: i.productCategory,
    liveSell: i.liveSell,
    flagged: i.flagged,
    flagReason: i.flagReason,
  }));
  return checkQuote({
    hasCustomer: !!(state.quote.contactId || state.quote.companyId),
    isCompany: !!state.quote.companyId,
    hasSupervisor: !!state.quote.supervisorContactId,
    notes: state.quote.notes,
    lines,
    bundles: state.bundles.filter((b) => b.lineIds.length).map((b) => ({ title: b.title, wording: b.wording, stale: b.stale })),
    discountPct: state.discountPct,
    discountLimit: state.discountLimit,
    discountApprovedPct: state.quote.discountApprovedPercent,
    isAdmin: actor.role === "admin",
    // Office never gets margin findings through the agent, even with the cost switch on.
    canSeeCosts: actor.role === "admin" && actor.canSeeCosts,
  });
}

/** The quote as the model sees it. Cost and markup only for an Admin. */
function quoteBrief(state: QuoteState, actor: Pick<Actor, "role">) {
  const q = state.quote;
  const cost = seesCost(actor);
  const lines = state.items.map((i) => {
    const bits = [
      `#${i.id}`,
      i.kind,
      `"${i.description}"`,
      `${qtyText(i.qty)} ${i.unit}`,
      `sell ${money(i.unitPrice)}/${i.unit}`,
      `line ${money(i.total)}`,
      i.productCategory ? `category ${i.productCategory}` : i.productId ? "price book product" : "typed line",
    ];
    if (cost) bits.push(i.unitCost != null ? `cost ${money(i.unitCost)}/${i.unit}, markup ${markupOf(i.unitCost, i.unitPrice) ?? "?"}%` : "no cost");
    if (i.flagged) bits.push(`FLAGGED: ${i.flagReason ?? "needs checking"}`);
    return `- ${bits.join(" | ")}`;
  });
  const bundles = state.bundles.map(
    (b) =>
      `- key "${b.key}": "${b.title}", ${money(b.total)}, ${b.lineIds.length} lines (${b.lineIds.map((id) => `#${id}`).join(" ") || "none"}), ${
        !b.wording.trim() ? "NO WORDING" : b.stale ? "wording out of date" : "wording ok"
      }${b.wording.trim() ? `\n  Wording: """${b.wording.trim().slice(0, 1200)}"""` : ""}`,
  );
  return [
    `Quote #${q.number} v${q.version}, status ${q.status}${LOCKED.includes(q.status) ? " (LOCKED, no changes possible)" : ""}.`,
    `Customer: ${state.customer ?? "none attached"}${q.companyId ? `, company quote, supervisor ${q.supervisorContactId ? "set" : "none (optional)"}` : ""}.`,
    `Subtotal ${money(q.subtotal)} ex GST, total ${money(q.total)} inc GST. Discount off the price book ${state.discountPct}%.`,
    `Client view: ${q.bundleMode}. Sections:`,
    ...(bundles.length ? bundles : ["- none yet"]),
    "Lines:",
    ...(lines.length ? lines : ["- none yet"]),
    q.notes?.trim() ? `Quote notes:\n"""${q.notes.trim().slice(0, 2500)}"""` : "No quote notes.",
  ].join("\n");
}

/* --------------------------------- search -------------------------------- */

const STOP = new Set(["the", "and", "for", "with", "per", "of", "in", "a", "an", "some", "metres", "meters", "square", "sqm", "m2", "lm"]);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

export async function searchProducts(query: string, actor: Pick<Actor, "role">, category?: string | null, limit = 8) {
  const q = words(query);
  // The category is a nudge, not a filter: the model guesses categories, and
  // "floor protection" sits under underlay, not accessory.
  const rows = await db
    .select()
    .from(schema.products)
    .where(!q.length && category ? and(eq(schema.products.active, true), eq(schema.products.category, category)) : eq(schema.products.active, true));
  const scored = rows
    .map((p) => {
      const range = words(p.range);
      const colour = words(p.colour);
      const who = words(`${p.supplier} ${p.brand}`);
      const cat = words(`${p.category} ${p.tier} ${p.sku ?? ""}`);
      let score = 0;
      for (const w of q) {
        if (range.includes(w)) score += 3;
        else if (range.some((r) => r.startsWith(w))) score += 1.5;
        if (colour.includes(w)) score += 2;
        else if (colour.some((r) => r.startsWith(w))) score += 1;
        if (who.includes(w)) score += 1.5;
        if (cat.includes(w) || cat.some((c) => c.startsWith(w))) score += 1;
      }
      if (score > 0 && category && p.category === category) score += 1;
      return { p, score };
    })
    .filter((x) => x.score > 0 || (!q.length && category))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return Promise.all(
    scored.map(async ({ p }) => {
      const sell = await liveSellFor(p);
      return {
        productId: p.id,
        name: productName(p),
        supplier: p.supplier,
        category: p.category,
        unit: p.unit,
        sellExGst: sell > 0 ? sell : null,
        priceOnApplication: p.priceOnApplication,
        ...(seesCost(actor) ? { cost: p.costPrice } : {}),
      };
    }),
  );
}

export async function searchLabour(query: string, actor: Pick<Actor, "role">, limit = 12) {
  const q = words(query);
  const items = await db.select().from(schema.labourRateItems).where(eq(schema.labourRateItems.active, true));
  const scored = items
    .map((it) => {
      const name = words(`${it.name} ${it.groupName}`);
      let score = 0;
      for (const w of q) {
        if (name.includes(w)) score += 2;
        else if (name.some((n) => n.startsWith(w.slice(0, Math.max(4, w.length - 1))))) score += 1;
      }
      return { it, score };
    })
    .filter((x) => !q.length || x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const ids = scored.map((x) => x.it.id);
  const on = new Date().toISOString().slice(0, 10);
  const rates = ids.length
    ? await db
        .select()
        .from(schema.labourRates)
        .where(and(inArray(schema.labourRates.itemId, ids), isNull(schema.labourRates.installerId)))
    : [];
  return scored.map(({ it }) => {
    const live = rates
      .filter((r) => r.itemId === it.id && r.effectiveFrom <= on && (!r.effectiveTo || r.effectiveTo >= on))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    return {
      itemId: it.id,
      name: it.name,
      group: it.groupName,
      unit: it.unit,
      sellExGst: live ? sellExGstWithMarkup(live.amount, it.markupPercent) : null,
      noRate: !live,
      ...(seesCost(actor) ? { cost: live?.amount ?? null } : {}),
    };
  });
}

/* ---------------------------------- run ---------------------------------- */

export type ChatTurn = { role: "user" | "assistant"; content: string };

function systemPrompt(actor: Pick<Actor, "role" | "name">, brief: string) {
  const admin = seesCost(actor);
  return [
    "You are the quote assistant inside Terra Ops, the system Terra Flooring (Gold Coast, Australia) runs on. You help the office build and check flooring quotes.",
    `You are talking to ${actor.name || "a staff member"}, who is ${admin ? "an Admin" : "Office staff"}.`,
    "",
    "How you work:",
    "- You never change the quote yourself. To change anything, call propose with the full list of changes. The person sees the list and taps Apply. Say in one or two sentences what you proposed. Do not repeat the list.",
    "- Use only productId values from search_products and itemId values from search_labour. Never guess an id.",
    "- Prices come from the price book and the rate book. Do not set unitPrice unless the person gave a price. add_custom is for things not in either book, and needs a price from the person.",
    "- Use the quantities the person said. If they give rooms but no measurements, ask for the m2 or lm. Do not round or pad quantities unless asked.",
    "- Carpet normally needs underlay at the same m2 and installation labour. Suggest what looks missing, but only add removal, disposal, levelling or furniture moving when the person asks for it.",
    "- To change a line, use update_line with its #id. To remove one, remove_line.",
    admin ? "" : "- Office cannot remove lines. If removal is wanted, say an Admin has to do it.",
    "- Client wording: call draft_wording for the section, then put the result in propose as set_wording. Never write client wording yourself. If you are also changing lines in the same turn, do the line changes only and offer to write the wording once they are applied.",
    "- Before a quote goes out, or when asked to check it, call run_check. Lead with anything marked stop, then warn. Keep it short. Info items only if they matter.",
    "- Price book questions: search and answer with the sell price ex GST and the unit.",
    admin
      ? "- This person can see cost and markup. Mention them only when asked or when something sells below cost."
      : "- This person cannot see cost, markup, margin or buy prices. Never mention them, never hint at them, and if asked say only an Admin can see those.",
    "- The lines under 'The quote right now' are the truth. A change proposed earlier but skipped, failed or never applied is not on the quote, so never treat it or describe it as included.",
    "- If the quote is locked, explain that a new version is needed to change it, and propose nothing.",
    "",
    "Style: short plain sentences, Australian English, no em dashes or en dashes, no emoji, no headings. Money as $1,234.56 ex GST unless you say otherwise.",
    "",
    "The quote right now:",
    brief,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export type AgentResult = { text: string; proposal: Proposal | null };

/**
 * One turn: the person's words plus recent history in, a reply and maybe a
 * proposal out. Nothing in here writes to the quote.
 */
export async function runQuoteAgent(opts: {
  quoteId: number;
  actor: Pick<Actor, "role" | "name" | "canSeeCosts">;
  history: ChatTurn[];
  message: string;
}): Promise<AgentResult> {
  const { actor } = opts;
  const state = await loadQuoteState(opts.quoteId);
  const locked = LOCKED.includes(state.quote.status);
  let proposal = null as Proposal | null;
  const drafted = new Map<string, string>();

  const tools = {
    run_check: tool({
      description: "Run the pre-send check on the quote as it stands. Plain rules, same answer every time.",
      inputSchema: z.object({}),
      execute: async () => runCheck(await loadQuoteState(opts.quoteId), actor),
    }),
    search_products: tool({
      description: "Search the price book. Query with brand, range, colour, supplier or type words, e.g. 'godfrey hirst andes peak merida' or 'underlay 11mm'.",
      inputSchema: z.object({
        query: z.string(),
        category: z
          .string()
          .optional()
          .describe("Optional. Ranks this category first: carpet, carpet_tile, hybrid, laminate, vinyl, sheet_goods, timber, turf, underlay, accessory."),
      }),
      execute: async ({ query, category }) => {
        const found = await searchProducts(query, actor, category ?? null);
        return found.length ? found : { none: true, hint: "Nothing matched. Try fewer or different words, or drop the category." };
      },
    }),
    search_labour: tool({
      description: "Search the labour rate book: installation, stairs, removal, disposal, prep, levelling, furniture and so on. Empty query lists the first items.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const found = await searchLabour(query, actor);
        return found.length ? found : { none: true, hint: "Nothing matched. Try one plain word like carpet, stairs, removal." };
      },
    }),
    draft_wording: tool({
      description: "Write the client wording for one section of the quote, from its current lines and the notes. Returns the wording to put in propose as set_wording.",
      inputSchema: z.object({
        key: z.string().describe("Section key from the quote."),
        hint: z.string().max(500).optional().describe("Only what the person asked to be mentioned, e.g. 'mention the stairs are open riser'. Never work that is not a line on the quote."),
      }),
      execute: async ({ key, hint }) => {
        const now = await loadQuoteState(opts.quoteId);
        const b = now.bundles.find((x) => x.key === key);
        if (!b) return { error: `No section "${key}". Keys: ${now.bundles.map((x) => x.key).join(", ")}` };
        if (!b.lineIds.length) return { error: "That section has no lines yet." };
        const lines = now.items
          .filter((i) => b.lineIds.includes(i.id))
          .map((i) => ({ kind: i.kind, description: i.description, productCategory: i.productCategory }));
        const wording = await draftBundleWording({
          title: b.title,
          lines,
          notes: now.quote.notes,
          hint: hint ?? null,
          current: hint ? b.wording : null,
        });
        if (!wording) return { error: "The writer came back empty. Try once more." };
        drafted.set(key, wording);
        return { key, wording };
      },
    }),
    propose: tool({
      description:
        "Propose changes to the quote. The person reviews them and taps Apply. Call once per turn with every change. A second call replaces the first.",
      inputSchema: z.object({
        summary: z.string().max(300).describe("One short sentence saying what this does."),
        actions: z.array(actionSchema).min(1).max(30),
      }),
      execute: async ({ summary, actions }) => {
        if (locked) return { error: "The quote is locked. Nothing can be proposed." };
        const now = await loadQuoteState(opts.quoteId);
        const steps: ProposalStep[] = [];
        const errors: string[] = [];
        for (const [i, a] of actions.entries()) {
          try {
            const label = await describeAction(a, now, actor);
            // Wording from the writer wins over anything retyped, and no long dashes either way.
            const fixed: ProposalAction =
              a.type === "set_wording"
                ? { ...a, wording: (drafted.get(a.key) ?? a.wording).replace(/\s*[—–]\s*/g, ", ").trim() }
                : a;
            steps.push({ ...fixed, label });
          } catch (e) {
            errors.push(`Change ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (errors.length) return { error: "Nothing was proposed. Fix these and call propose again.", errors };
        // Wording goes on last, after the lines it describes.
        steps.sort((x, y) => Number(x.type === "set_wording") - Number(y.type === "set_wording"));
        proposal = { summary: summary.replace(/\s*[—–]\s*/g, ", "), actions: steps };
        return { ok: true, proposed: steps.map((s) => s.label) };
      },
    }),
  };

  const result = await generateText({
    model: gateway("openai/gpt-5.4"),
    system: systemPrompt(actor, quoteBrief(state, actor)),
    messages: [...opts.history.slice(-16), { role: "user" as const, content: opts.message }],
    tools,
    stopWhen: stepCountIs(10),
    abortSignal: AbortSignal.timeout(150_000),
  });

  const text = cleanReply(result.text) || (proposal?.summary ?? "Done.");
  return { text, proposal };
}

/** No long dashes in anything the agent says. */
export function cleanReply(s: string) {
  return s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
