import { ORPCError } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import type { Actor } from "../../middleware/auth";

/* ---------------------------------------------------------------------------
 * Warehouse stock, Stage 1 (Step A). Shared rules, switches and permissions.
 *
 * Approved basis: v3 proposal + amendment A1 (2 Nov 2026), plus Damien's
 * four clarifications:
 *   1. Several holds may sit on one roll. Active holds never add up to more
 *      than the usable quantity. "One reservation per piece" means no
 *      duplicate allocation, not one customer per roll.
 *   2. Recovery is worked out from the facts (payments, terms, holds), never
 *      from a saved "Deposit confirmed" flag.
 *   3. A recorded payment is not a stock confirmation. A hand-recorded
 *      payment needs an Admin "Confirm for stock".
 *   4. The live card check (step F) is needed before a card payment firms
 *      stock automatically, for both Sell products (S3) and jobs (S4).
 * ------------------------------------------------------------------------- */

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;
/** Lengths are compared to the centimetre. */
export const cm = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "unit", "ea" and "item" all read "each", so one screen never mixes "6 unit" with "8 each". */
export const unitText = (u: string | null | undefined) => (u === "m2" ? "m²" : u === "lm" ? "m" : u === "unit" || u === "ea" || u === "item" ? "each" : (u ?? ""));
export const qtyText = (n: number, unit: string | null | undefined) => `${r4(n)} ${unitText(unit)}`.trim();
export const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
export const forbid = (message: string) => new ORPCError("FORBIDDEN", { message });
export const notFound = (message = "Not found") => new ORPCError("NOT_FOUND", { message });

/* ------------------------------- hold stages ------------------------------ */

export const HOLD_STAGES = ["planned", "temporary", "awaiting", "reserved", "cut", "picked", "handed_over", "issued", "short", "released", "cancelled"] as const;
export type HoldStage = (typeof HOLD_STAGES)[number];
/** These stop anyone else using the stock. */
export const BLOCKING: HoldStage[] = ["temporary", "reserved", "cut", "picked"];
/** Firm for the customer (counted as "reserved" on the order). */
export const FIRM: HoldStage[] = ["reserved", "cut", "picked", "handed_over", "issued"];
/** Waiting to be made firm by the check. */
export const WAITING: HoldStage[] = ["planned", "temporary", "awaiting"];
/** Stock is allocated for costing and for the PO helper: it will not be ordered. */
export const ALLOCATED: HoldStage[] = ["temporary", "awaiting", "reserved", "cut", "picked", "handed_over", "issued"];
export const ENDED: HoldStage[] = ["released", "cancelled", "short"];

export const STAGE_LABEL: Record<string, string> = {
  planned: "Planned (nothing held)",
  temporary: "Temporary hold",
  awaiting: "Awaiting deposit",
  reserved: "Reserved (firm)",
  cut: "Cut",
  picked: "Picked",
  handed_over: "Handed over",
  issued: "Issued to job",
  short: "Short",
  released: "Released",
  cancelled: "Cancelled",
};

export const CONDITION_LABEL: Record<string, string> = {
  good: "Good",
  damaged: "Damaged",
  quarantined: "Quarantined",
  expired: "Expired",
  opened: "Opened — internal use only",
};

export const COST_UNKNOWN = "Cost unknown — review required";
export const AWAITING_CONFIRM = "Payment recorded — awaiting admin confirmation";

/**
 * The supplier bill for the PO is not the PO amount. The item keeps the PO
 * line rate (freight not included) and is marked for review. Rides on
 * purchaseCostNote, so anything cut, opened or returned from it carries it.
 */
export const BILL_DIFFERS = "Cost provisional, bill differs from PO";
/** Release (Damien 5 Nov): freight or charges on the PO are not spread onto the stock cost,
 *  so stock from that PO stays provisional for the manual cost review, even when the bill agrees. */
export const FREIGHT_REVIEW = "Cost provisional, freight or charges on the PO not in the stock cost";
type Note = string | null | undefined;
const hasFlag = (note: Note, f: string) => (note ?? "").includes(f);
const addFlag = (note: Note, f: string) => (hasFlag(note, f) ? (note ?? "") : [(note ?? "").trim(), `${f}.`].filter(Boolean).join(" "));
const dropFlag = (note: Note, f: string) => (note ?? "").replace(`${f}.`, "").replace(/\s+/g, " ").trim();
export const hasBillFlag = (note: Note) => hasFlag(note, BILL_DIFFERS);
export const addBillFlag = (note: Note) => addFlag(note, BILL_DIFFERS);
export const dropBillFlag = (note: Note) => dropFlag(note, BILL_DIFFERS);
export const hasFreightFlag = (note: Note) => hasFlag(note, FREIGHT_REVIEW);
export const addFreightFlag = (note: Note) => addFlag(note, FREIGHT_REVIEW);
export const dropFreightFlag = (note: Note) => dropFlag(note, FREIGHT_REVIEW);
/** Either review mark. An Admin setting the cost by hand is the review and clears both. */
export const hasCostFlag = (note: Note) => hasBillFlag(note) || hasFreightFlag(note);
export const dropCostFlags = (note: Note) => dropFreightFlag(dropBillFlag(note));
/** A new item made from src: same marks as src, on top of its own note. */
export const inheritBillFlag = (src: { purchaseCostNote: string | null }, note = "") => {
  let out = note;
  if (hasBillFlag(src.purchaseCostNote)) out = addBillFlag(out);
  if (hasFreightFlag(src.purchaseCostNote)) out = addFreightFlag(out);
  return out;
};

/* -------------------------------- settings -------------------------------- */

async function readSetting(key: string) {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key));
  return row?.value ?? null;
}
async function writeSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}
function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

export type StockRules = { carpetKeepMinM: number; vinylFreeMaxM: number; holdHours: number; warnHours: number };
export const DEFAULT_RULES: StockRules = { carpetKeepMinM: 2.7, vinylFreeMaxM: 2, holdHours: 48, warnHours: 4 };
export const RULES_KEY = "stock_rules";
export const stockRules = async () => parse<StockRules>(await readSetting(RULES_KEY), DEFAULT_RULES);
export async function saveStockRules(r: Partial<StockRules>) {
  const next = { ...(await stockRules()), ...r };
  if (!(next.carpetKeepMinM > 0 && next.vinylFreeMaxM >= 0 && next.holdHours >= 1 && next.warnHours >= 0 && next.warnHours < next.holdHours)) {
    throw bad("Check the stock rules: cutoffs over 0, hold at least 1 hour, warning shorter than the hold.");
  }
  await writeSetting(RULES_KEY, JSON.stringify(next));
  return next;
}

/* -------------------------------- switches -------------------------------- */

export const SWITCHES = {
  s1: { label: "S1 Stock register", needs: [] as SwitchKey[] },
  s2: { label: "S2 Deposit safeguards", needs: ["s1"] as SwitchKey[] },
  s3: { label: "S3 Stock-backed sales", needs: ["s1", "s2"] as SwitchKey[] },
  s4: { label: "S4 Installation jobs", needs: ["s1", "s2"] as SwitchKey[] },
  s5: { label: "S5 Returns and leftovers", needs: ["s1"] as SwitchKey[] },
  /** A2. Off by default. Off or paused: nothing new is suggested or sent; warehouse POs and what is owed on them stay visible. */
  s6: { label: "S6 Low-stock alerts and warehouse orders", needs: ["s1"] as SwitchKey[] },
} as const;
export type SwitchKey = "s1" | "s2" | "s3" | "s4" | "s5" | "s6";
export type SwitchState = "off" | "on" | "paused";
/** `since`: when it last went from off to on. Orders accepted before then need "Bring into stock workflow". */
export type SwitchRow = { state: SwitchState; at: string | null; by: string | null; since?: string | null };
const SWITCH_KEY = (k: SwitchKey) => `stock_switch_${k}`;
export const CARD_CHECK_KEY = "stock_card_check";
export type CardCheck = { done: boolean; at: string | null; by: string | null; note: string };

export async function switches(): Promise<Record<SwitchKey, SwitchRow>> {
  const keys = (Object.keys(SWITCHES) as SwitchKey[]).map(SWITCH_KEY);
  const rows = await db.select().from(schema.settings).where(inArray(schema.settings.key, keys));
  const by = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<SwitchKey, SwitchRow>;
  for (const k of Object.keys(SWITCHES) as SwitchKey[]) out[k] = parse<SwitchRow>(by.get(SWITCH_KEY(k)) ?? null, { state: "off", at: null, by: null });
  return out;
}
/** On, not paused. New actions are allowed. */
export const isOn = async (k: SwitchKey) => (await switches())[k].state === "on";
/** On or paused: existing records still count. */
export const isLive = async (k: SwitchKey) => (await switches())[k].state !== "off";

export const cardCheck = async () => parse<CardCheck>(await readSetting(CARD_CHECK_KEY), { done: false, at: null, by: null, note: "" });

/** Step F. Only the main admin, after the live card check. On a test copy the note says so. */
export async function setCardCheck(done: boolean, note: string, actor: Actor) {
  if (!actor.isMainAdmin) throw forbid("Only the main admin can record the live card check.");
  if (!done && ((await switches()).s3.state !== "off")) throw bad("Turn S3 off first. Stock-backed sales need the live card check.");
  const row: CardCheck = { done, at: new Date().toISOString(), by: actor.name, note: note.trim().slice(0, 300) };
  await writeSetting(CARD_CHECK_KEY, JSON.stringify(row));
  return row;
}

export async function setSwitch(k: SwitchKey, state: SwitchState, actor: Actor) {
  if (actor.role !== "admin") throw forbid("Only an Admin can change the stock switches.");
  const all = await switches();
  const def = SWITCHES[k];
  if (state !== "off") {
    const missing = def.needs.filter((n) => all[n].state === "off");
    if (missing.length) throw bad(`${def.label} needs ${missing.map((m) => SWITCHES[m].label).join(" and ")} on first.`);
    if (k === "s3" && !(await cardCheck()).done) throw bad(`${def.label} needs the live card check (step F) recorded first.`);
  }
  if (state === "off") {
    const dependants = (Object.keys(SWITCHES) as SwitchKey[]).filter((d) => d !== k && all[d].state !== "off" && (SWITCHES[d].needs as readonly SwitchKey[]).includes(k));
    if (dependants.length) throw bad(`Turn ${dependants.map((d) => SWITCHES[d].label).join(" and ")} off first.`);
  }
  const at = new Date().toISOString();
  const since = state === "off" ? null : all[k].state === "off" ? at : (all[k].since ?? all[k].at);
  const row: SwitchRow = { state, at, by: actor.name, since };
  await writeSetting(SWITCH_KEY(k), JSON.stringify(row));
  await db.insert(schema.activityLog).values({
    entityType: "settings",
    entityId: 0,
    action: "stock_switch",
    detail: `${def.label} set to ${state}.`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return { ...all, [k]: row };
}

export async function needOn(k: SwitchKey) {
  const s = (await switches())[k];
  if (s.state === "on") return;
  throw bad(s.state === "paused" ? `${SWITCHES[k].label} is paused. Existing holds stay, but nothing new can be done.` : `${SWITCHES[k].label} is off.`);
}

/* ------------------------------- permissions ------------------------------ */

export type StockPerms = {
  handle: boolean;
  allocate: boolean;
  correct: boolean;
  approve: boolean;
  viewCosts: boolean;
  changeCosts: boolean;
  confirm: boolean;
};
export type PermActor = Pick<Actor, "role" | "profileId" | "canSeeCosts" | "isMainAdmin" | "name">;

export async function stockPerms(actor: PermActor): Promise<StockPerms> {
  const [tick] = actor.profileId ? await db.select().from(schema.stockPermissions).where(eq(schema.stockPermissions.profileId, actor.profileId)) : [];
  const admin = actor.role === "admin";
  return {
    handle: admin || !!tick?.handle,
    allocate: admin || (actor.role === "office" && !!tick?.allocate),
    correct: admin,
    approve: admin,
    viewCosts: admin || (actor.role === "office" && actor.canSeeCosts),
    // A separate tick. The main admin has it; nobody else until he grants it, and only to an Admin.
    changeCosts: actor.isMainAdmin || (admin && !!tick?.changeCosts),
    confirm: admin,
  };
}

const PERM_WORDS: Record<keyof StockPerms, string> = {
  handle: "Handle stock",
  allocate: "Allocate and hold",
  correct: "Correct and write off (Admin)",
  approve: "Approve opening stock and returns (Admin)",
  viewCosts: "View stock costs",
  changeCosts: "Change stock costs (Admin, separate tick)",
  confirm: "Confirm for stock (Admin)",
};
export async function need(actor: PermActor, p: keyof StockPerms) {
  const perms = await stockPerms(actor);
  if (!perms[p]) throw forbid(`You need "${PERM_WORDS[p]}" for this.`);
  return perms;
}

export async function setStockPermission(
  profileId: number,
  ticks: { handle?: boolean; allocate?: boolean; changeCosts?: boolean },
  actor: PermActor,
) {
  if (actor.role !== "admin") throw forbid("Only an Admin can change stock permissions.");
  const [p] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, profileId));
  if (!p) throw notFound("Person not found");
  if (ticks.changeCosts !== undefined) {
    if (!actor.isMainAdmin) throw forbid("Only the main admin can grant Change stock costs.");
    if (ticks.changeCosts && p.role !== "admin") throw bad("Change stock costs is for Admin logins only.");
  }
  if (ticks.allocate && p.role === "field") throw bad("Allocate and hold is for Office and Admin logins.");
  const [cur] = await db.select().from(schema.stockPermissions).where(eq(schema.stockPermissions.profileId, profileId));
  const next = { handle: ticks.handle ?? cur?.handle ?? false, allocate: ticks.allocate ?? cur?.allocate ?? false, changeCosts: ticks.changeCosts ?? cur?.changeCosts ?? false };
  if (cur) await db.update(schema.stockPermissions).set({ ...next, grantedByName: actor.name, updatedAt: new Date() }).where(eq(schema.stockPermissions.id, cur.id));
  else await db.insert(schema.stockPermissions).values({ profileId, ...next, grantedByName: actor.name });
  return next;
}

/* ------------------------------ product facts ----------------------------- */

export type ProductKind = "carpet" | "vinyl" | "other";
export function productKind(p: { category: string; soldAs: string | null; unit: string }): ProductKind {
  const c = p.category.toLowerCase();
  if (c === "carpet") return "carpet";
  if (c === "vinyl" && (p.soldAs === "broadloom" || p.unit === "lm")) return "vinyl";
  return "other";
}
