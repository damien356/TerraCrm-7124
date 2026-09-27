/**
 * The labour rate book: every work item Terra can pay an installer for, with
 * its unit. Rates themselves are deliberately NOT seeded. Terra's numbers are
 * Damien's to type in, and a made up rate in a costing screen is worse than a
 * blank one.
 *
 * Idempotent: matches on name, updates unit / group / skill in place, so it is
 * safe to re-run after the list is extended.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-labour-rates.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";

type Item = {
  name: string;
  /** Skill name as it appears in Settings. Empty = not tied to one skill. */
  skill?: string;
  group: "carpet" | "resilient" | "timber" | "prep" | "demolition" | "trades" | "surcharge" | "other";
  unit: "m2" | "lm" | "each" | "step" | "hour" | "day" | "job" | "percent" | "km";
  kind?: "work" | "surcharge" | "allowance";
  notes?: string;
};

/** Stairs, the five items every hard floor gets. Carpet gets its own longer list. */
const hardFloorStairs = (prefix: string, skill: string, group: Item["group"]): Item[] => [
  { name: `${prefix} standard straight step`, skill, group, unit: "step" },
  { name: `${prefix} winder`, skill, group, unit: "step" },
  { name: `${prefix} feature / oversized step`, skill, group, unit: "step" },
  { name: `${prefix} landing`, skill, group, unit: "m2" },
  { name: `${prefix} nosing`, skill, group, unit: "lm" },
];

const ITEMS: Item[] = [
  /* ----------------------------- carpet ----------------------------- */
  { name: "Broadloom carpet 3.66m", skill: "Broadloom carpet", group: "carpet", unit: "lm" },
  { name: "Broadloom carpet 4.0m", skill: "Broadloom carpet", group: "carpet", unit: "lm" },
  { name: "Broadloom carpet, by the metre", skill: "Broadloom carpet", group: "carpet", unit: "m2", notes: "For jobs priced on area rather than roll length." },
  { name: "Carpet tile install", skill: "Carpet tiles", group: "carpet", unit: "m2" },
  { name: "Direct stick carpet", skill: "Direct stick carpet", group: "carpet", unit: "m2" },
  { name: "Carpet repair", skill: "Carpet repairs", group: "carpet", unit: "hour" },
  { name: "Carpet uplift and disposal", skill: "Carpet removal", group: "carpet", unit: "m2" },

  /* carpet stairs, itemised — this is where the money hides */
  { name: "Carpet stairs, standard straight step", skill: "Carpet stairs", group: "carpet", unit: "step" },
  { name: "Carpet stairs, bullnose step", skill: "Carpet stairs", group: "carpet", unit: "step" },
  { name: "Carpet stairs, winder", skill: "Carpet stairs", group: "carpet", unit: "step" },
  { name: "Carpet stairs, winder bullnose", skill: "Carpet stairs", group: "carpet", unit: "step" },
  { name: "Carpet stairs, feature / oversized step", skill: "Carpet stairs", group: "carpet", unit: "step" },
  { name: "Carpet stairs, landing", skill: "Carpet stairs", group: "carpet", unit: "m2" },
  { name: "Carpet stairs, stair nosing", skill: "Carpet stairs", group: "carpet", unit: "lm" },

  /* --------------------------- resilient ---------------------------- */
  { name: "Hybrid installation", skill: "Hybrid", group: "resilient", unit: "m2" },
  { name: "Laminate installation", skill: "Laminate", group: "resilient", unit: "m2" },
  { name: "Vinyl plank / LVT installation", skill: "Vinyl plank / LVT", group: "resilient", unit: "m2" },
  { name: "Vinyl plank / LVT, herringbone", skill: "Vinyl plank / LVT", group: "resilient", unit: "m2" },
  { name: "Sheet vinyl installation", skill: "Vinyl sheet", group: "resilient", unit: "m2" },
  { name: "Hot welding", skill: "Safety vinyl / welding", group: "resilient", unit: "lm" },
  { name: "Coving", skill: "Coving", group: "resilient", unit: "lm" },
  ...hardFloorStairs("Hybrid stairs,", "Hybrid", "resilient"),
  ...hardFloorStairs("Laminate stairs,", "Laminate", "resilient"),
  ...hardFloorStairs("LVT stairs,", "Vinyl plank / LVT", "resilient"),

  /* ----------------------------- timber ----------------------------- */
  { name: "Engineered timber, floating", skill: "Timber install", group: "timber", unit: "m2" },
  { name: "Engineered timber, direct stick", skill: "Timber install", group: "timber", unit: "m2" },
  { name: "Solid timber, secret nail", skill: "Timber install", group: "timber", unit: "m2" },
  { name: "Solid timber, direct stick", skill: "Timber install", group: "timber", unit: "m2" },
  { name: "Floor sanding", skill: "Floor sanding", group: "timber", unit: "m2" },
  { name: "Coating, per coat", skill: "Polishing / coating", group: "timber", unit: "m2" },
  ...hardFloorStairs("Engineered timber stairs,", "Timber install", "timber"),
  ...hardFloorStairs("Solid timber stairs,", "Timber install", "timber"),

  /* ------------------------------ prep ------------------------------ */
  { name: "Floor preparation", skill: "Light prep", group: "prep", unit: "m2" },
  { name: "Full levelling and patching", skill: "Full prep / levelling", group: "prep", unit: "m2" },
  { name: "Prep, by the hour", skill: "Full prep / levelling", group: "prep", unit: "hour" },
  { name: "Screeding", skill: "Screeding", group: "prep", unit: "m2" },
  { name: "Grinding", skill: "Grinding", group: "prep", unit: "m2" },
  { name: "Grinding, by the hour", skill: "Grinding", group: "prep", unit: "hour" },
  { name: "Moisture barrier", skill: "Moisture barrier", group: "prep", unit: "m2" },

  /* --------------------------- demolition --------------------------- */
  { name: "Tile removal", skill: "Tile removal", group: "demolition", unit: "m2" },
  { name: "Vinyl / lino removal", skill: "Vinyl removal", group: "demolition", unit: "m2" },
  { name: "Glue and adhesive removal", skill: "Glue removal", group: "demolition", unit: "m2" },
  { name: "Rubbish removal and tip run", group: "demolition", unit: "job" },

  /* ----------------------------- trades ----------------------------- */
  { name: "Silicone perimeter", skill: "Silicone perimeter", group: "trades", unit: "lm" },
  { name: "Skirting removal and refit", skill: "Skirting / carpenter", group: "trades", unit: "lm" },
  { name: "Door trimming", skill: "Door trimming", group: "trades", unit: "each" },
  { name: "Nosing supply and fit", skill: "Nosings", group: "trades", unit: "lm" },
  { name: "Remove and reinstall existing nosing", skill: "Nosings", group: "trades", unit: "each" },
  { name: "Waterproofing", skill: "Waterproofing", group: "trades", unit: "m2" },
  { name: "Bedding", skill: "Bedding", group: "trades", unit: "m2" },

  /* ------------------------------ other ----------------------------- */
  { name: "Furniture shift", skill: "Furniture shift", group: "other", unit: "each", notes: "Per room, unless the note on the job says otherwise." },
  { name: "Measure and quote", skill: "Measure & quote", group: "other", unit: "job" },
  { name: "Day rate, one man", group: "other", unit: "day" },
  { name: "Day rate, two man crew", group: "other", unit: "day" },

  /* -------------------- surcharges and allowances ------------------- */
  { name: "Open sided step surcharge", group: "surcharge", unit: "step", kind: "surcharge", notes: "On top of the step rate, any floor type." },
  { name: "After hours loading", group: "surcharge", unit: "percent", kind: "surcharge" },
  { name: "Saturday loading", group: "surcharge", unit: "percent", kind: "surcharge" },
  { name: "Sunday loading", group: "surcharge", unit: "percent", kind: "surcharge" },
  { name: "Public holiday loading", group: "surcharge", unit: "percent", kind: "surcharge" },
  { name: "Small job surcharge", group: "surcharge", unit: "job", kind: "surcharge" },
  { name: "Travel, per km", group: "surcharge", unit: "km", kind: "allowance" },
  { name: "Travel, per hour", group: "surcharge", unit: "hour", kind: "allowance" },
  { name: "Regional allowance", group: "surcharge", unit: "job", kind: "allowance" },
  { name: "Parking and tolls", group: "surcharge", unit: "job", kind: "allowance", notes: "At cost by default. Put the actual figure on the job." },
];

/** Skills the rate book needs that the original list did not have. */
const EXTRA_SKILLS: Array<{ name: string; group: string }> = [{ name: "Carpet repairs", group: "carpet" }];

async function run() {
  const existingSkills = await db.select().from(s.skills);
  const byName = new Map(existingSkills.map((k) => [k.name.toLowerCase(), k]));

  for (const extra of EXTRA_SKILLS) {
    if (byName.has(extra.name.toLowerCase())) continue;
    const [row] = await db
      .insert(s.skills)
      .values({
        name: extra.name,
        groupName: extra.group,
        sortOrder: existingSkills.length + 1,
      })
      .returning();
    byName.set(extra.name.toLowerCase(), row!);
    console.log(`+ skill ${extra.name}`);
  }

  const existingItems = await db.select().from(s.labourRateItems);
  const itemByName = new Map(existingItems.map((i) => [i.name.toLowerCase(), i]));

  let added = 0;
  let updated = 0;

  for (const [i, item] of ITEMS.entries()) {
    const skillId = item.skill ? (byName.get(item.skill.toLowerCase())?.id ?? null) : null;
    if (item.skill && !skillId) console.warn(`! no skill named "${item.skill}" for ${item.name}`);

    const values = {
      skillId,
      name: item.name,
      groupName: item.group,
      kind: item.kind ?? "work",
      unit: item.unit,
      notes: item.notes ?? null,
      sortOrder: i,
    };

    const found = itemByName.get(item.name.toLowerCase());
    if (found) {
      await db
        .update(s.labourRateItems)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(s.labourRateItems.id, found.id));
      updated++;
    } else {
      await db.insert(s.labourRateItems).values(values);
      added++;
    }
  }

  console.log(`rate book: ${added} added, ${updated} updated, ${ITEMS.length} items total`);
}

await run();
process.exit(0);
