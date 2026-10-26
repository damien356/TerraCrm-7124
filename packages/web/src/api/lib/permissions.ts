/**
 * One table that decides who may do each booking and measure action
 * (measure booking stage 0).
 *
 * Sign in still has three roles: admin, office, field. A profile can carry
 * extra duties on top: estimator and supervisor. Together they give five
 * permission roles: admin, office, estimator, supervisor, installer.
 *
 * Rules that hold for every row:
 * - A field login only ever gets actions marked `field: true`, whatever
 *   duties it carries. Office screens, costs and settings stay office only.
 * - Cost actions also need cost access: always for admin, office only when an
 *   admin switched it on, never for field.
 * - A builder's site supervisor is a contact with no login, so there is no
 *   actor and every check is false.
 *
 * Pure: no database, so the role matrix is tested directly.
 */

export type LoginRole = "admin" | "office" | "field";
export type PermRole = "admin" | "office" | "estimator" | "supervisor" | "installer";
export const DUTIES = ["estimator", "supervisor"] as const;
export type Duty = (typeof DUTIES)[number];

export interface PermActor {
  role: LoginRole;
  duties?: readonly string[] | null;
  canSeeCosts?: boolean;
}

interface Rule {
  roles: readonly PermRole[];
  /** A field login may hold this. Off unless set. */
  field?: boolean;
  /** Needs cost access as well as the role. */
  costs?: boolean;
  /** What it is for, shown in the matrix test output. */
  note: string;
}

export const PERMISSIONS = {
  "task.book": { roles: ["admin", "office"], note: "Book a dispatch onto someone (Book Installer, voice memo, command box)" },
  "task.bookOverClash": { roles: ["admin", "office"], note: "Book over a clash or a day off, with a reason" },
  "measure.book": { roles: ["admin", "office", "supervisor"], note: "Book, reschedule or cancel a measure" },
  "measure.reassign": { roles: ["admin", "office", "supervisor"], note: "Change the measurer or the quote owner" },
  "measure.capture": { roles: ["admin", "estimator", "installer"], field: true, note: "Enter measurements, notes, photos, voice on an own measure" },
  "quote.own": { roles: ["admin", "office", "estimator"], note: "Be named as the quote owner" },
  "quote.changeDueDate": { roles: ["admin", "office", "supervisor"], note: "Move a quote due date, with a reason" },
  "handover.authoriseException": { roles: ["admin", "supervisor"], note: "Let a handover through with missing items, with a reason" },
  "queue.viewOffice": { roles: ["admin", "office", "supervisor"], note: "See the office queue: missing info, overdue quotes" },
  "measureFee.set": { roles: ["admin", "office"], costs: true, note: "Set the measure fee default or a per job override" },
  "measureFee.chooseCredit": { roles: ["admin", "office"], costs: true, note: "Credit the fee on the deposit, the final invoice, or not at all" },
  "costs.view": { roles: ["admin", "office"], costs: true, note: "See labour, travel and measure costs" },
  "audit.view": { roles: ["admin"], note: "Read the before and after audit trail" },
  "settings.bookingSafety": { roles: ["admin"], note: "Switch the booking safety checks on or off" },
} as const satisfies Record<string, Rule>;

export type Action = keyof typeof PERMISSIONS;
export const ACTIONS = Object.keys(PERMISSIONS) as Action[];

/** "estimator, supervisor" or ["estimator"] in, the known duties out. Unknown words are dropped. */
export function parseDuties(raw: string | readonly string[] | null | undefined): Duty[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const out = new Set<Duty>();
  for (const w of list) {
    const d = String(w).trim().toLowerCase();
    if ((DUTIES as readonly string[]).includes(d)) out.add(d as Duty);
  }
  return [...out];
}

/** The permission roles one login holds. */
export function rolesOf(actor: PermActor): Set<PermRole> {
  const out = new Set<PermRole>();
  if (actor.role === "admin") out.add("admin");
  else if (actor.role === "office") out.add("office");
  else out.add("installer");
  if (actor.role !== "admin") for (const d of parseDuties(actor.duties)) out.add(d);
  return out;
}

export function can(actor: PermActor | null | undefined, action: Action): boolean {
  if (!actor) return false;
  const rule: Rule = PERMISSIONS[action];
  if (!rule) return false;
  if (actor.role === "field" && !rule.field) return false;
  if (rule.costs && !(actor.role === "admin" || (actor.role === "office" && actor.canSeeCosts === true))) return false;
  const held = rolesOf(actor);
  return rule.roles.some((r) => held.has(r));
}
