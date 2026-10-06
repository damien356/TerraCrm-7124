import { z } from "zod";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { call, ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly, type Actor } from "../middleware/auth";
import { getObject } from "../lib/s3";
import { transcribeAudio } from "../agent/transcribe";
import {
  cleanReply,
  loadQuoteState,
  LOCKED,
  runCheck,
  runQuoteAgent,
  type ChatTurn,
  type Proposal,
  type ProposalStep,
} from "../agent/quote-agent";
import { quotes } from "./quotes";
import { bundlesFor, saveBundle } from "./quoteBundles";

/**
 * The quote agent in the builder. Admin and Office (staffOnly). It talks,
 * checks and proposes. Only `apply` changes the quote, and it does so through
 * the same procedures the builder uses, so the discount limit, the cost rules
 * and quote locking all still apply to whoever tapped Apply.
 *
 * Long turns: the AI can take 20 seconds or more with a few tool calls, and
 * the published server hangs up on a request that is silent for 10. So
 * `start` answers at once and `status` is polled, the same as voice quotes.
 * Every outcome, including a failure, ends as an assistant row in the
 * database, so a restart mid-turn reads as "stopped", never as a hang.
 *
 * Cost: an Admin's conversation can mention cost and markup, so Office never
 * sees an Admin's messages here, and they never go into an Office turn.
 */

/** Quote id -> the user message being answered. One turn at a time per quote. */
const running = new Map<number, { userMessageId: number; startedAt: number }>();
const TURN_LIMIT_MS = 4 * 60_000;

type MessageRow = typeof schema.quoteAgentMessages.$inferSelect;

function parseProposal(raw: string | null): Proposal | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Proposal;
  } catch {
    return null;
  }
}

/** Which askers' messages this person may see. Office sees non-Admin conversations only. */
async function visibleRows(quoteId: number, actor: Actor) {
  const rows = await db
    .select()
    .from(schema.quoteAgentMessages)
    .where(eq(schema.quoteAgentMessages.quoteId, quoteId))
    .orderBy(asc(schema.quoteAgentMessages.id));
  if (actor.role === "admin") return { rows, hidden: 0 };
  const askers = [...new Set(rows.map((r) => r.userId).filter((u): u is string => !!u))];
  const admins = askers.length
    ? new Set(
        (
          await db
            .select({ userId: schema.profiles.userId })
            .from(schema.profiles)
            .where(and(inArray(schema.profiles.userId, askers), eq(schema.profiles.role, "admin")))
        ).map((p) => p.userId),
      )
    : new Set<string>();
  const shown = rows.filter((r) => !r.userId || !admins.has(r.userId));
  return { rows: shown, hidden: rows.length - shown.length };
}

function view(r: MessageRow, actor: Actor) {
  return {
    id: r.id,
    mine: r.userId === actor.userId,
    role: r.role as "user" | "assistant",
    userName: r.userName,
    content: r.content,
    proposal: parseProposal(r.proposal),
    appliedAt: r.appliedAt,
    createdAt: r.createdAt,
  };
}

/** Recent turns for the model, with what was proposed and whether it went on. */
function toTurns(rows: MessageRow[]): ChatTurn[] {
  return rows
    .filter((r) => r.content.trim() || r.proposal)
    .slice(-16)
    .map((r) => {
      const p = parseProposal(r.proposal);
      // Per change, so a skipped or failed one is never taken as on the quote.
      const said = (s: ProposalStep) =>
        !r.appliedAt ? "not applied" : s.status === "applied" ? "applied" : s.status === "failed" ? `failed: ${s.error ?? ""}` : "skipped by the user";
      const note = p ? `\n[Proposed: ${p.actions.map((a) => `${a.label} (${said(a)})`).join("; ")}]` : "";
      return { role: r.role === "assistant" ? "assistant" : "user", content: `${r.content}${note}` };
    });
}

async function quoteOrThrow(quoteId: number) {
  const [q] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!q) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  return q;
}

async function reply(quoteId: number, asker: Actor, content: string, proposal: Proposal | null) {
  const [row] = await db
    .insert(schema.quoteAgentMessages)
    .values({
      quoteId,
      userId: asker.userId,
      userName: asker.name,
      role: "assistant",
      content,
      proposal: proposal ? JSON.stringify(proposal) : null,
    })
    .returning();
  return row!;
}

async function runTurn(quoteId: number, userMessageId: number, actor: Actor, text: string, audioKey: string | null) {
  try {
    let message = text.trim();
    if (audioKey) {
      const heard = (await transcribeAudio(new Uint8Array(await getObject(audioKey)))).trim();
      message = [message, heard].filter(Boolean).join("\n");
      await db
        .update(schema.quoteAgentMessages)
        .set({ content: message || "(nothing heard)" })
        .where(eq(schema.quoteAgentMessages.id, userMessageId));
      if (!heard) {
        await reply(quoteId, actor, "I could not hear anything in that recording. Try again a little closer to the mic.", null);
        return;
      }
    }
    const { rows } = await visibleRows(quoteId, actor);
    const history = toTurns(rows.filter((r) => r.id < userMessageId));
    const out = await runQuoteAgent({ quoteId, actor, history, message });
    await reply(quoteId, actor, out.text, out.proposal);
  } catch (e) {
    console.error(`[quote-agent] quote ${quoteId} turn ${userMessageId} failed:`, e);
    await reply(quoteId, actor, "Sorry, that did not work just now. Ask me again.", null).catch(() => undefined);
  } finally {
    if (running.get(quoteId)?.userMessageId === userMessageId) running.delete(quoteId);
  }
}

function busy(quoteId: number) {
  const r = running.get(quoteId);
  if (r && Date.now() - r.startedAt > TURN_LIMIT_MS) {
    running.delete(quoteId);
    return null;
  }
  return r ?? null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const quoteAgent = {
  /** The conversation on this quote that this person may see. */
  history: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input, context }) => {
    await quoteOrThrow(input.quoteId);
    const { rows, hidden } = await visibleRows(input.quoteId, context.actor);
    const r = busy(input.quoteId);
    return {
      messages: rows.map((r) => view(r, context.actor)),
      hiddenCount: hidden,
      runningFor: r ? r.userMessageId : null,
    };
  }),

  /** The pre-send check on its own. No AI, instant. */
  check: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input, context }) => {
    await quoteOrThrow(input.quoteId);
    return runCheck(await loadQuoteState(input.quoteId), context.actor);
  }),

  /** Say something to the agent, typed or recorded. Answers straight away; poll `status`. */
  start: staffOnly
    .input(
      z
        .object({
          quoteId: z.number(),
          message: z.string().max(4000).default(""),
          // Only recordings made through the voice upload, never any other stored file.
          audioKey: z
            .string()
            .regex(/^voice-quotes\/[\w.-]+$/, "That recording was not found.")
            .nullable()
            .optional(),
        })
        .refine((v) => v.message.trim() || v.audioKey, { message: "Say or type something first." }),
    )
    .handler(async ({ input, context }) => {
      await quoteOrThrow(input.quoteId);
      if (busy(input.quoteId)) {
        throw new ORPCError("CONFLICT", { message: "Still working on the last question on this quote. Give it a moment." });
      }
      const [row] = await db
        .insert(schema.quoteAgentMessages)
        .values({
          quoteId: input.quoteId,
          userId: context.actor.userId,
          userName: context.actor.name,
          role: "user",
          content: input.message.trim(),
        })
        .returning();
      if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not save the message" });
      running.set(input.quoteId, { userMessageId: row.id, startedAt: Date.now() });
      void runTurn(input.quoteId, row.id, context.actor, input.message, input.audioKey ?? null);
      return { userMessageId: row.id };
    }),

  /** Where a turn has got to. Done once an answer exists after the question. */
  status: staffOnly
    .input(z.object({ quoteId: z.number(), userMessageId: z.number() }))
    .handler(async ({ input, context }) => {
      const [answer] = await db
        .select()
        .from(schema.quoteAgentMessages)
        .where(
          and(
            eq(schema.quoteAgentMessages.quoteId, input.quoteId),
            eq(schema.quoteAgentMessages.role, "assistant"),
            gt(schema.quoteAgentMessages.id, input.userMessageId),
            eq(schema.quoteAgentMessages.userId, context.actor.userId),
          ),
        )
        .orderBy(asc(schema.quoteAgentMessages.id))
        .limit(1);
      if (answer) return { status: "done" as const, answer: view(answer, context.actor) };
      const r = busy(input.quoteId);
      if (r && r.userMessageId === input.userMessageId) return { status: "working" as const, answer: null };
      return { status: "stopped" as const, answer: null };
    }),

  /**
   * Put a proposal on the quote. Each change goes through the builder's own
   * procedure as the person who tapped Apply. Changes that fail are reported
   * and the rest still go on. `skip` leaves out the ones they unticked.
   */
  apply: staffOnly
    .input(z.object({ messageId: z.number(), skip: z.array(z.number().int()).default([]) }))
    .handler(async ({ input, context }) => {
      const [msg] = await db.select().from(schema.quoteAgentMessages).where(eq(schema.quoteAgentMessages.id, input.messageId));
      const proposal = msg?.role === "assistant" ? parseProposal(msg.proposal) : null;
      if (!msg || !proposal) throw new ORPCError("NOT_FOUND", { message: "Nothing to apply" });
      if (msg.appliedAt) throw new ORPCError("BAD_REQUEST", { message: "These changes are already on the quote." });
      // Office cannot apply what an Admin's conversation proposed.
      const { rows } = await visibleRows(msg.quoteId, context.actor);
      if (!rows.some((r) => r.id === msg.id)) throw new ORPCError("NOT_FOUND", { message: "Nothing to apply" });
      const quote = await quoteOrThrow(msg.quoteId);
      if (LOCKED.includes(quote.status)) {
        throw new ORPCError("BAD_REQUEST", { message: "This quote is locked. Make a new version to change it." });
      }

      const ctx = { context: { headers: context.headers } };
      const lineIds = new Set(
        (await db.select({ id: schema.quoteItems.id }).from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id))).map(
          (r) => r.id,
        ),
      );
      const onQuote = (id: number) => {
        if (!lineIds.has(id)) throw new Error("That line is no longer on the quote.");
      };

      const steps: ProposalStep[] = [];
      for (const [i, a] of proposal.actions.entries()) {
        if (input.skip.includes(i)) {
          steps.push({ ...a, status: "skipped", error: undefined });
          continue;
        }
        try {
          switch (a.type) {
            case "add_product":
              await call(quotes.addProduct, { quoteId: quote.id, productId: a.productId, qty: a.qty }, ctx);
              break;
            case "add_labour":
              await call(
                quotes.addLabour,
                { quoteId: quote.id, itemId: a.itemId, qty: a.qty, installerId: null, description: a.description },
                ctx,
              );
              break;
            case "add_custom":
              await call(
                quotes.addItem,
                { quoteId: quote.id, kind: a.kind, description: a.description, qty: a.qty, unit: a.unit, unitPrice: a.unitPrice },
                ctx,
              );
              break;
            case "update_line":
              onQuote(a.itemId);
              await call(quotes.updateItem, { id: a.itemId, qty: a.qty, unitPrice: a.unitPrice, description: a.description }, ctx);
              break;
            case "remove_line":
              onQuote(a.itemId);
              await call(quotes.removeItem, { id: a.itemId }, ctx);
              lineIds.delete(a.itemId);
              break;
            case "set_wording": {
              const { bundles } = await bundlesFor(await quoteOrThrow(quote.id));
              const b = bundles.find((x) => x.key === a.key);
              if (!b) throw new Error("That section is no longer on the quote.");
              await saveBundle(quote.id, b.key, {
                wording: a.wording.replace(/\s*[—–]\s*/g, ", ").trim(),
                wordingSource: "ai",
                lineSignature: b.signature,
              });
              break;
            }
          }
          steps.push({ ...a, status: "applied", error: undefined });
        } catch (e) {
          steps.push({ ...a, status: "failed", error: errText(e) });
        }
      }

      const applied = steps.filter((s) => s.status === "applied").length;
      const next: Proposal = { ...proposal, actions: steps };
      await db
        .update(schema.quoteAgentMessages)
        .set({ proposal: JSON.stringify(next), appliedAt: new Date() })
        .where(eq(schema.quoteAgentMessages.id, msg.id));
      if (applied) {
        await db.insert(schema.activityLog).values({
          jobId: quote.jobId,
          contactId: quote.contactId,
          entityType: "quote",
          entityId: quote.id,
          action: "agent_applied",
          // What actually went on, not the model's summary, which may name skipped changes.
          detail: cleanReply(
            `Quote assistant applied: ${steps
              .filter((x) => x.status === "applied")
              .map((x) => x.label)
              .join("; ")}`,
          ).slice(0, 1000),
          actorName: context.actor.name,
          actorRole: context.actor.role,
        });
      }
      return { applied, failed: steps.filter((s) => s.status === "failed").length, proposal: next };
    }),

  /** Start the conversation on this quote over. Only your own messages go. */
  clear: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input, context }) => {
    if (busy(input.quoteId)) throw new ORPCError("CONFLICT", { message: "Wait for the answer first." });
    const mine = await db
      .select({ id: schema.quoteAgentMessages.id })
      .from(schema.quoteAgentMessages)
      .where(and(eq(schema.quoteAgentMessages.quoteId, input.quoteId), eq(schema.quoteAgentMessages.userId, context.actor.userId)))
      .orderBy(desc(schema.quoteAgentMessages.id));
    if (mine.length) {
      await db.delete(schema.quoteAgentMessages).where(
        inArray(
          schema.quoteAgentMessages.id,
          mine.map((m) => m.id),
        ),
      );
    }
    return { removed: mine.length };
  }),
};
