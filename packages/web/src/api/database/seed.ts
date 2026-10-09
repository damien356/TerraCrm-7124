/**
 * Seeds reference data (skills, statuses, settings) and a small set of realistic
 * demo records so the dispatch board isn't empty on first login.
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed.ts
 */
import { db } from "./index";
import * as s from "./schema";

const SKILLS: Array<[string, string, number]> = [
  ["Broadloom carpet", "carpet", 1],
  ["Carpet tiles", "carpet", 1],
  ["Carpet stairs", "carpet", 1],
  ["Direct stick carpet", "carpet", 1],
  ["Vinyl sheet", "resilient", 1],
  ["Vinyl plank / LVT", "resilient", 1],
  ["Hybrid", "resilient", 1],
  ["Laminate", "resilient", 1],
  ["Safety vinyl / welding", "resilient", 1],
  ["Coving", "resilient", 1],
  ["Timber install", "timber", 2],
  ["Floor sanding", "timber", 1],
  ["Polishing / coating", "timber", 1],
  ["Light prep", "prep", 1],
  ["Full prep / levelling", "prep", 1],
  ["Screeding", "prep", 1],
  ["Moisture barrier", "prep", 1],
  ["Grinding", "prep", 1],
  ["Carpet removal", "demolition", 1],
  ["Tile removal", "demolition", 1],
  ["Vinyl removal", "demolition", 1],
  ["Glue removal", "demolition", 1],
  ["Silicone perimeter", "trades", 1],
  ["Skirting / carpenter", "trades", 1],
  ["Door trimming", "trades", 1],
  ["Nosings", "trades", 1],
  ["Furniture shift", "other", 2],
  ["Measure & quote", "other", 1],
];

const STATUSES: Array<[string, string, string]> = [
  ["Lead", "#7A736D", "open"],
  ["Quoted", "#5B7A9E", "open"],
  ["Won", "#3F7D3A", "won"],
  ["Scheduled", "#4A7FA5", "scheduled"],
  ["In Progress", "#D08A1E", "active"],
  ["Complete", "#3F7D3A", "complete"],
  ["Invoiced", "#5B6E7A", "complete"],
  ["Paid", "#2E6B4F", "closed"],
  ["Cancelled", "#7A736D", "closed"],
];

const SETTINGS: Array<[string, string]> = [
  ["business_phone", "0468 366 555"],
];

async function main() {
  const existingSkills = await db.select({ id: s.skills.id }).from(s.skills).limit(1);
  if (existingSkills.length > 0) {
    console.log("Already seeded — skipping. Delete rows manually to re-seed.");
    return;
  }

  const skillRows = await db
    .insert(s.skills)
    .values(
      SKILLS.map(([name, groupName, defaultCrewSize], i) => ({
        name,
        groupName,
        defaultCrewSize,
        sortOrder: i,
      })),
    )
    .returning();
  const skillId = (name: string) => skillRows.find((r) => r.name === name)!.id;

  const statusRows = await db
    .insert(s.jobStatuses)
    .values(
      STATUSES.map(([name, colour, stage], i) => ({
        name,
        colour: colour.startsWith("#") && colour.length === 7 ? colour : "#7A736D",
        stage,
        sortOrder: i,
      })),
    )
    .returning();
  const statusId = (name: string) => statusRows.find((r) => r.name === name)!.id;

  await db.insert(s.settings).values(SETTINGS.map(([key, value]) => ({ key, value })));

  /* Installers — rename these to your real crew in the app. */
  const installerRows = await db
    .insert(s.installers)
    .values([
      {
        name: "Mick R.",
        mobile: "0412 000 001",
        crewCapacity: "own_offsider",
        serviceArea: "Gold Coast north",
        colour: "#4A7FA5",
      },
      {
        name: "Dave T.",
        mobile: "0412 000 002",
        crewCapacity: "solo",
        serviceArea: "Gold Coast",
        colour: "#5C8A52",
      },
      {
        name: "Sam K.",
        mobile: "0412 000 003",
        crewCapacity: "needs_partner",
        serviceArea: "Gold Coast south / Tweed",
        colour: "#B07B3A",
      },
      {
        name: "Trav (removals)",
        mobile: "0412 000 004",
        crewCapacity: "solo",
        serviceArea: "Gold Coast",
        colour: "#C0603F",
      },
      {
        name: "Gary (silicone)",
        mobile: "0412 000 005",
        crewCapacity: "solo",
        serviceArea: "Gold Coast",
        colour: "#7A6A9E",
      },
      {
        name: "Pete (carpenter)",
        mobile: "0412 000 006",
        crewCapacity: "solo",
        serviceArea: "Gold Coast",
        colour: "#7A736D",
      },
    ])
    .returning();
  const inst = (name: string) => installerRows.find((r) => r.name.startsWith(name))!.id;

  await db.insert(s.installerSkills).values([
    { installerId: inst("Mick"), skillId: skillId("Broadloom carpet"), rateType: "per_m2", rate: 9.5 },
    { installerId: inst("Mick"), skillId: skillId("Carpet stairs"), rateType: "per_job", rate: 45 },
    { installerId: inst("Mick"), skillId: skillId("Light prep"), rateType: "hourly", rate: 65 },
    { installerId: inst("Mick"), skillId: skillId("Carpet removal"), rateType: "per_m2", rate: 3 },
    { installerId: inst("Dave"), skillId: skillId("Vinyl plank / LVT"), rateType: "per_m2", rate: 14 },
    { installerId: inst("Dave"), skillId: skillId("Hybrid"), rateType: "per_m2", rate: 13 },
    { installerId: inst("Dave"), skillId: skillId("Full prep / levelling"), rateType: "hourly", rate: 70 },
    { installerId: inst("Dave"), skillId: skillId("Light prep"), rateType: "hourly", rate: 65 },
    { installerId: inst("Sam"), skillId: skillId("Broadloom carpet"), rateType: "per_m2", rate: 9 },
    { installerId: inst("Sam"), skillId: skillId("Carpet tiles"), rateType: "per_m2", rate: 11 },
    { installerId: inst("Sam"), skillId: skillId("Vinyl sheet"), rateType: "per_m2", rate: 15, canLead: false },
    { installerId: inst("Trav"), skillId: skillId("Tile removal"), rateType: "per_m2", rate: 22 },
    { installerId: inst("Trav"), skillId: skillId("Glue removal"), rateType: "per_m2", rate: 12 },
    { installerId: inst("Trav"), skillId: skillId("Carpet removal"), rateType: "per_m2", rate: 3.5 },
    { installerId: inst("Gary"), skillId: skillId("Silicone perimeter"), rateType: "per_job", rate: 180 },
    { installerId: inst("Pete"), skillId: skillId("Skirting / carpenter"), rateType: "hourly", rate: 85 },
    { installerId: inst("Pete"), skillId: skillId("Door trimming"), rateType: "per_job", rate: 40 },
    { installerId: inst("Pete"), skillId: skillId("Nosings"), rateType: "per_job", rate: 55 },
  ]);

  /* A builder company with contacts in different roles. */
  const [abc] = await db
    .insert(s.companies)
    .values({
      name: "ABC Builders QLD",
      type: "builder",
      phone: "07 5555 1000",
      email: "accounts@abcbuilders.com.au",
      billingAddress: "12 Trade Cct, Molendinar QLD 4214",
      paymentTerms: 30,
      abn: "51 824 753 556",
    })
    .returning();

  const contactRows = await db
    .insert(s.contacts)
    .values([
      { firstName: "Kerry", lastName: "Watson", mobile: "0417 552 010", email: "kerry.watson@gmail.com", suburb: "Mermaid Waters", source: "website" },
      { firstName: "Carol", lastName: "Nguyen", mobile: "0432 118 447", email: "carol@abcbuilders.com.au", suburb: "Molendinar", source: "repeat" },
      { firstName: "Rick", lastName: "Dalton", mobile: "0407 991 226", email: "rick@abcbuilders.com.au", suburb: "Southport", source: "repeat" },
      { firstName: "Janelle", lastName: "Price", mobile: "0422 776 500", email: "janelle@raywhitemermaid.com.au", suburb: "Mermaid Beach", source: "referral" },
      { firstName: "Tenant", lastName: "— 3/22 Palm Ave", mobile: "0438 220 114", suburb: "Burleigh Heads", source: "other" },
    ])
    .returning();
  const c = (first: string) => contactRows.find((r) => r.firstName === first)!.id;

  await db.insert(s.companyContacts).values([
    { companyId: abc!.id, contactId: c("Carol"), role: "accounts", jobTitle: "Accounts & Invoicing", isPrimary: true },
    { companyId: abc!.id, contactId: c("Rick"), role: "supervisor", jobTitle: "Site Supervisor" },
  ]);

  const siteRows = await db
    .insert(s.sites)
    .values([
      { address: "14 Sunrise Bvd", suburb: "Mermaid Waters", postcode: "4218", contactId: c("Kerry"), accessNotes: "Lockbox 4471, side gate. Dog in back yard.", propertyType: "residential" },
      { address: "3/22 Palm Ave", suburb: "Burleigh Heads", postcode: "4220", contactId: c("Janelle"), accessNotes: "Tenant home after 2pm. Park in visitor bay 4.", propertyType: "rental" },
      { address: "Lot 18, Riverwalk Estate", suburb: "Helensvale", postcode: "4212", companyId: abc!.id, accessNotes: "Site key from supervisor. Hi-vis + boots required.", propertyType: "new_build" },
      { address: "9 Ridgeline Ct", suburb: "Robina", postcode: "4226", contactId: c("Carol"), accessNotes: "Owner home. Garage access.", propertyType: "residential" },
    ])
    .returning();
  const site = (address: string) => siteRows.find((r) => r.address.startsWith(address))!.id;

  const jobRows = await db
    .insert(s.jobs)
    .values([
      {
        number: 218,
        title: "Carpet — 3 bed + hallway",
        statusId: statusId("Scheduled"),
        siteId: site("14 Sunrise"),
        contactId: c("Kerry"),
        billToType: "contact",
        billToContactId: c("Kerry"),
        furnitureOnSite: true,
        description: "Belgotex Sensation — Dune. 3 bedrooms + hallway, 68 m². Remove old carpet, light prep.",
        accessNotes: "Lockbox 4471, side gate.",
        source: "website",
        value: 4850,
        depositAmount: 1240,
        depositPaid: true,
      },
      {
        number: 221,
        title: "Hybrid plank — living + kitchen",
        statusId: statusId("Scheduled"),
        siteId: site("3/22 Palm"),
        contactId: c("Janelle"),
        billToType: "contact",
        billToContactId: c("Janelle"),
        description: "Rental turnover. Lift tiles in wet areas, level, lay hybrid 24 m².",
        accessNotes: "Tenant home after 2pm.",
        source: "referral",
        value: 3120,
      },
      {
        number: 224,
        title: "New build — carpet + vinyl throughout",
        statusId: statusId("Won"),
        siteId: site("Lot 18"),
        companyId: abc!.id,
        contactId: c("Rick"),
        billToType: "company",
        billToCompanyId: abc!.id,
        description: "Stage 2 handover. Carpet to bedrooms, LVT to living/wet areas.",
        accessNotes: "Site key from Rick. Hi-vis required.",
        source: "repeat",
        value: 11400,
      },
      {
        number: 226,
        title: "Measure & quote — timber sand and polish",
        statusId: statusId("Lead"),
        siteId: site("9 Ridgeline"),
        contactId: c("Carol"),
        billToType: "contact",
        billToContactId: c("Carol"),
        description: "Carol's own home (works at ABC Builders — bill her personally, not the company).",
        source: "repeat",
        value: 0,
      },
    ])
    .returning();
  const job = (number: number) => jobRows.find((r) => r.number === number)!.id;

  await db.insert(s.jobContacts).values([
    { jobId: job(218), contactId: c("Kerry"), role: "owner", tags: '["owner"]', isPrimary: true, onSiteContact: true, receivesSms: true, receivesEmail: true, canApproveQuote: true, showToCrew: true },
    { jobId: job(221), contactId: c("Janelle"), role: "property_manager", tags: '["property_manager"]', isPrimary: true, receivesEmail: true, canApproveQuote: true },
    { jobId: job(221), contactId: c("Tenant"), role: "tenant", tags: '["tenant"]', onSiteContact: true, receivesSms: true, showToCrew: true },
    { jobId: job(224), contactId: c("Rick"), role: "supervisor", tags: '["supervisor"]', isPrimary: true, onSiteContact: true, receivesSms: true, showToCrew: true },
    { jobId: job(224), contactId: c("Carol"), role: "accounts", tags: '["accounts"]', receivesEmail: true },
    { jobId: job(226), contactId: c("Carol"), role: "owner", tags: '["owner"]', isPrimary: true, onSiteContact: true, receivesSms: true, receivesEmail: true, showToCrew: true },
  ]);

  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const day = (offset: number) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  await db.insert(s.jobTasks).values([
    { jobId: job(218), seq: 1, skillId: skillId("Carpet removal"), title: "Lift old carpet — 3 bed + hall", areaM2: 68, scheduledDate: day(0), startTime: "07:30", durationHours: 2, crewSize: 1, status: "assigned", assignedInstallerId: inst("Trav"), payType: "per_m2", payAmount: 238 },
    { jobId: job(218), seq: 2, skillId: skillId("Light prep"), title: "Light prep + staple down", areaM2: 68, scheduledDate: day(0), startTime: "10:00", durationHours: 2, crewSize: 1, status: "assigned", assignedInstallerId: inst("Mick"), payType: "hourly", payAmount: 130 },
    { jobId: job(218), seq: 3, skillId: skillId("Broadloom carpet"), title: "Lay carpet — Sensation Dune, 68 m²", description: "Furniture on site — 2 man. Mick brings own offsider.", areaM2: 68, scheduledDate: day(1), startTime: "08:00", durationHours: 6, crewSize: 2, status: "assigned", assignedInstallerId: inst("Mick"), payType: "per_m2", payAmount: 646 },
    { jobId: job(218), seq: 4, skillId: skillId("Silicone perimeter"), title: "Silicone perimeter — wet areas", scheduledDate: day(2), startTime: "08:00", durationHours: 2, crewSize: 1, status: "offered", payType: "per_job", payAmount: 180 },
    { jobId: job(221), seq: 1, skillId: skillId("Tile removal"), title: "Lift tiles — kitchen + laundry", areaM2: 18, scheduledDate: day(1), startTime: "07:30", durationHours: 5, crewSize: 1, status: "assigned", assignedInstallerId: inst("Trav"), payType: "per_m2", payAmount: 396 },
    { jobId: job(221), seq: 2, skillId: skillId("Full prep / levelling"), title: "Level and prep subfloor", areaM2: 24, scheduledDate: day(2), startTime: "08:00", durationHours: 4, crewSize: 1, status: "assigned", assignedInstallerId: inst("Dave"), payType: "hourly", payAmount: 280 },
    { jobId: job(221), seq: 3, skillId: skillId("Hybrid"), title: "Lay hybrid plank — 24 m²", areaM2: 24, scheduledDate: day(3), startTime: "07:30", durationHours: 7, crewSize: 1, status: "assigned", assignedInstallerId: inst("Dave"), payType: "per_m2", payAmount: 312 },
    { jobId: job(221), seq: 4, skillId: skillId("Skirting / carpenter"), title: "Refit skirting — kitchen", scheduledDate: day(3), startTime: "15:00", durationHours: 2, crewSize: 1, status: "unassigned", payType: "hourly", payAmount: 170 },
    { jobId: job(224), seq: 1, skillId: skillId("Vinyl plank / LVT"), title: "LVT — living, kitchen, wet areas", areaM2: 96, scheduledDate: day(4), startTime: "07:00", durationHours: 8, crewSize: 2, status: "unassigned", payType: "per_m2", payAmount: 1344 },
    { jobId: job(224), seq: 2, skillId: skillId("Broadloom carpet"), title: "Carpet — 4 bedrooms", areaM2: 82, scheduledDate: day(5), startTime: "07:00", durationHours: 6, crewSize: 2, status: "unassigned", payType: "per_m2", payAmount: 779 },
    { jobId: job(226), seq: 1, skillId: skillId("Measure & quote"), title: "Measure & quote — timber sand + polish", scheduledDate: day(2), startTime: "11:00", durationHours: 1, crewSize: 1, status: "unassigned", payType: "per_job", payAmount: 0 },
  ]);

  const tasks = await db.select().from(s.jobTasks);
  const siliconeTask = tasks.find((t) => t.status === "offered");
  if (siliconeTask) {
    const expires = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await db.insert(s.taskOffers).values([
      { taskId: siliconeTask.id, installerId: inst("Gary"), mode: "broadcast", status: "pending", payAmount: 180, expiresAt: expires },
    ]);
  }

  const carpetTask = tasks.find((t) => t.title.startsWith("Lay carpet"));
  if (carpetTask) {
    await db.insert(s.taskChecklistItems).values([
      { taskId: carpetTask.id, label: "Subfloor prepped and swept", sortOrder: 0, required: true },
      { taskId: carpetTask.id, label: "Old floor removed and taken away", sortOrder: 1, required: true },
      { taskId: carpetTask.id, label: "Furniture moved back", sortOrder: 2, required: true },
      { taskId: carpetTask.id, label: "Site cleaned, offcuts removed", sortOrder: 3, required: true },
      { taskId: carpetTask.id, label: "Photos uploaded", sortOrder: 4, required: true },
    ]);
  }

  await db.insert(s.products).values([
    { supplier: "Belgotex", brand: "Belgotex", range: "Sensation", colour: "Dune", category: "carpet", unit: "m2", costPrice: 38.5, sellPrice: 72 },
    { supplier: "Belgotex", brand: "Belgotex", range: "Sensation", colour: "Driftwood", category: "carpet", unit: "m2", costPrice: 38.5, sellPrice: 72 },
    { supplier: "Belgotex", brand: "Belgotex", range: "Cavalier", colour: "Stone", category: "carpet", unit: "m2", costPrice: 44, sellPrice: 84 },
    { supplier: "Armstrong", brand: "Armstrong", range: "Natural Creations", colour: "Blonde Oak", category: "vinyl", unit: "m2", costPrice: 46, sellPrice: 89 },
    { supplier: "Airstep", brand: "Airstep", range: "Underlay Premium", colour: "8mm", category: "underlay", unit: "m2", costPrice: 6.2, sellPrice: 14 },
  ]);

  await db.insert(s.activityLog).values([
    { jobId: job(218), action: "job_created", detail: "Job created from website enquiry", actorName: "System" },
    { jobId: job(218), action: "deposit_paid", detail: "Deposit $1,240 received", actorName: "System" },
  ]);

  console.log("Seeded:", {
    skills: skillRows.length,
    statuses: statusRows.length,
    installers: installerRows.length,
    contacts: contactRows.length,
    jobs: jobRows.length,
    tasks: tasks.length,
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
