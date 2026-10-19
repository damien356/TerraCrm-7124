import { and, eq, like } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { localDate } from "./local-date";
import { abnDigits, formatAbn, lookupAbn, type AbnResult } from "./abn-lookup";

/* ---------------------------------------------------------------------------
 * The ABN check on an installer card (notes 18.64). Admin only.
 *
 * - The lookup fills the card: legal name, business and trading names,
 *   Active or Cancelled, GST from and to, state and postcode.
 * - GST on his pay comes from the lookup only. Registered today means GST is
 *   added; anything else means none.
 * - It passes when the ABN is Active and his own name or the trading name on
 *   his card matches the legal name or a business name on the ABN, ignoring
 *   Pty Ltd, Ltd, capitals and punctuation. He can't invoice from his phone
 *   until it passes.
 * - Bills, pay and Xero carry the legal name, plus "t/a" his business name.
 *   His own name stays on Schedule, Crew, the phone and texts.
 * ------------------------------------------------------------------------- */

type Installer = typeof schema.installers.$inferSelect;

/** Lower case, no punctuation, no Pty, Ltd, Limited or Proprietary. */
export function normName(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["pty", "ltd", "limited", "proprietary"].includes(w))
    .join(" ");
}

export function abnNames(i: Pick<Installer, "abnBusinessNames">): string[] {
  try {
    const v = JSON.parse(i.abnBusinessNames ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Is GST on today, by the register's dates. */
export function gstOnToday(status: string | null, gstFrom: string | null, gstTo: string | null, today = localDate()) {
  if (status !== "Active" || !gstFrom) return false;
  if (gstFrom > today) return false;
  return !gstTo || gstTo >= today;
}

/** Does the card's name match the ABN. Null when there is nothing to compare yet. */
export function namesMatch(
  card: { name: string; tradingName: string | null },
  abr: { legalName: string | null; entityType?: string | null; businessNames: string[] },
) {
  if (!abr.legalName) return null;
  const theirs = new Set([abr.legalName, ...abr.businessNames].map(normName).filter(Boolean));
  // A sole trader's middle names are left out of the compare.
  const parts = normName(abr.legalName).split(" ");
  if (/individual|sole trader/i.test(abr.entityType ?? "") && parts.length > 2) theirs.add(`${parts[0]} ${parts[parts.length - 1]}`);
  const ours = [card.name, card.tradingName].map(normName).filter(Boolean);
  return ours.some((n) => theirs.has(n));
}

export type AbnState = "missing" | "unchecked" | "active" | "cancelled" | "not_found" | "invalid" | "error";

export type AbnCheckView = {
  abn: string | null;
  state: AbnState;
  /** Green tick. */
  passes: boolean;
  /** Red warning, and why. Null when it passes or there is nothing to say yet. */
  warning: string | null;
  mismatch: boolean;
  legalName: string | null;
  businessNames: string[];
  status: string | null;
  statusFrom: string | null;
  entityType: string | null;
  gstRegistered: boolean;
  gstFrom: string | null;
  gstTo: string | null;
  regState: string | null;
  postcode: string | null;
  checkedAt: Date | null;
  checkError: string | null;
  /** What goes on his bills: legal name, plus t/a his business name. */
  billName: string;
  businessName: string | null;
};

/** The business name that goes after "t/a": his card's trading name, else the first on the ABN. */
export function businessNameFor(i: Pick<Installer, "tradingName" | "abnLegalName" | "abnBusinessNames">) {
  const legal = normName(i.abnLegalName);
  const card = (i.tradingName ?? "").trim();
  if (card && normName(card) !== legal) return card;
  if (card) return null;
  const fromAbn = abnNames(i).find((n) => normName(n) !== legal);
  return fromAbn ?? null;
}

export function billNameFor(i: Pick<Installer, "name" | "tradingName" | "abnLegalName" | "abnBusinessNames">) {
  if (!i.abnLegalName) return (i.tradingName ?? "").trim() || i.name;
  const t = businessNameFor(i);
  return t ? `${i.abnLegalName} t/a ${t}` : i.abnLegalName;
}

export function abnView(i: Installer): AbnCheckView {
  const names = abnNames(i);
  const hasAbn = abnDigits(i.abn).length > 0;
  const match = namesMatch({ name: i.name, tradingName: i.tradingName }, { legalName: i.abnLegalName, entityType: i.abnEntityType, businessNames: names });
  const mismatch = match === false;
  let state: AbnState;
  if (!hasAbn) state = "missing";
  else if (i.abnStatus === "Active") state = "active";
  else if (i.abnStatus === "Cancelled") state = "cancelled";
  else if (i.abnStatus === "not_found") state = "not_found";
  else if (i.abnStatus === "invalid") state = "invalid";
  else if (i.abnCheckError) state = "error";
  else state = "unchecked";

  const passes = state === "active" && !mismatch;
  const warning =
    state === "missing"
      ? "No ABN on his card."
      : state === "unchecked"
        ? "Not checked yet."
        : state === "error"
          ? `Could not check: ${i.abnCheckError}`
          : state === "cancelled"
            ? `ABN cancelled${i.abnStatusFrom ? ` from ${i.abnStatusFrom}` : ""}.`
            : state === "not_found"
              ? "ABN not found on the register."
              : state === "invalid"
                ? "Not a valid ABN."
                : mismatch
                  ? "Name does not match the ABN. Neither his name nor his trading name matches the legal name or a business name."
                  : null;

  return {
    abn: i.abn,
    state,
    passes,
    warning,
    mismatch,
    legalName: i.abnLegalName,
    businessNames: names,
    status: i.abnStatus,
    statusFrom: i.abnStatusFrom,
    entityType: i.abnEntityType,
    gstRegistered: i.gstRegistered,
    gstFrom: i.abnGstFrom,
    gstTo: i.abnGstTo,
    regState: i.abnState,
    postcode: i.abnPostcode,
    checkedAt: i.abnCheckedAt,
    checkError: i.abnCheckError,
    billName: billNameFor(i),
    businessName: i.abnLegalName ? businessNameFor(i) : (i.tradingName ?? "").trim() || null,
  };
}

/** Every lookup column cleared, as when the ABN changes or is removed. */
export const CLEARED = {
  abnLegalName: null,
  abnBusinessNames: null,
  abnStatus: null,
  abnStatusFrom: null,
  abnEntityType: null,
  abnGstFrom: null,
  abnGstTo: null,
  abnState: null,
  abnPostcode: null,
  abnCheckedAt: null,
  abnCheckError: null,
} as const;

/** The columns a lookup result writes. A failed call only stamps the error. */
export function columnsFor(result: AbnResult, now = new Date()) {
  if (result.kind === "error") return { abnCheckedAt: now, abnCheckError: result.message.slice(0, 300) };
  if (result.kind !== "found") {
    return { ...CLEARED, abnStatus: result.kind, abnCheckedAt: now, gstRegistered: false };
  }
  return {
    abnLegalName: result.legalName || null,
    abnBusinessNames: JSON.stringify(result.businessNames),
    abnStatus: result.status || null,
    abnStatusFrom: result.statusFrom,
    abnEntityType: result.entityType,
    abnGstFrom: result.gstFrom,
    abnGstTo: result.gstTo,
    abnState: result.state,
    abnPostcode: result.postcode,
    abnCheckedAt: now,
    abnCheckError: null,
    gstRegistered: gstOnToday(result.status, result.gstFrom, result.gstTo, localDate(now)),
  };
}

/** What changed between two checks, in plain words. Empty when nothing worth a task. */
export function changesBetween(before: AbnCheckView, after: AbnCheckView) {
  const out: string[] = [];
  const firstCheck = before.status == null;
  if (after.state !== before.state && ["cancelled", "not_found", "invalid"].includes(after.state)) {
    out.push(after.state === "cancelled" ? "ABN cancelled" : after.state === "not_found" ? "ABN not found" : "ABN not valid");
  } else if (!firstCheck && after.state === "active" && ["cancelled", "not_found", "invalid"].includes(before.state)) {
    out.push("ABN active again");
  }
  if (after.state !== "error" && after.gstRegistered !== before.gstRegistered) {
    out.push(after.gstRegistered ? "GST registration started" : "GST registration stopped");
  }
  if (after.mismatch && !before.mismatch) out.push("name does not match the ABN");
  return out;
}

const TASK_PREFIX = "ABN check:";

/** One Admin only task per change, never a second open one with the same title. */
async function raiseTask(i: Installer, changes: string[], after: AbnCheckView) {
  const title = `${TASK_PREFIX} ${i.name}, ${changes.join(", ")}`;
  const [open] = await db
    .select({ id: schema.officeTasks.id })
    .from(schema.officeTasks)
    .where(and(eq(schema.officeTasks.status, "open"), eq(schema.officeTasks.adminOnly, true), eq(schema.officeTasks.title, title)));
  if (open) return null;
  const gst = after.gstRegistered ? `GST registered from ${after.gstFrom}.` : "Not GST registered, so no GST on his pay.";
  const detail =
    `The monthly ABN check on ${i.name}'s card (ABN ${after.abn ?? "none"}) found: ${changes.join(", ")}. ` +
    `Register says: ${after.legalName ?? "no legal name"}, ${after.status ?? "no status"}. ${gst} ` +
    (after.passes ? "His card passes, he can still invoice." : "He can't invoice from his phone until his ABN passes.") +
    " Open People, ABN checks.";
  const [row] = await db
    .insert(schema.officeTasks)
    .values({ title, detail, createdByName: "ABN check", adminOnly: true })
    .returning({ id: schema.officeTasks.id });
  return row?.id ?? null;
}

/** Open Admin only ABN tasks, for the 7am line. */
export async function openAbnTasks() {
  return db
    .select({ id: schema.officeTasks.id, title: schema.officeTasks.title })
    .from(schema.officeTasks)
    .where(and(eq(schema.officeTasks.status, "open"), eq(schema.officeTasks.adminOnly, true), like(schema.officeTasks.title, `${TASK_PREFIX}%`)));
}

/**
 * Look his ABN up and save the answer on his card. `monthly` raises a task
 * when something changed; a check run by hand doesn't, the Admin is looking.
 */
export async function checkInstallerAbn(installerId: number, opts: { monthly?: boolean; now?: Date } = {}) {
  const [i] = await db.select().from(schema.installers).where(eq(schema.installers.id, installerId));
  if (!i) return null;
  const before = abnView(i);
  if (!abnDigits(i.abn)) return { view: before, changes: [] as string[], taskId: null };
  const result = await lookupAbn(i.abn!);
  const now = opts.now ?? new Date();
  const [saved] = await db
    .update(schema.installers)
    .set({ ...columnsFor(result, now), updatedAt: now })
    .where(eq(schema.installers.id, installerId))
    .returning();
  const after = abnView(saved ?? i);
  const changes = changesBetween(before, after);
  const taskId = opts.monthly && changes.length ? await raiseTask(saved ?? i, changes, after) : null;
  return { view: after, changes, taskId };
}

/** For a fresh ABN typed onto the card: the stored form of it, and every lookup column cleared. */
export function abnChangeColumns(abn: string | null | undefined) {
  const formatted = formatAbn(abn);
  return { abn: formatted, ...CLEARED, ...(formatted ? {} : { gstRegistered: false }) };
}

/** Strip the check from a row for anyone but an Admin. */
export function hideAbnCheck<T extends Installer>(row: T): T {
  return { ...row, ...CLEARED };
}
