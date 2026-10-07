/* ---------------------------------------------------------------------------
 * The SWMS hazard library: Damien's wording, 2026-10-02 spec.
 *
 * Common hazards are pre-ticked on every SWMS. Flooring sections load from
 * the job's task skills. Each adhesive or chemical item names the SDS code it
 * relies on, and the matching active sheet in safety_docs is attached to the
 * signed record.
 *
 * Signed records keep a frozen copy of what was ticked, so editing this file
 * later never changes a SWMS somebody already signed.
 * ------------------------------------------------------------------------- */

export type SwmsItem = {
  id: string;
  label: string;
  controls: string;
  /** safety_docs.code this item relies on. */
  sds?: string;
};

export type SwmsSection = {
  key: SectionKey;
  title: string;
  task: string;
  items: SwmsItem[];
};

export const SECTION_KEYS = [
  "removal",
  "timber",
  "moisture_seal",
  "sanding_coating",
  "carpet_broadloom",
  "carpet_tiles",
  "hybrid",
  "sheet_vinyl",
  "levelling",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const COMMON_HAZARDS: SwmsItem[] = [
  {
    id: "slips",
    label: "Slips, trips, falls, trailing leads",
    controls: "Keep the work area clear, run leads along walls, tape or cover where people walk.",
  },
  {
    id: "manual",
    label: "Manual handling of rolls, boxes, tools",
    controls: "Bend the knees, use a trolley where you can, two-person lift for heavy rolls.",
  },
  {
    id: "trades",
    label: "Working near other trades",
    controls: "Talk to the site lead or other trades before starting, keep your area marked.",
  },
  {
    id: "knives",
    label: "Knives and cutting tools",
    controls: "Cut away from the body, retract or cover blades when not in use, dispose of blades safely.",
  },
  {
    id: "electrical",
    label: "Electrical leads and power tools",
    controls: "Tagged leads and tools only, check for damage, use an RCD.",
  },
  {
    id: "dust",
    label: "Dust and offcuts",
    controls: "Clean up as you go, bag offcuts, P2 mask when dusty.",
  },
  {
    id: "noise",
    label: "Noise",
    controls: "Hearing protection when using saws, grinders or other loud tools.",
  },
  {
    id: "first_aid",
    label: "First aid kit and emergency exits confirmed",
    controls: "First aid kit in the van or on site, exits and assembly point known.",
  },
];

export const SECTIONS: Record<SectionKey, SwmsSection> = {
  removal: {
    key: "removal",
    title: "Removal of old flooring and glue",
    task: "Lift old carpet, vinyl, tiles or timber, scrape or grind off glue, bag and remove waste.",
    items: [
      {
        id: "removal_asbestos",
        label:
          "Asbestos. Old vinyl, vinyl tiles, lino backing, glue and some underlays can contain asbestos (common before 1990, banned in 2003).",
        controls:
          "Check the asbestos register or the build date before lifting. If you are unsure, do not lift, cut, sand or grind it. Stop work and call the office.",
      },
      {
        id: "removal_lifting",
        label: "Lifting tiles and boards (flying chips, hand strikes, sharp edges)",
        controls: "Eye protection, cut-resistant gloves, long sleeves, keep others out of the area.",
      },
      {
        id: "removal_machine",
        label: "Floor stripper or scraper machine (kickback, vibration, noise)",
        controls: "Trained operator only, both hands on the machine, hearing protection, take breaks.",
      },
      {
        id: "removal_glue",
        label: "Glue removal by grinding or solvent (silica dust, fumes)",
        controls: "Grinder with dust extraction and a P2 mask. For solvent removers, ventilate and no naked flames.",
      },
      {
        id: "removal_sharps",
        label: "Nails, staples and gripper left in the floor",
        controls: "Gloves, pull or punch them as you go, sweep before the next trade walks in.",
      },
      {
        id: "removal_waste",
        label: "Heavy waste bags and rolls (manual handling)",
        controls: "Cut rolls into short lengths, do not overfill bags, two-person lift, trolley to the skip.",
      },
    ],
  },
  timber: {
    key: "timber",
    title: "Timber, adhesive Acouslime 3-in-1",
    task: "Substrate check, trowel adhesive, lay, clean up wet.",
    items: [
      {
        id: "timber_adhesive",
        label: "Acouslime 3-in-1 adhesive. Not classified hazardous, no solvents or isocyanates, low odour. Mild skin sensitiser.",
        controls: "Gloves, avoid eye and skin contact.",
        sds: "acouslime-3in1",
      },
      {
        id: "timber_cutting",
        label: "Cutting boards with saws",
        controls: "Guards on, eye and hearing protection, P2 mask for sawdust.",
      },
    ],
  },
  moisture_seal: {
    key: "moisture_seal",
    title: "Moisture barrier, Acouslime Moisture Seal",
    task: "Moisture barrier applied before the timber adhesive.",
    items: [
      {
        id: "moisture_seal_mdi",
        label: "Acouslime Moisture Seal contains isocyanates (MDI). Skin, eye and respiratory sensitiser.",
        controls: "Gloves, eye protection, good ventilation, avoid breathing vapour.",
        sds: "acouslime-moisture-seal",
      },
    ],
  },
  sanding_coating: {
    key: "sanding_coating",
    title: "Floor sanding and coating",
    task: "Punch nails, fill, drum or belt sand, edge, buff, vacuum, stain and coat (water-based, solvent or 2-pack).",
    items: [
      {
        id: "sand_moving",
        label: "Moving sanders (drum sanders often 80 kg or more)",
        controls: "Two-person lift, break the machine down, trolley, ramps on steps.",
      },
      {
        id: "sand_punching",
        label: "Punching nails (hand strikes, flying metal)",
        controls: "Correct punch and hammer, eye protection.",
      },
      {
        id: "sand_drum",
        label: "Drum or belt sanding (kickback, entanglement, machine running away)",
        controls: "Trained operator, lift the drum before stopping, no loose clothing, unplug to change paper.",
      },
      {
        id: "sand_edging",
        label: "Edging and buffing (hand and back strain, kickback)",
        controls: "Grip correctly, rotate tasks, regular breaks.",
      },
      {
        id: "sand_dust",
        label: "Sanding dust (hardwood dust is a carcinogen) and noise over 85 dB",
        controls: "Machines with dust bags or extraction, P2 mask, hearing protection.",
      },
      {
        id: "sand_lead",
        label: "Old coatings in older homes may contain lead",
        controls: "Test if unsure. If lead is found, stop and call the office.",
      },
      {
        id: "sand_combustion",
        label: "Dust bags and rags (spontaneous combustion, fire)",
        controls:
          "Empty dust bags outside into a metal bin often, rags into a sealed tin of water, never leave full bags on site.",
      },
      {
        id: "sand_solvent",
        label: "Solvent coatings (fumes, fire, explosion)",
        controls:
          "Ventilate, no ignition sources, turn off pilot lights and gas appliances, extinguisher within reach. Organic vapour respirator.",
      },
      {
        id: "sand_2pack",
        label: "2-pack (isocyanate) coatings (respiratory sensitiser, asthma)",
        controls: "Follow the SDS, respirator suited to isocyanates, ventilate, keep others out until cured.",
      },
      {
        id: "sand_power",
        label: "Power supply (electric shock, overloaded circuits)",
        controls: "Tagged leads and RCD, correct-rated outlet for the drum sander, run leads behind the operator.",
      },
      {
        id: "sand_occupants",
        label: "Occupants and other trades (fumes, slipping on wet coating)",
        controls: "Keep the area closed and signed until dry, tell the client the re-entry time.",
      },
    ],
  },
  carpet_broadloom: {
    key: "carpet_broadloom",
    title: "Carpet (broadloom)",
    task: "Cut, lay, stretch, trim.",
    items: [
      {
        id: "carpet_knees",
        label: "Knee strain",
        controls: "Knee pads, change position regularly.",
      },
      {
        id: "carpet_gripper",
        label: "Gripper rods and staples (sharp, puncture risk)",
        controls: "Gloves when handling gripper, pick up loose staples and nails.",
      },
      {
        id: "carpet_rolls",
        label: "Heavy rolls",
        controls: "Two-person lift.",
      },
    ],
  },
  carpet_tiles: {
    key: "carpet_tiles",
    title: "Carpet tiles, adhesive Cemimax A300",
    task: "Set out, spread tackifier or adhesive, lay, trim.",
    items: [
      {
        id: "tiles_adhesive",
        label: "Cemimax A300. Waterborne, not classified hazardous.",
        controls: "Gloves, ventilation.",
        sds: "cemimax-a300",
      },
      {
        id: "tiles_wet",
        label: "Slip risk when adhesive is wet",
        controls: "Keep people off wet areas, work out from the exit.",
      },
    ],
  },
  hybrid: {
    key: "hybrid",
    title: "Hybrid vinyl or planks, adhesive Cemimax A2000",
    task: "Subfloor check, adhesive or click-lock, trim with saw or cutter.",
    items: [
      {
        id: "hybrid_adhesive",
        label: "Cemimax A2000. Waterborne, not classified hazardous.",
        controls: "Gloves, ventilation.",
        sds: "cemimax-a2000",
      },
      {
        id: "hybrid_cutting",
        label: "Saw or guillotine (cutting injury)",
        controls: "Guards on, keep hands clear of the blade, eye protection.",
      },
      {
        id: "hybrid_dust",
        label: "Cutting dust",
        controls: "P2 mask, cut outside or with extraction where you can.",
      },
    ],
  },
  sheet_vinyl: {
    key: "sheet_vinyl",
    title: "Commercial vinyl (sheet), adhesive Mapei Adesilex G19",
    task: "Subfloor prep, mix and spread adhesive, lay, roll, heat or chemical weld seams, cove and skirting.",
    items: [
      {
        id: "g19_adhesive",
        label:
          "Mapei Adesilex G19 (2-part epoxy-polyurethane). Skin and eye irritant and skin sensitiser. Component B can cause severe skin burns and serious eye damage.",
        controls:
          "Chemical-resistant gloves essential, eye protection, long sleeves, ventilation. Avoid all skin contact. Don't sand cured product without a mask.",
        sds: "mapei-g19-a",
      },
      {
        id: "g19_part_b",
        label: "Mapei Adesilex G19 Component B (hardener)",
        controls: "As above. Mix in a ventilated spot, wash off any skin contact straight away.",
        sds: "mapei-g19-b",
      },
      {
        id: "vinyl_welding",
        label: "Hot welding gun or hot-air tool (burns and fire risk)",
        controls: "Stand the gun on its rest, keep clear of flammables, let it cool before packing up.",
      },
      {
        id: "vinyl_trim",
        label: "Weld-rod trimming (sharp spatula)",
        controls: "Cut away from the body, cover the blade when not in use.",
      },
      {
        id: "vinyl_solvent",
        label: "Solvent cleaners",
        controls: "Ventilation, lids back on, no naked flames.",
      },
    ],
  },
  levelling: {
    key: "levelling",
    title: "Levelling and subfloor prep, Sika Level Top with Sika Primer-01",
    task: "Grind or prep the subfloor, prime, mix and pour leveller.",
    items: [
      {
        id: "level_silica",
        label:
          "Self-leveller contains crystalline silica. Dust can cause silicosis, cancer risk by inhalation. Serious eye irritant.",
        controls:
          "Avoid dust, mix carefully, ventilate or work in open air, P2 mask when mixing or sanding. Gloves and eye protection.",
        sds: "sika-level-top",
      },
      {
        id: "level_grinding",
        label: "Grinding the subfloor, the highest dust risk",
        controls: "Dust extraction on the grinder and a P2 mask.",
      },
      {
        id: "level_primer",
        label: "Sika Primer-01. Low VOC.",
        controls: "Gloves, eye protection, ventilation, no naked flames.",
        sds: "sika-primer-01",
      },
    ],
  },
};

/** What each SDS code is, for the library page and for "not on file yet". */
export const SDS_CATALOGUE: Array<{ code: string; product: string; supplier: string }> = [
  { code: "acouslime-3in1", product: "Acouslime 3-in-1 Extra", supplier: "Acouslime" },
  { code: "acouslime-moisture-seal", product: "Acouslime Moisture Seal", supplier: "Acouslime" },
  { code: "cemimax-a300", product: "Cemimax A300", supplier: "Cemimax" },
  { code: "cemimax-a2000", product: "Cemimax A2000", supplier: "Cemimax" },
  { code: "mapei-g19-a", product: "Mapei Adesilex G19 Part A", supplier: "Mapei" },
  { code: "mapei-g19-b", product: "Mapei Adesilex G19 Part B", supplier: "Mapei" },
  { code: "sika-level-top", product: "Sikafloor Level TOP", supplier: "Sika" },
  { code: "sika-primer-01", product: "Sikafloor-01 Primer", supplier: "Sika" },
];

/**
 * Which sections a task skill brings in. Matched on the skill name rather
 * than its id, so the Play demo crew and any renamed skill still map.
 */
const SKILL_RULES: Array<{ test: RegExp; sections: SectionKey[] }> = [
  { test: /removal|uplift|strip out/i, sections: ["removal"] },
  { test: /sanding|staining|coating/i, sections: ["sanding_coating"] },
  { test: /timber install|timber flooring/i, sections: ["timber"] },
  { test: /moisture barrier/i, sections: ["moisture_seal"] },
  { test: /broadloom|direct stick|carpet stairs|carpet repairs/i, sections: ["carpet_broadloom"] },
  { test: /carpet tiles/i, sections: ["carpet_tiles"] },
  { test: /hybrid|vinyl plank|lvt|laminate/i, sections: ["hybrid"] },
  { test: /vinyl sheet|safety vinyl|welding|coving/i, sections: ["sheet_vinyl"] },
  { test: /prep|levell|screed|grinding/i, sections: ["levelling"] },
];

/** Sections for a set of skill names (and the job category as a fallback). */
export function sectionsFor(skillNames: Array<string | null | undefined>, category?: string | null): SectionKey[] {
  const out = new Set<SectionKey>();
  for (const n of skillNames) {
    if (!n) continue;
    for (const r of SKILL_RULES) if (r.test.test(n)) r.sections.forEach((k) => out.add(k));
  }
  if (out.size === 0 && category) {
    for (const r of SKILL_RULES) if (r.test.test(category)) r.sections.forEach((k) => out.add(k));
    if (/carpet/i.test(category) && out.size === 0) out.add("carpet_broadloom");
  }
  // A moisture barrier only ever goes under timber here.
  if (out.has("moisture_seal") && !out.has("timber")) out.add("timber");
  return SECTION_KEYS.filter((k) => out.has(k));
}

/* ------------------------------ snapshots ------------------------------ */

export type SnapshotItem = SwmsItem & { checked: boolean };
export type SwmsSnapshot = {
  common: SnapshotItem[];
  sections: Array<{ key: SectionKey; title: string; task: string; items: SnapshotItem[] }>;
};

/**
 * Build the frozen snapshot from what the phone sent: the ids that were left
 * ticked. Anything the phone did not know about is ignored, so a stale app
 * cannot invent hazards or controls.
 */
export function buildSnapshot(
  commonChecked: string[],
  sections: Array<{ key: SectionKey; checked: string[] }>,
): SwmsSnapshot {
  const tickedCommon = new Set(commonChecked);
  const seen = new Set<SectionKey>();
  const out: SwmsSnapshot["sections"] = [];
  for (const s of sections) {
    const lib = SECTIONS[s.key];
    if (!lib || seen.has(s.key)) continue;
    seen.add(s.key);
    const ticked = new Set(s.checked);
    out.push({
      key: lib.key,
      title: lib.title,
      task: lib.task,
      items: lib.items.map((i) => ({ ...i, checked: ticked.has(i.id) })),
    });
  }
  out.sort((a, b) => SECTION_KEYS.indexOf(a.key) - SECTION_KEYS.indexOf(b.key));
  return {
    common: COMMON_HAZARDS.map((i) => ({ ...i, checked: tickedCommon.has(i.id) })),
    sections: out,
  };
}

/** SDS codes a snapshot relies on. Ticked chemical items only. */
export function sdsCodesIn(snap: SwmsSnapshot): string[] {
  const codes = new Set<string>();
  for (const s of snap.sections) for (const i of s.items) if (i.checked && i.sds) codes.add(i.sds);
  return [...codes];
}
