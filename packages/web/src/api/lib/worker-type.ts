import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * Worker type (Damien, 2 Nov). Separate from the login level, booking
 * availability and skills.
 *
 * employee: no ABN, GST, business name or contractor invoice number needed.
 *   Never raises a contractor invoice or bill. Scheduling, skills, time and
 *   internal labour costing all still work. Payroll is not handled in Ops.
 * subcontractor: invoices Terra on an ABN, as before.
 * null: nobody has said yet. Listed on the People page for review. Never
 *   guessed from whether there is an ABN.
 */
export const WORKER_TYPES = ["employee", "subcontractor"] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

export const isEmployee = (card: { workerType: string | null } | null | undefined) => card?.workerType === "employee";

/** What an employee sees if they try to invoice. Neutral, no blame. */
export const EMPLOYEE_NO_INVOICE = "You're set up as a Terra employee, so there's no contractor invoice for this work.";

/**
 * The login that owns this card: a Field login on its crew card, or an Office
 * or Admin login on its staff card. Null when the card has no login.
 */
export async function cardOwner(installerId: number) {
  const [crew] = await db
    .select({ id: schema.profiles.id, isMainAdmin: schema.profiles.isMainAdmin })
    .from(schema.profiles)
    .where(eq(schema.profiles.installerId, installerId));
  if (crew) return { profileId: crew.id, isMainAdmin: crew.isMainAdmin, staffCard: false };
  const [staff] = await db
    .select({ id: schema.profiles.id, isMainAdmin: schema.profiles.isMainAdmin })
    .from(schema.staffCards)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.staffCards.profileId))
    .where(eq(schema.staffCards.installerId, installerId));
  if (staff) return { profileId: staff.id, isMainAdmin: staff.isMainAdmin, staffCard: true };
  return null;
}
