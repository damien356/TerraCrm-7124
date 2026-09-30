/**
 * THE SKILLS LIST, and the output rates that drive every day-count estimate.
 *
 * This is the restore point. A drizzle-kit push once recreated the skills
 * table and dropped every row, and the old seed.ts list was years stale, so
 * the live list lives here now and can be put back verbatim.
 *
 * Ids are set explicitly and must never be renumbered: the labour rate items,
 * the installer tick lists and the job tasks all reference skill_id, so the
 * ids are the only thing holding those together.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-skills.ts
 */
import { db } from "./index";
import * as schema from "./schema";
import { sql } from "drizzle-orm";

type Row = {
  id: number;
  name: string;
  groupName: string;
  defaultCrewSize: number;
  productionUnit: string;
  productionRate?: number;
  extraCrewUpliftPct?: number;
  fixedDays?: number;
};

// Damien's own edited list as it stood before the wipe, with his output rates
// folded in. Rates are for ONE person per day. Uplift is what each extra body
// adds, never 100. fixedDays is drying or curing, flat whatever the size.
const SKILLS: Row[] = [
  // carpet
  { id: 1, name: "Broadloom carpet 3.6 wide", groupName: "carpet", defaultCrewSize: 1, productionUnit: "lm", productionRate: 25, extraCrewUpliftPct: 80 },
  { id: 2, name: "Carpet tiles", groupName: "carpet", defaultCrewSize: 1, productionUnit: "m2", productionRate: 60, extraCrewUpliftPct: 60 },
  { id: 3, name: "Carpet stairs", groupName: "carpet", defaultCrewSize: 1, productionUnit: "step", productionRate: 14, extraCrewUpliftPct: 50 },
  { id: 4, name: "Direct stick carpet", groupName: "carpet", defaultCrewSize: 1, productionUnit: "m2", productionRate: 50, extraCrewUpliftPct: 60 },
  // Two hours a repair once the drive is counted, so four in a day. A single
  // repair still books a day, because nobody sends a man out for a quarter of one.
  { id: 31, name: "Carpet repairs", groupName: "carpet", defaultCrewSize: 1, productionUnit: "each", productionRate: 4, extraCrewUpliftPct: 0 },
  // resilient
  { id: 5, name: "Vinyl sheet", groupName: "resilient", defaultCrewSize: 1, productionUnit: "m2", productionRate: 40, extraCrewUpliftPct: 35 },
  { id: 6, name: "Vinyl plank / LVT", groupName: "resilient", defaultCrewSize: 1, productionUnit: "m2", productionRate: 40, extraCrewUpliftPct: 35 },
  { id: 7, name: "Hybrid", groupName: "resilient", defaultCrewSize: 1, productionUnit: "m2", productionRate: 40, extraCrewUpliftPct: 35 },
  { id: 8, name: "Laminate", groupName: "resilient", defaultCrewSize: 1, productionUnit: "m2", productionRate: 40, extraCrewUpliftPct: 35 },
  // Welding is the slow part, not the laying, hence a third of plain sheet.
  { id: 9, name: "Safety vinyl / welding", groupName: "resilient", defaultCrewSize: 1, productionUnit: "m2", productionRate: 25, extraCrewUpliftPct: 35 },
  { id: 10, name: "100mm Coving", groupName: "resilient", defaultCrewSize: 1, productionUnit: "lm", productionRate: 35, extraCrewUpliftPct: 35 },
  { id: 32, name: "150mm Coving", groupName: "resilient", defaultCrewSize: 1, productionUnit: "lm", productionRate: 30, extraCrewUpliftPct: 35 },
  // timber
  { id: 11, name: "Timber install", groupName: "timber", defaultCrewSize: 2, productionUnit: "m2", productionRate: 40, extraCrewUpliftPct: 35 },
  { id: 12, name: "Floor sanding + Coating Poly + 2 pac", groupName: "timber", defaultCrewSize: 1, productionUnit: "m2", productionRate: 30, extraCrewUpliftPct: 20, fixedDays: 1 },
  { id: 13, name: "Floor sanding + Poly coating", groupName: "timber", defaultCrewSize: 1, productionUnit: "m2", productionRate: 30, extraCrewUpliftPct: 20, fixedDays: 1 },
  // Stain is a coat of its own and it has to be dry before anything goes over
  // it, so this one waits two days where a straight poly job waits one.
  { id: 33, name: "Floor Sanding + Staining + coating", groupName: "timber", defaultCrewSize: 1, productionUnit: "m2", productionRate: 30, extraCrewUpliftPct: 20, fixedDays: 2 },
  // prep
  { id: 14, name: "Light prep", groupName: "prep", defaultCrewSize: 1, productionUnit: "m2", productionRate: 150, extraCrewUpliftPct: 50 },
  // Levelling, screeding, barriers and bedding all go off wet and have to be
  // walked on the next day, so they carry a drying day the same way sanding does.
  { id: 15, name: "Full prep / levelling", groupName: "prep", defaultCrewSize: 1, productionUnit: "m2", productionRate: 70, extraCrewUpliftPct: 50, fixedDays: 1 },
  { id: 16, name: "Screeding", groupName: "prep", defaultCrewSize: 1, productionUnit: "m2", productionRate: 50, extraCrewUpliftPct: 50, fixedDays: 1 },
  { id: 17, name: "Moisture barrier", groupName: "prep", defaultCrewSize: 1, productionUnit: "m2", productionRate: 100, extraCrewUpliftPct: 40, fixedDays: 1 },
  { id: 18, name: "Grinding", groupName: "prep", defaultCrewSize: 1, productionUnit: "m2", productionRate: 60, extraCrewUpliftPct: 50 },
  // demolition
  // Pulling up is grunt work in a room with nothing else happening in it, so a
  // second body is worth close to a whole one here, unlike laying.
  { id: 19, name: "Carpet removal", groupName: "demolition", defaultCrewSize: 1, productionUnit: "m2", productionRate: 120, extraCrewUpliftPct: 80 },
  { id: 20, name: "Tile removal", groupName: "demolition", defaultCrewSize: 1, productionUnit: "m2", productionRate: 40, extraCrewUpliftPct: 50 },
  { id: 21, name: "Vinyl removal", groupName: "demolition", defaultCrewSize: 1, productionUnit: "m2", productionRate: 60, extraCrewUpliftPct: 80 },
  { id: 22, name: "Glue removal", groupName: "demolition", defaultCrewSize: 1, productionUnit: "m2", productionRate: 40, extraCrewUpliftPct: 80 },
  // trades
  { id: 23, name: "Silicone perimeter", groupName: "trades", defaultCrewSize: 1, productionUnit: "lm", productionRate: 120, extraCrewUpliftPct: 30 },
  { id: 24, name: "Skirting / carpenter", groupName: "trades", defaultCrewSize: 1, productionUnit: "lm", productionRate: 70, extraCrewUpliftPct: 50 },
  { id: 25, name: "Door trimming", groupName: "trades", defaultCrewSize: 1, productionUnit: "each", productionRate: 20, extraCrewUpliftPct: 50 },
  { id: 26, name: "Nosings", groupName: "trades", defaultCrewSize: 1, productionUnit: "each", productionRate: 20, extraCrewUpliftPct: 50 },
  { id: 29, name: "Waterproofing", groupName: "trades", defaultCrewSize: 1, productionUnit: "m2", productionRate: 40, extraCrewUpliftPct: 30, fixedDays: 1 },
  { id: 30, name: "Bedding", groupName: "trades", defaultCrewSize: 2, productionUnit: "m2", productionRate: 30, extraCrewUpliftPct: 50, fixedDays: 1 },
  // other
  // No rate on purpose. A furniture shift depends on what is in the house and
  // a measure depends on the drive, so the office puts the day in by hand.
  { id: 27, name: "Furniture shift", groupName: "other", defaultCrewSize: 2, productionUnit: "m2" },
  { id: 28, name: "Measure & quote", groupName: "other", defaultCrewSize: 1, productionUnit: "m2" },
];

const existing = await db.select().from(schema.skills);
if (existing.length > 0) {
  console.log(`skills already has ${existing.length} rows, refusing to touch it`);
  process.exit(1);
}

await db.insert(schema.skills).values(
  SKILLS.map((r) => ({
    id: r.id,
    name: r.name,
    groupName: r.groupName,
    defaultCrewSize: r.defaultCrewSize,
    minCrew: 1,
    recommendedCrew: 1,
    productionRate: r.productionRate ?? null,
    productionUnit: r.productionUnit,
    extraCrewUpliftPct: r.extraCrewUpliftPct ?? 35,
    fixedDays: r.fixedDays ?? 0,
    minCompletionPhotos: 4,
    // id order was the display order before the wipe, so keep it.
    sortOrder: r.id - 1,
    active: true,
  })),
);

const back = await db.select().from(schema.skills);
console.log(`restored ${back.length} skills`);

// Every skill id anything else points at must now exist, or the app has holes.
const refs = await db.all<{ src: string; skill_id: number; n: number }>(sql`
  select 'labour_rate_items' src, skill_id, count(*) n from labour_rate_items where skill_id is not null group by skill_id
  union all
  select 'installer_skills' src, skill_id, count(*) n from installer_skills group by skill_id
  union all
  select 'job_tasks' src, skill_id, count(*) n from job_tasks where skill_id is not null group by skill_id
`);
const have = new Set(back.map((s) => s.id));
const orphans = refs.filter((r) => !have.has(r.skill_id));
console.log(`references checked: ${refs.length} groups, orphans: ${orphans.length}`);
if (orphans.length) console.log(orphans);
