import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { lookupAbn } from "../lib/abn-lookup";
import { abnView, checkInstallerAbn, gstOnToday, namesMatch } from "../lib/abn-check";

/**
 * The ABN check on installer cards (notes 18.64). Admin only, all of it.
 * Office and installers never see the tick, the warning or the register's
 * answer. Saving a new ABN on the card runs the lookup in installers.update;
 * these are the preview while typing, a check by hand, and the chase list.
 */
export const abnCheck = {
  /** What the register says for an ABN being typed. Saves nothing. */
  lookup: adminOnly
    .input(z.object({ abn: z.string().min(1).max(40), name: z.string().default(""), fullName: z.string().nullable().default(null), tradingName: z.string().nullable().default(null) }))
    .handler(async ({ input }) => {
      const r = await lookupAbn(input.abn);
      if (r.kind !== "found") return { kind: r.kind, message: r.message, found: null };
      const gstRegistered = gstOnToday(r.status, r.gstFrom, r.gstTo);
      const match = namesMatch({ name: input.name, fullName: input.fullName, tradingName: input.tradingName }, r);
      return {
        kind: r.kind,
        message: null,
        found: {
          abn: r.abn,
          status: r.status,
          statusFrom: r.statusFrom,
          entityType: r.entityType,
          legalName: r.legalName,
          businessNames: r.businessNames,
          gstRegistered,
          gstFrom: r.gstFrom,
          gstTo: r.gstTo,
          state: r.state,
          postcode: r.postcode,
          mismatch: match === false,
        },
      };
    }),

  /** Look his saved ABN up again now and save the answer. */
  check: adminOnly.input(z.object({ installerId: z.number() })).handler(async ({ input }) => {
    const out = await checkInstallerAbn(input.installerId);
    if (!out) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
    return out.view;
  }),

  /** Every current installer whose ABN is missing or doesn't pass. */
  chaseList: adminOnly.handler(async () => {
    const rows = await db
      .select()
      .from(schema.installers)
      .where(and(eq(schema.installers.active, true), isNull(schema.installers.archivedAt)))
      .orderBy(asc(schema.installers.name));
    const views = rows.map((i) => ({ id: i.id, name: i.name, mobile: i.mobile, ...abnView(i) }));
    return { total: rows.length, passing: views.filter((v) => v.passes).length, chase: views.filter((v) => !v.passes) };
  }),
};
