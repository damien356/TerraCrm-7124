import { z } from "zod";
import { asc, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { UNDERLAY_CATEGORIES, underlayName } from "../lib/order-sizes";
import { parsePairs, UNDERLAY_UPGRADES_KEY } from "../lib/underlay-pairs";
import { priceOffer, upgradePairs } from "../lib/underlay-upgrade";
import { bad, round2 } from "../lib/variations";

/* ---------------------------------------------------------------------------
 * Settings, Business rules: which underlay upgrades to which (fix list 11
 * Oct, item 9). Admin only, like the other money settings. The pairs feed
 * the upgrade offer on the material selection form (lib/underlay-upgrade.ts).
 * ------------------------------------------------------------------------- */

type Product = typeof schema.products.$inferSelect;

/** What the card shows for a pair: the extra per unit inc GST, or why it is not offered. */
function checkOf(from: Product | undefined, to: Product | undefined) {
  if (!from || !to) return { ok: false as const, reason: "One of these underlays is no longer in the Price list." };
  if (!to.active) return { ok: false as const, reason: `${underlayName(to)} is switched off in the Price list, so it is not offered.` };
  // Priced on 10 units, so a roll width change shows up the way the form works it out.
  const o = priceOffer(from, to, 10, from.unit);
  if (!o.ok) return { ok: false as const, reason: o.reason };
  return { ok: true as const, perUnitIncGst: round2((o.extraExGst / 10) * 1.1), unit: from.unit };
}

export const underlayUpgrades = {
  get: adminOnly.handler(async () => {
    const underlays = await db
      .select()
      .from(schema.products)
      .where(inArray(schema.products.category, [...UNDERLAY_CATEGORIES]))
      .orderBy(asc(schema.products.supplier), asc(schema.products.range), asc(schema.products.colour));
    const byId = new Map(underlays.map((p) => [p.id, p]));
    const pairs = await upgradePairs();
    return {
      pairs: pairs.map((p) => ({
        from: p.from,
        to: p.to,
        fromName: byId.get(p.from) ? underlayName(byId.get(p.from)!) : `Product ${p.from}`,
        toName: byId.get(p.to) ? underlayName(byId.get(p.to)!) : `Product ${p.to}`,
        check: checkOf(byId.get(p.from), byId.get(p.to)),
      })),
      underlays: underlays
        .filter((p) => p.active || pairs.some((x) => x.from === p.id || x.to === p.id))
        .map((p) => ({
          id: p.id,
          name: underlayName(p),
          supplier: p.supplier,
          category: p.category,
          unit: p.unit,
          widthM: p.widthM,
          sellPrice: p.sellPrice,
        })),
    };
  }),

  save: adminOnly
    .input(z.object({ pairs: z.array(z.object({ from: z.number().int().positive(), to: z.number().int().positive() })).max(200) }))
    .handler(async ({ input }) => {
      const want = [...new Set(input.pairs.flatMap((p) => [p.from, p.to]))];
      const found = want.length
        ? await db.select({ id: schema.products.id, category: schema.products.category }).from(schema.products).where(inArray(schema.products.id, want))
        : [];
      const ok = new Set(found.filter((p) => (UNDERLAY_CATEGORIES as readonly string[]).includes(p.category)).map((p) => p.id));
      const seen = new Set<number>();
      for (const p of input.pairs) {
        if (!ok.has(p.from) || !ok.has(p.to)) throw bad("Both sides of an upgrade must be an underlay in the Price list.");
        if (p.from === p.to) throw bad("An underlay cannot upgrade to itself.");
        if (seen.has(p.from)) throw bad("Each underlay can have one upgrade. Remove the extra one.");
        seen.add(p.from);
      }
      const value = JSON.stringify(parsePairs(JSON.stringify(input.pairs)));
      await db
        .insert(schema.settings)
        .values({ key: UNDERLAY_UPGRADES_KEY, value, updatedAt: new Date() })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
      return { ok: true as const, count: input.pairs.length };
    }),
};
