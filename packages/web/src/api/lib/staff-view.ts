import type { Actor } from "../middleware/auth";

/**
 * What Office may not see on an installer card or a task.
 *
 * Office books people and sets per-task pay (Damien, 7 Oct), so `payAmount`
 * and the frozen `labourCost` total stay. Bank details, credit limit and the
 * rate-by-rate labour breakdown are Admin only. installers.list and
 * installers.get already did this inline; every other route that hands back a
 * whole installer row or task row goes through these.
 */

type Who = Pick<Actor, "role">;

const isAdmin = (actor: Who) => actor.role === "admin";

type InstallerPrivate = {
  creditLimit: number;
  bankAccountName: string | null;
  bankBsb: string | null;
  bankAccountNumber: string | null;
};

export function installerForStaff<T extends InstallerPrivate | null | undefined>(row: T, actor: Who): T {
  if (!row || isAdmin(actor)) return row;
  return { ...row, creditLimit: 0, bankAccountName: null, bankBsb: null, bankAccountNumber: null };
}

type TaskPrivate = { labourBreakdown: string | null };

export function taskForStaff<T extends TaskPrivate>(row: T, actor: Who): T {
  if (isAdmin(actor)) return row;
  return { ...row, labourBreakdown: null };
}
