import { db } from "../database";
import * as schema from "../database/schema";
import { SDS_CATALOGUE } from "./swms-library";
import { v1Templates, type BlockItem } from "./swms-content";

/* ---------------------------------------------------------------------------
 * One-time load of the SWMS content into the Stage 2 tables.
 *
 * 1. Today's built-in wording, published as version 1, so live jobs read
 *    exactly what they read now.
 * 2. Damien's 9-template SWMS Library (plans/swms/library.md, 7 Oct) as
 *    drafts. Repeated rows are merged into shared task blocks. Crew sees
 *    none of it until someone publishes.
 * 3. The site checks from the same library. Edited in Stage 2, shown on the
 *    phone in Stage 3.
 *
 * Does nothing if any template already exists.
 * ------------------------------------------------------------------------- */

type R = "H" | "M" | "L";
const item = (block: string, slug: string, label: string, rb: R, controls: string, ra: R, sds?: string): BlockItem => ({
  id: `${block}.${slug}`,
  label,
  controls,
  riskBefore: rb,
  riskAfter: ra,
  ...(sds ? { sds } : {}),
});

type SeedBlock = { key: string; title: string; task: string; items: BlockItem[] };

export const LIBRARY_BLOCKS: SeedBlock[] = [
  {
    key: "manual_handling",
    title: "Manual handling, rolls, cartons and packs",
    task: "Deliver, carry and stage rolls, cartons, tile boxes and timber packs.",
    items: [
      item(
        "manual_handling",
        "lifting",
        "Moving rolls, cartons and packs. Back strain, crush.",
        "H",
        "Two-person lift for anything heavy, roll trolley or dolly, break packs down, carry one carton at a time, keep boxes under 20 kg, stage close to the work face, clear the path first. Never roll vinyl down stairs uncontrolled.",
        "M",
      ),
    ],
  },
  {
    key: "uplift_asbestos",
    title: "Uplift old floor and asbestos check",
    task: "Lift old carpet, underlay, vinyl or tiles and remove the waste.",
    items: [
      item("uplift_asbestos", "dust", "Uplift. Dust, mould, staples and nails.", "M", "P2 mask, gloves, bag waste as it comes up, ventilate.", "L"),
      item(
        "uplift_asbestos",
        "asbestos",
        "Possible asbestos in old vinyl tiles, backing, underlay or glue.",
        "H",
        "Check the asbestos register or build date before starting. If you suspect it, stop work and get it tested.",
        "L",
      ),
    ],
  },
  {
    key: "slab_grinding",
    title: "Slab grinding and levelling (silica)",
    task: "Scrape, grind, prime and level the subfloor.",
    items: [
      item(
        "slab_grinding",
        "silica",
        "Grinding, scraping or levelling. Silica dust, noise, flying debris, cement burns.",
        "H",
        "Grinder with H-class vacuum or dust extraction, P2 mask, eye and hearing protection. Mix leveller outside or ventilated, gloves.",
        "M",
      ),
    ],
  },
  {
    key: "adhesive_tackifier",
    title: "Tackifier, carpet tiles",
    task: "Spread tackifier for carpet tiles.",
    items: [
      item("adhesive_tackifier", "fumes", "Tackifier. Fumes, skin contact.", "M", "Follow the SDS, ventilate, gloves, wash hands before eating.", "L", "cemimax-a300"),
    ],
  },
  {
    key: "adhesive_timber",
    title: "Timber adhesive and primer",
    task: "Prime and trowel timber adhesive.",
    items: [
      item(
        "adhesive_timber",
        "adhesive",
        "Primer and timber adhesive (often polyurethane or MS polymer). Skin sensitisation, fumes.",
        "H",
        "Follow the SDS, nitrile gloves, ventilate, adhesive remover on hand, no skin contact.",
        "M",
        "acouslime-3in1",
      ),
      item("adhesive_timber", "trowel", "Trowelling. Wrist and back strain.", "M", "Correct trowel, rotate tasks, regular breaks.", "L"),
      item("adhesive_timber", "wet", "Wet adhesive on the floor. Slips, others walking through.", "M", "Work from the far wall to the exit, barricade and sign the area.", "L"),
    ],
  },
  {
    key: "adhesive_vinyl",
    title: "Vinyl adhesive, Mapei Adesilex G19",
    task: "Mix and spread 2-part adhesive for sheet vinyl.",
    items: [
      item(
        "adhesive_vinyl",
        "part_a",
        "Mapei Adesilex G19 (2-part epoxy-polyurethane). Skin and eye irritant, skin sensitiser.",
        "M",
        "Follow the SDS, ventilate, nitrile gloves, eye protection, long sleeves.",
        "L",
        "mapei-g19-a",
      ),
      item("adhesive_vinyl", "part_b", "G19 Part B. Can cause severe skin burns and eye damage.", "H", "Chemical-resistant gloves and eye protection when mixing. No skin contact.", "M", "mapei-g19-b"),
    ],
  },
  {
    key: "adhesive_hybrid",
    title: "Plank adhesive, Cemimax A2000 (glue-down only)",
    task: "Only when planks are glued down, not click-lock.",
    items: [item("adhesive_hybrid", "fumes", "Plank adhesive. Fumes, skin contact.", "M", "Follow the SDS, ventilate, gloves.", "L", "cemimax-a2000")],
  },
  {
    key: "power_saw",
    title: "Power saw cutting",
    task: "Drop saw, table saw or circular saw cuts.",
    items: [
      item(
        "power_saw",
        "saw",
        "Saw cutting. Lacerations, kickback, flying debris.",
        "H",
        "Guards fitted, trained operator, eye and hearing protection, never reach past the blade.",
        "M",
      ),
      item(
        "power_saw",
        "dust",
        "Cutting dust. Hardwood dust is a carcinogen. Stone composite and HDF cores give off fine dust.",
        "H",
        "Saw with extraction or cut outside, P2 mask, vacuum not broom.",
        "M",
      ),
    ],
  },
  {
    key: "knife_cutting",
    title: "Knife cutting",
    task: "Cutting carpet, tiles, sheet, coving or score-and-snap planks.",
    items: [
      item("knife_cutting", "cuts", "Knife cuts.", "M", "Sharp blade, straightedge, cut away from the body, cut-resistant gloves, retract the blade.", "L"),
    ],
  },
  {
    key: "nail_gun",
    title: "Nail gun and compressor",
    task: "Smoothedge and secret nailing.",
    items: [
      item(
        "nail_gun",
        "nails",
        "Nail gun. Penetration injury, sharp pins, noise.",
        "H",
        "Sequential trigger, never point at people, disconnect when clearing jams, eye protection, keep hands clear.",
        "M",
      ),
    ],
  },
  {
    key: "coating",
    title: "Coating, solvents and 2-pack",
    task: "Stain and coat (water-based, solvent or 2-pack).",
    items: [
      item(
        "coating",
        "solvent",
        "Solvent coatings. Fumes, fire, explosion.",
        "H",
        "Ventilate, no ignition sources, turn off pilot lights and gas appliances, extinguisher within reach, organic vapour respirator.",
        "M",
      ),
      item("coating", "two_pack", "2-pack (isocyanate) coatings. Respiratory sensitisation, asthma.", "H", "Follow the SDS, correct respirator, ventilate, keep others out until cured.", "M"),
      item(
        "coating",
        "rags",
        "Dust bags and rags. Spontaneous combustion, fire.",
        "H",
        "Empty dust bags outside into a metal bin often, rags into a sealed tin of water, never leave full bags on site.",
        "M",
      ),
      item("coating", "occupants", "Occupants and other trades. Fumes, slips on wet coating.", "M", "Keep the area closed and signed until dry, tell the client the re-entry time.", "L"),
    ],
  },
  {
    key: "sanding",
    title: "Floor sanding machines",
    task: "Punch nails, drum or belt sand, edge and buff.",
    items: [
      item("sanding", "moving", "Moving sanders (drum sanders often 80 kg or more). Crush, stairs.", "H", "Two-person lift, break the machine down, trolley, ramps on steps.", "M"),
      item("sanding", "punching", "Punching nails. Hand strikes, flying metal.", "M", "Correct punch and hammer, eye protection.", "L"),
      item(
        "sanding",
        "drum",
        "Drum or belt sanding. Kickback, entanglement, machine running away.",
        "H",
        "Trained operator, lift the drum before stopping, no loose clothing, unplug to change paper.",
        "M",
      ),
      item("sanding", "edging", "Edging and buffing. Hand and back strain, kickback.", "M", "Grip correctly, rotate tasks, regular breaks.", "L"),
      item("sanding", "dust", "Sanding dust and noise over 85 dB.", "H", "Machines with dust bags or extraction, P2 mask, hearing protection.", "M"),
      item("sanding", "lead", "Old coatings in older homes. Possible lead.", "H", "Test if unsure. If lead is found, stop and follow the lead-safe procedure.", "L"),
      item(
        "sanding",
        "power",
        "Power supply. Electric shock, overloaded circuits.",
        "H",
        "Tagged leads and RCD, correct-rated outlet for the drum sander, route leads behind the operator.",
        "M",
      ),
    ],
  },
  {
    key: "hot_welding",
    title: "Hot welding and weld trimming",
    task: "Groove, hot-weld and trim seams.",
    items: [
      item(
        "hot_welding",
        "weld",
        "Hot welding (about 400 °C). Burns, fire.",
        "H",
        "Trained operators, gun on its stand when not in use, heat-resistant gloves, extinguisher within reach, keep flammables clear.",
        "M",
      ),
      item("hot_welding", "trim", "Weld trimming (spatula or mozart knife). Lacerations.", "M", "Trained use, guard on the trimmer, cut-resistant gloves.", "L"),
    ],
  },
  {
    key: "seaming_iron",
    title: "Seaming iron",
    task: "Heat-bond carpet seams.",
    items: [item("seaming_iron", "burns", "Seaming iron and tape. Burns.", "M", "Heat-resistant gloves, iron on its stand, unplug after use.", "L")],
  },
  {
    key: "knee_kicker",
    title: "Knee kicker and power stretcher",
    task: "Stretch broadloom carpet.",
    items: [item("knee_kicker", "knees", "Knee kicker. Knee injury, strain.", "M", "Knee pads, power stretcher on large rooms, rotate tasks.", "L")],
  },
  {
    key: "kneeling",
    title: "Kneeling and tapping",
    task: "Long periods on the knees, tapping block and pull bar.",
    items: [
      item("kneeling", "knees", "Prolonged kneeling, tapping block, pull bar. Knee and back strain, hand strikes.", "M", "Knee pads, correct tapping block, gloves, regular breaks, rotate tasks.", "L"),
    ],
  },
  {
    key: "leads",
    title: "Leads and power tools",
    task: "Power tools and extension leads.",
    items: [item("leads", "shock", "Leads and power tools. Electric shock, trips.", "M", "Tagged leads and RCD, route leads clear of walkways.", "L")],
  },
  {
    key: "work_area",
    title: "Work area, others on site",
    task: "Keeping the area safe for us and everyone else.",
    items: [
      item(
        "work_area",
        "trips",
        "Work area. Slips, trips, other trades and the public.",
        "M",
        "Barricade and signage, keep exits clear, tidy offcuts as you go, stage cartons out of walkways, lay underlay and plastic film as you go and tape the seams.",
        "L",
      ),
    ],
  },
  {
    key: "occupied_site",
    title: "Healthcare or occupied site",
    task: "Clinics, offices and homes people are still using.",
    items: [
      item("occupied_site", "healthcare", "Healthcare sites. Infection control, patients and staff.", "M", "Follow the clinic rules, seal the work area, agree access with the site contact.", "L"),
      item("occupied_site", "furniture", "Moving furniture on occupied sites. Crush, strain, damage.", "M", "Two-person lift, furniture lifters, agree staging with the client.", "L"),
    ],
  },
];

type SeedTemplate = {
  key: string;
  name: string;
  workType: string;
  activity: string;
  ppe: string[];
  blocks: string[];
  matchTerms: string[];
  categoryTerms?: string[];
  replacesKey: string | null;
};

export const LIBRARY_TEMPLATES: SeedTemplate[] = [
  {
    key: "lib_carpet",
    name: "Carpet (broadloom)",
    workType: "Carpet",
    activity: "Remove old floor covering, lay underlay and smoothedge, stretch and fix broadloom carpet, finish trims.",
    ppe: ["Safety boots", "Knee pads", "Gloves", "P2 mask for uplift", "Eye protection with power tools"],
    blocks: ["manual_handling", "uplift_asbestos", "nail_gun", "knee_kicker", "knife_cutting", "seaming_iron", "kneeling", "leads", "work_area"],
    matchTerms: ["broadloom", "direct stick", "carpet stairs", "carpet repairs"],
    categoryTerms: ["carpet"],
    replacesKey: "carpet_broadloom",
  },
  {
    key: "lib_carpet_tiles",
    name: "Carpet tiles",
    workType: "Carpet tiles",
    activity: "Prepare subfloor, apply tackifier, lay and cut carpet tiles, fit trims. Often in occupied commercial sites.",
    ppe: ["Safety boots", "Knee pads", "Gloves", "Eye protection when grinding or scraping"],
    blocks: ["manual_handling", "slab_grinding", "adhesive_tackifier", "knife_cutting", "kneeling", "occupied_site", "leads", "work_area"],
    matchTerms: ["carpet tiles"],
    replacesKey: "carpet_tiles",
  },
  {
    key: "lib_solid_timber",
    name: "Solid timber",
    workType: "Solid timber",
    activity: "Moisture test, install battens or ply where needed, glue and secret-nail solid timber boards, cut and fit, sand and coat where in scope.",
    ppe: ["Safety boots", "Hearing protection", "Eye protection", "P2 mask (sanding)", "Gloves", "Knee pads", "Organic vapour respirator for solvent coatings"],
    blocks: ["manual_handling", "power_saw", "nail_gun", "adhesive_timber", "coating", "kneeling", "leads", "work_area"],
    matchTerms: ["timber install", "timber flooring"],
    replacesKey: "timber",
  },
  {
    key: "lib_eng_floating",
    name: "Engineered timber (floating)",
    workType: "Engineered timber",
    activity: "Check floor flatness and moisture, lay underlay, click-lock or glue-joint engineered boards, cut and fit, install trims and expansion gaps.",
    ppe: ["Safety boots", "Knee pads", "Eye and hearing protection", "P2 mask when cutting"],
    blocks: ["manual_handling", "slab_grinding", "power_saw", "kneeling", "leads", "work_area"],
    matchTerms: [],
    categoryTerms: ["floating floor"],
    replacesKey: null,
  },
  {
    key: "lib_eng_stuck",
    name: "Engineered timber (stuck-down)",
    workType: "Engineered timber",
    activity: "Moisture test slab, grind and prime, apply moisture-barrier or elastic adhesive by trowel, lay boards, weight down, clean adhesive, fit trims.",
    ppe: ["Safety boots", "Knee pads", "Nitrile gloves", "Eye and hearing protection", "P2 mask when grinding or cutting"],
    blocks: ["manual_handling", "slab_grinding", "adhesive_timber", "power_saw", "kneeling", "leads", "work_area"],
    matchTerms: [],
    replacesKey: null,
  },
  {
    key: "lib_vinyl",
    name: "Commercial vinyl (incl. coving and hot welding)",
    workType: "Commercial vinyl",
    activity:
      "Remove existing floor, grind and level, apply adhesive, lay sheet vinyl, form coved skirting with cove former and capping, groove and hot-weld seams, trim welds. Common in medical, dental and clinic fit-outs.",
    ppe: ["Safety boots", "Knee pads", "Nitrile gloves", "Heat-resistant gloves (welding)", "Cut-resistant gloves", "Eye and hearing protection", "P2 mask or better when grinding"],
    blocks: ["manual_handling", "uplift_asbestos", "slab_grinding", "adhesive_vinyl", "knife_cutting", "hot_welding", "occupied_site", "kneeling", "leads", "work_area"],
    matchTerms: ["vinyl sheet", "safety vinyl", "welding", "coving"],
    replacesKey: "sheet_vinyl",
  },
  {
    key: "lib_hybrid",
    name: "Hybrid (floating)",
    workType: "Hybrid",
    activity: "Check flatness, level where needed, lay underlay if not pre-attached, click-lock hybrid planks, score-and-snap or saw cuts, fit trims with expansion gaps.",
    ppe: ["Safety boots", "Knee pads", "Gloves", "Eye and hearing protection when sawing"],
    blocks: ["manual_handling", "slab_grinding", "adhesive_hybrid", "knife_cutting", "power_saw", "kneeling", "leads", "work_area"],
    matchTerms: ["hybrid", "vinyl plank", "lvt"],
    replacesKey: "hybrid",
  },
  {
    key: "lib_laminate",
    name: "Laminate (floating)",
    workType: "Laminate",
    activity: "Check flatness and moisture, lay moisture barrier and underlay, click-lock laminate boards, saw cut and fit, install trims with expansion gaps.",
    ppe: ["Safety boots", "Knee pads", "Gloves", "Eye and hearing protection", "P2 mask when sawing"],
    blocks: ["manual_handling", "power_saw", "kneeling", "leads", "work_area"],
    matchTerms: ["laminate"],
    replacesKey: "hybrid",
  },
  {
    key: "lib_sanding",
    name: "Floor sanding and coating",
    workType: "Sanding and coating",
    activity:
      "Punch nails, fill, drum or belt sand, edge sand, buff, vacuum, apply stain and coatings (water-based, solvent-based or 2-pack). Labour-only jobs as well as new timber floors.",
    ppe: [
      "Safety boots",
      "Hearing protection",
      "Eye protection",
      "P2 mask for sanding",
      "Organic vapour respirator for solvent coatings",
      "Respirator suited to isocyanates for 2-pack (check SDS)",
      "Nitrile gloves",
      "Knee pads",
    ],
    blocks: ["sanding", "coating", "work_area"],
    matchTerms: ["sanding", "staining", "coating"],
    replacesKey: "sanding_coating",
  },
];

export const LIBRARY_SITE_CHECKS = [
  { question: "Site induction done, or signed in with the builder", answers: ["yes", "no"], flagOn: ["no"], appliesAll: true, templateKeys: [] as string[] },
  {
    question: "Asbestos register checked, or building built after 2003",
    answers: ["yes", "no", "unsure"],
    flagOn: ["no", "unsure"],
    appliesAll: false,
    templateKeys: ["removal", "lib_carpet", "lib_vinyl"],
  },
  {
    question: "Area ventilated for adhesives or coatings",
    answers: ["yes", "no"],
    flagOn: ["no"],
    appliesAll: false,
    templateKeys: ["carpet_tiles", "timber", "sheet_vinyl", "sanding_coating", "lib_carpet_tiles", "lib_solid_timber", "lib_eng_stuck", "lib_vinyl", "lib_sanding"],
  },
  { question: "Other trades working in this area", answers: ["yes", "no"], flagOn: [] as string[], appliesAll: true, templateKeys: [] as string[] },
  { question: "Power leads tagged and RCD in use", answers: ["yes", "no"], flagOn: ["no"], appliesAll: true, templateKeys: [] as string[] },
  {
    question: "Fire extinguisher within reach",
    answers: ["yes", "no"],
    flagOn: ["no"],
    appliesAll: false,
    templateKeys: ["sheet_vinyl", "sanding_coating", "lib_solid_timber", "lib_vinyl", "lib_sanding"],
  },
  {
    question: "Healthcare site. Clinic rules confirmed with the site contact",
    answers: ["yes", "no", "na"],
    flagOn: ["no"],
    appliesAll: false,
    templateKeys: ["sheet_vinyl", "lib_vinyl"],
  },
];

export async function seedSwmsContent(actorName = "System") {
  const existing = await db.select({ id: schema.swmsTemplates.id }).from(schema.swmsTemplates).limit(1);
  if (existing.length) return { seeded: false as const };
  const at = new Date();

  // SDS products. Keep any that are already there.
  const have = new Set((await db.select({ code: schema.sdsProducts.code }).from(schema.sdsProducts)).map((r) => r.code));
  const sds = SDS_CATALOGUE.filter((c) => !have.has(c.code));
  if (sds.length) await db.insert(schema.sdsProducts).values(sds.map((c) => ({ ...c, createdAt: at, updatedAt: at })));

  // 1. Version 1: today's wording, published.
  let published = 0;
  for (const t of v1Templates()) {
    const blockIds: number[] = [];
    for (const b of t.blocks) {
      const [row] = await db
        .insert(schema.swmsBlocks)
        .values({ key: b.key, title: b.title, task: b.task, ppe: "[]", items: JSON.stringify(b.items), updatedByName: actorName, createdAt: at, updatedAt: at })
        .returning({ id: schema.swmsBlocks.id });
      blockIds.push(row!.id);
    }
    const [tpl] = await db
      .insert(schema.swmsTemplates)
      .values({
        key: t.key,
        name: t.name,
        workType: t.workType,
        activity: t.activity,
        ppe: "[]",
        blockIds: JSON.stringify(blockIds),
        everyJob: t.everyJob,
        matchTerms: JSON.stringify(t.rule.matchTerms),
        categoryTerms: JSON.stringify(t.rule.categoryTerms),
        alsoAdds: JSON.stringify(t.rule.alsoAdds),
        sortOrder: t.sortOrder,
        updatedByName: actorName,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: schema.swmsTemplates.id });
    const { rule: _r, sortOrder: _s, ...frozen } = t;
    await db.insert(schema.swmsTemplateVersions).values({
      templateId: tpl!.id,
      version: 1,
      content: JSON.stringify(frozen),
      whatChanged: "Built-in wording moved into Ops. No change to the wording.",
      publishedByName: actorName,
      publishedAt: at,
    });
    published++;
  }

  // 2. The library, as drafts.
  const blockId = new Map<string, number>();
  for (const b of LIBRARY_BLOCKS) {
    const [row] = await db
      .insert(schema.swmsBlocks)
      .values({ key: b.key, title: b.title, task: b.task, ppe: "[]", items: JSON.stringify(b.items), updatedByName: actorName, createdAt: at, updatedAt: at })
      .returning({ id: schema.swmsBlocks.id });
    blockId.set(b.key, row!.id);
  }
  let drafts = 0;
  for (const [n, t] of LIBRARY_TEMPLATES.entries()) {
    await db.insert(schema.swmsTemplates).values({
      key: t.key,
      name: t.name,
      workType: t.workType,
      activity: t.activity,
      ppe: JSON.stringify(t.ppe),
      blockIds: JSON.stringify(t.blocks.map((k) => blockId.get(k)!)),
      everyJob: false,
      matchTerms: JSON.stringify(t.matchTerms),
      categoryTerms: JSON.stringify(t.categoryTerms ?? []),
      alsoAdds: "[]",
      replacesKey: t.replacesKey,
      sortOrder: 200 + n * 10,
      updatedByName: actorName,
      createdAt: at,
      updatedAt: at,
    });
    drafts++;
  }

  // 3. Site checks.
  for (const [n, c] of LIBRARY_SITE_CHECKS.entries()) {
    await db.insert(schema.swmsSiteChecks).values({
      question: c.question,
      answers: JSON.stringify(c.answers),
      flagOn: JSON.stringify(c.flagOn),
      blocks: false,
      appliesAll: c.appliesAll,
      templateKeys: JSON.stringify(c.templateKeys),
      sortOrder: n * 10,
      createdAt: at,
      updatedAt: at,
    });
  }

  await db.insert(schema.swmsChanges).values({
    entityType: "template",
    entityId: null,
    action: "seeded",
    summary: `Loaded the SWMS content. ${published} built-in templates published as version 1. ${drafts} library templates added as drafts. ${LIBRARY_SITE_CHECKS.length} site checks.`,
    actorName,
    actorRole: "system",
    createdAt: at,
  });
  return { seeded: true as const, published, drafts, blocks: blockId.size, siteChecks: LIBRARY_SITE_CHECKS.length };
}
