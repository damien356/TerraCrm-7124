import * as s from "./schema";
import type { TerraDb } from "./routed";
import { addLocalDays } from "../lib/local-date";

/**
 * Made up Terra for the Google Play reviewer. Nothing here is a real customer,
 * crew member, price or pay rate. Phone numbers are from the ranges ACMA keeps
 * for fiction (0491 570 xxx mobiles, 07 5550 xxxx landlines) and every email is
 * @example.com, so even a slip could not reach a person.
 *
 * Dates are laid out around `today` so every crew screen has something on it:
 * two jobs today, more over the coming week, two open offers, and a finished
 * job from yesterday ready to invoice.
 */

/** The demo crew member the reviewer is signed in as. */
export const DEMO_INSTALLER_ID = 1;

type Reference = {
  skills: (typeof s.skills.$inferSelect)[];
  statuses: (typeof s.jobStatuses.$inferSelect)[];
};

export async function seedDemo(d: TerraDb, today: string, ref: Reference) {
  const day = (n: number) => addLocalDays(today, n);
  /* Gold Coast wall clock time on day n. Queensland has no daylight saving. */
  const at = (n: number, hh: number, mm = 0) =>
    new Date(new Date(`${day(n)}T00:00:00+10:00`).getTime() + (hh * 60 + mm) * 60_000);
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000);

  /* ---------------------------------------------------- reference lists */
  if (ref.skills.length) await d.insert(s.skills).values(ref.skills);
  if (ref.statuses.length) await d.insert(s.jobStatuses).values(ref.statuses);

  const skills = await d.select().from(s.skills);
  const skill = (prefix: string) =>
    (skills.find((k) => k.name.toLowerCase().startsWith(prefix.toLowerCase())) ?? skills[0])?.id ?? null;
  const statuses = await d.select().from(s.jobStatuses);
  const status = (stage: string, name?: string) =>
    (statuses.find((x) => (name ? x.name === name : false)) ?? statuses.find((x) => x.stage === stage) ?? statuses[0])
      ?.id ?? null;

  await d.insert(s.settings).values([
    { key: "business_name", value: "Terra Flooring (demo)" },
    { key: "business_phone", value: "1300 183 772" },
    { key: "gst_rate", value: "0.10" },
    { key: "offer_expiry_hours", value: "48" },
    { key: "broadcast_shows_pay", value: "true" },
    { key: "installer_can_see_customer_name", value: "always" },
    { key: "installer_can_see_customer_phone", value: "always" },
  ]);

  /* ------------------------------------------------------------- crew */
  await d.insert(s.installers).values([
    {
      id: DEMO_INSTALLER_ID,
      name: "Mick R.",
      mobile: "0491 570 006",
      email: "mick.demo@example.com",
      crewCapacity: "own_offsider",
      serviceArea: "Gold Coast north",
      colour: "#4A7FA5",
      starRating: 5,
      abn: "11 111 111 111",
      tradingName: "Mick R Flooring (demo)",
      gstRegistered: true,
      businessAddress: "1 Example St, Southport QLD 4215",
      invoiceEmail: "mick.demo@example.com",
      bankAccountName: "Mick R Flooring",
      bankBsb: "000-000",
      bankAccountNumber: "00000000",
      nextInvoiceNumber: 101,
      locationConsentAt: new Date(),
      navApp: "google",
    },
    { id: 2, name: "Dave T.", mobile: "0491 570 156", email: "dave.demo@example.com", crewCapacity: "solo", serviceArea: "Gold Coast", colour: "#5C8A52", starRating: 4 },
    { id: 3, name: "Sam K.", mobile: "0491 570 157", email: "sam.demo@example.com", crewCapacity: "needs_partner", serviceArea: "Gold Coast south", colour: "#B07B3A" },
    { id: 4, name: "Trav (removals)", mobile: "0491 570 158", email: "trav.demo@example.com", crewCapacity: "solo", serviceArea: "Gold Coast", colour: "#C0603F" },
    { id: 5, name: "Gary (silicone)", mobile: "0491 570 159", email: "gary.demo@example.com", crewCapacity: "solo", serviceArea: "Gold Coast", colour: "#7A6A9E" },
  ]);

  const mickSkills = ["Broadloom", "Carpet stairs", "Carpet removal", "Light prep", "Hybrid", "Measure"];
  const tick = (installerId: number, names: string[]) =>
    names
      .map((n) => skill(n))
      .filter((id, i, all): id is number => id != null && all.indexOf(id) === i)
      .map((skillId) => ({ installerId, skillId, rateType: "per_m2", rate: null }));
  await d.insert(s.installerSkills).values([
    ...tick(1, mickSkills),
    ...tick(2, ["Vinyl plank", "Hybrid", "Full prep"]),
    ...tick(3, ["Broadloom", "Carpet tiles"]),
    ...tick(4, ["Tile removal", "Carpet removal", "Glue removal"]),
    ...tick(5, ["Silicone"]),
  ]);

  /* A small rate card, invented figures, so the Me tab shows one. */
  const rateItems = await d
    .insert(s.labourRateItems)
    .values([
      { skillId: skill("Broadloom"), name: "Broadloom carpet lay", groupName: "carpet", unit: "m2", sortOrder: 1 },
      { skillId: skill("Carpet stairs"), name: "Carpet stairs", groupName: "carpet", unit: "step", sortOrder: 2 },
      { skillId: skill("Carpet removal"), name: "Carpet uplift", groupName: "demolition", unit: "m2", sortOrder: 3 },
      { skillId: skill("Light prep"), name: "Light prep", groupName: "prep", unit: "hour", sortOrder: 4 },
      { skillId: skill("Hybrid"), name: "Hybrid plank lay", groupName: "resilient", unit: "m2", sortOrder: 5 },
      { skillId: skill("Measure"), name: "Measure and quote visit", groupName: "other", unit: "job", sortOrder: 6 },
    ])
    .returning();
  const rate = [10, 12, 3, 60, 14, 50];
  await d.insert(s.labourRates).values(
    rateItems.map((it, i) => ({ itemId: it.id, amount: rate[i] ?? 10, effectiveFrom: day(-60), createdByName: "Demo" })),
  );

  /* ---------------------------------------------------- customers, sites */
  const [builder] = await d
    .insert(s.companies)
    .values({
      name: "Coastline Homes (demo)",
      type: "builder",
      phone: "07 5550 1000",
      email: "accounts@example.com",
      billingAddress: "10 Example Ct, Molendinar QLD 4214",
      paymentTerms: 30,
    })
    .returning();

  const people = await d
    .insert(s.contacts)
    .values([
      { firstName: "Kerry", lastName: "Walsh", mobile: "0491 570 110", email: "kerry@example.com", suburb: "Mermaid Waters", source: "website" },
      { firstName: "Janelle", lastName: "Price", mobile: "0491 570 313", email: "janelle@example.com", suburb: "Burleigh Heads", source: "referral" },
      { firstName: "Rick", lastName: "Dalton", mobile: "0491 570 737", email: "rick@example.com", suburb: "Helensvale", source: "repeat" },
      { firstName: "Carol", lastName: "Nguyen", mobile: "0491 571 266", email: "carol@example.com", suburb: "Robina", source: "repeat" },
      { firstName: "Tom", lastName: "Baker", mobile: "0491 571 491", email: "tom@example.com", suburb: "Southport", source: "website" },
      { firstName: "Priya", lastName: "Shah", mobile: "0491 571 804", email: "priya@example.com", suburb: "Coomera", source: "google" },
    ])
    .returning();
  const c = (first: string) => people.find((p) => p.firstName === first)!.id;

  await d.insert(s.companyContacts).values([
    { companyId: builder!.id, contactId: c("Rick"), role: "supervisor", jobTitle: "Site supervisor", isPrimary: true },
  ]);

  const siteRows = await d
    .insert(s.sites)
    .values([
      { address: "14 Example Bvd", suburb: "Mermaid Waters", postcode: "4218", contactId: c("Kerry"), accessNotes: "Side gate. Dog in the back yard.", propertyType: "residential" },
      { address: "3/22 Example Ave", suburb: "Burleigh Heads", postcode: "4220", contactId: c("Janelle"), accessNotes: "Tenant home after 2pm. Visitor bay 4.", propertyType: "rental" },
      { address: "Lot 18 Example Estate", suburb: "Helensvale", postcode: "4212", companyId: builder!.id, accessNotes: "Key from the supervisor. Hi-vis and boots.", propertyType: "new_build" },
      { address: "9 Example Ct", suburb: "Robina", postcode: "4226", contactId: c("Carol"), accessNotes: "Owner home. Garage access.", propertyType: "residential" },
      { address: "41 Example St", suburb: "Southport", postcode: "4215", contactId: c("Tom"), accessNotes: "Unit 2, ring on arrival.", propertyType: "residential" },
      { address: "7 Example Pl", suburb: "Coomera", postcode: "4209", contactId: c("Priya"), accessNotes: "", propertyType: "residential" },
    ])
    .returning();
  const site = (suburb: string) => siteRows.find((r) => r.suburb === suburb)!.id;

  /* ------------------------------------------------------------- jobs */
  const jobRows = await d
    .insert(s.jobs)
    .values([
      { number: 9218, title: "Carpet, 3 bed and hallway", statusId: status("scheduled", "Scheduled"), siteId: site("Mermaid Waters"), contactId: c("Kerry"), billToContactId: c("Kerry"), furnitureOnSite: true, description: "Demo job. Broadloom to 3 bedrooms and hallway, 68 m2. Lift old carpet, light prep.", accessNotes: "Side gate.", source: "website", value: 4850, depositAmount: 1240, depositPaid: true },
      { number: 9221, title: "Hybrid plank, living and kitchen", statusId: status("scheduled", "Scheduled"), siteId: site("Burleigh Heads"), contactId: c("Janelle"), billToContactId: c("Janelle"), description: "Demo job. Rental turnover, hybrid 24 m2.", accessNotes: "Tenant home after 2pm.", source: "referral", value: 3120 },
      { number: 9224, title: "New build, carpet throughout", statusId: status("won", "Won"), siteId: site("Helensvale"), companyId: builder!.id, contactId: c("Rick"), billToType: "company", billToCompanyId: builder!.id, description: "Demo job. Stage 2 handover, carpet to 4 bedrooms.", accessNotes: "Key from Rick.", source: "repeat", value: 11400 },
      { number: 9226, title: "Measure and quote, carpet stairs", statusId: status("open", "Lead"), siteId: site("Robina"), contactId: c("Carol"), billToContactId: c("Carol"), description: "Demo job. 14 stairs and landing.", source: "repeat", value: 0 },
      { number: 9210, title: "Carpet, lounge room", statusId: status("complete", "Complete"), siteId: site("Southport"), contactId: c("Tom"), billToContactId: c("Tom"), description: "Demo job. Lounge 22 m2.", source: "website", value: 1980, completedAt: at(-1, 15) },
      { number: 9229, title: "Hybrid plank, whole house", statusId: status("open", "Quoted"), siteId: site("Coomera"), contactId: c("Priya"), billToContactId: c("Priya"), description: "Demo job. Quote sent, waiting on the customer.", source: "google", value: 0 },
    ])
    .returning();
  const job = (n: number) => jobRows.find((j) => j.number === n)!.id;

  await d.insert(s.jobContacts).values([
    { jobId: job(9218), contactId: c("Kerry"), role: "owner", tags: '["owner"]', isPrimary: true, onSiteContact: true, receivesSms: true, receivesEmail: true, canApproveQuote: true, showToCrew: true },
    { jobId: job(9221), contactId: c("Janelle"), role: "property_manager", tags: '["property_manager"]', isPrimary: true, onSiteContact: true, receivesEmail: true, canApproveQuote: true, showToCrew: true },
    { jobId: job(9224), contactId: c("Rick"), role: "supervisor", tags: '["supervisor"]', isPrimary: true, onSiteContact: true, receivesSms: true, showToCrew: true },
    { jobId: job(9226), contactId: c("Carol"), role: "owner", tags: '["owner"]', isPrimary: true, onSiteContact: true, receivesSms: true, showToCrew: true },
    { jobId: job(9210), contactId: c("Tom"), role: "owner", tags: '["owner"]', isPrimary: true, onSiteContact: true, receivesSms: true, showToCrew: true },
    { jobId: job(9229), contactId: c("Priya"), role: "owner", tags: '["owner"]', isPrimary: true, receivesEmail: true, canApproveQuote: true },
  ]);

  /* ------------------------------------------------------------ tasks */
  const mick = DEMO_INSTALLER_ID;
  const lay = (qty: number, rateEach: number, name: string, unit = "m2") =>
    JSON.stringify([{ itemId: 0, name, unit, qty, rate: rateEach, source: "standard", total: qty * rateEach }]);

  const taskRows = await d
    .insert(s.jobTasks)
    .values([
      /* Mick, today */
      { jobId: job(9218), seq: 2, skillId: skill("Broadloom"), title: "Lay carpet, 68 m2", description: "Furniture on site, bring the offsider.", areaM2: 68, scheduledDate: day(0), startTime: "07:30", durationHours: 6, crewSize: 2, status: "assigned", assignedInstallerId: mick, payType: "per_m2", payAmount: 680, labourCost: 680, labourBreakdown: lay(68, 10, "Broadloom carpet lay"), labourPricedOn: day(-3) },
      { jobId: job(9226), seq: 1, skillId: skill("Measure"), title: "Measure and quote, 14 stairs", areaM2: null, scheduledDate: day(0), startTime: "14:00", durationHours: 1, crewSize: 1, status: "assigned", assignedInstallerId: mick, payType: "per_job", payAmount: 50 },
      /* Mick, coming up */
      { jobId: job(9221), seq: 3, skillId: skill("Hybrid"), title: "Lay hybrid plank, 24 m2", areaM2: 24, scheduledDate: day(1), startTime: "07:30", durationHours: 7, crewSize: 1, status: "assigned", assignedInstallerId: mick, payType: "per_m2", payAmount: 336, labourCost: 336, labourBreakdown: lay(24, 14, "Hybrid plank lay"), labourPricedOn: day(-3) },
      { jobId: job(9224), seq: 2, skillId: skill("Broadloom"), title: "Carpet, 4 bedrooms, 82 m2", areaM2: 82, scheduledDate: day(3), startTime: "07:00", durationHours: 7, crewSize: 2, status: "assigned", assignedInstallerId: mick, payType: "per_m2", payAmount: 820, labourCost: 820, labourBreakdown: lay(82, 10, "Broadloom carpet lay"), labourPricedOn: day(-3) },
      /* Mick, done yesterday, ready to invoice */
      { jobId: job(9210), seq: 1, skillId: skill("Broadloom"), title: "Lay carpet, lounge 22 m2", areaM2: 22, scheduledDate: day(-1), startTime: "08:00", durationHours: 3, crewSize: 1, status: "complete", assignedInstallerId: mick, payType: "per_m2", payAmount: 220, labourCost: 220, labourBreakdown: lay(22, 10, "Broadloom carpet lay"), labourPricedOn: day(-5), startedAt: at(-1, 8), completedAt: at(-1, 11, 30), signatureName: "Tom Baker", damageCheckedAt: at(-1, 8), damageNone: true },
      /* Offers out to Mick */
      { jobId: job(9224), seq: 3, skillId: skill("Carpet stairs"), title: "Carpet stairs, 13 steps", areaM2: null, scheduledFrom: day(4), scheduledTo: day(6), startTime: "07:30", durationHours: 4, crewSize: 1, status: "offered", payType: "per_job", payAmount: 156 },
      { jobId: job(9218), seq: 3, skillId: skill("Light prep"), title: "Light prep before the lay", scheduledDate: day(2), startTime: "08:00", durationHours: 2, crewSize: 1, status: "offered", payType: "hourly", payAmount: 120 },
      /* Other crew, for the office board */
      { jobId: job(9218), seq: 1, skillId: skill("Carpet removal"), title: "Lift old carpet, 68 m2", areaM2: 68, scheduledDate: day(0), startTime: "06:30", durationHours: 1, crewSize: 1, status: "complete", assignedInstallerId: 4, payType: "per_m2", payAmount: 204, startedAt: at(0, 6, 30), completedAt: at(0, 7, 20) },
      { jobId: job(9221), seq: 1, skillId: skill("Tile removal"), title: "Lift tiles, kitchen and laundry", areaM2: 18, scheduledDate: day(0), startTime: "07:30", durationHours: 5, crewSize: 1, status: "in_progress", assignedInstallerId: 4, payType: "per_m2", payAmount: 396, startedAt: at(0, 7, 35) },
      { jobId: job(9221), seq: 2, skillId: skill("Full prep"), title: "Level and prep subfloor", areaM2: 24, scheduledDate: day(0), startTime: "12:30", durationHours: 4, crewSize: 1, status: "assigned", assignedInstallerId: 2, payType: "hourly", payAmount: 280 },
      { jobId: job(9221), seq: 4, skillId: skill("Silicone"), title: "Silicone perimeter, wet areas", scheduledDate: day(2), startTime: "13:00", durationHours: 2, crewSize: 1, status: "unassigned", payType: "per_job", payAmount: 180 },
    ])
    .returning();
  const task = (title: string) => taskRows.find((t) => t.title === title)!;

  await d.insert(s.taskDays).values(
    taskRows
      .filter((t) => t.scheduledDate)
      .map((t) => ({
        taskId: t.id,
        date: t.scheduledDate!,
        seq: 1,
        arrivalStart: t.startTime,
        arrivalEnd: t.startTime ? `${String(Math.min(23, Number(t.startTime.slice(0, 2)) + 2)).padStart(2, "0")}:${t.startTime.slice(3)}` : null,
        status: t.status === "complete" ? "complete" : "booked",
      })),
  );

  await d.insert(s.taskChecklistItems).values(
    [
      "Subfloor swept and checked",
      "Underlay down and taped",
      "Carpet laid, seams sealed",
      "Doorway trims fitted",
      "Offcuts removed, site vacuumed",
    ].map((label, i) => ({ taskId: task("Lay carpet, 68 m2").id, label, sortOrder: i, required: i !== 3 })),
  );

  await d.insert(s.taskOffers).values([
    { taskId: task("Carpet stairs, 13 steps").id, installerId: mick, mode: "direct", status: "pending", payAmount: 156, expiresAt: inHours(48) },
    { taskId: task("Light prep before the lay").id, installerId: mick, mode: "broadcast", status: "pending", payAmount: 120, expiresAt: inHours(48) },
    { taskId: task("Light prep before the lay").id, installerId: 2, mode: "broadcast", status: "pending", payAmount: 120, expiresAt: inHours(48) },
  ]);

  /* --------------------------------------------- price list and quotes */
  const supplierRows = await d
    .insert(s.suppliers)
    .values([
      { name: "Demo Carpets Pty Ltd", code: "DEMO-CARPET", email: "orders@example.com", deliversDirect: true },
      { name: "Demo Hard Floors", code: "DEMO-HARD", email: "sales@example.com", deliversDirect: false },
    ])
    .returning();
  const carpetSup = supplierRows[0]!;
  const hardSup = supplierRows[1]!;

  const productRows = await d
    .insert(s.products)
    .values([
      { supplierId: carpetSup.id, supplier: carpetSup.name, brand: "Demo", range: "Harbour Twist", colour: "Sand", category: "carpet", unit: "m2", costPrice: 30, sellPrice: 57, variantKey: "demo-harbour-twist-sand" },
      { supplierId: carpetSup.id, supplier: carpetSup.name, brand: "Demo", range: "Harbour Twist", colour: "Slate", category: "carpet", unit: "m2", costPrice: 30, sellPrice: 57, variantKey: "demo-harbour-twist-slate" },
      { supplierId: carpetSup.id, supplier: carpetSup.name, brand: "Demo", range: "Plush Loop", colour: "Oat", category: "carpet", unit: "m2", costPrice: 40, sellPrice: 76, variantKey: "demo-plush-loop-oat" },
      { supplierId: carpetSup.id, supplier: carpetSup.name, brand: "Demo", range: "Comfort Underlay", colour: "10mm", category: "underlay", unit: "m2", costPrice: 6, sellPrice: 11.5, variantKey: "demo-comfort-underlay-10mm" },
      { supplierId: hardSup.id, supplier: hardSup.name, brand: "Demo", range: "Coastal Hybrid", colour: "Natural Oak", category: "hybrid", unit: "m2", costPrice: 35, sellPrice: 67, variantKey: "demo-coastal-hybrid-natural-oak" },
      { supplierId: hardSup.id, supplier: hardSup.name, brand: "Demo", range: "Coastal Hybrid", colour: "Smoked Oak", category: "hybrid", unit: "m2", costPrice: 35, sellPrice: 67, variantKey: "demo-coastal-hybrid-smoked-oak" },
      { supplierId: hardSup.id, supplier: hardSup.name, brand: "Demo", range: "Easy Laminate", colour: "Grey Wash", category: "laminate", unit: "m2", costPrice: 22, sellPrice: 42, variantKey: "demo-easy-laminate-grey-wash" },
    ])
    .returning();
  const prod = (range: string, colour: string) => productRows.find((p) => p.range === range && p.colour === colour)!;

  const quoteLines = (lines: Array<{ p?: (typeof productRows)[number]; kind: string; description: string; qty: number; unit: string; price: number }>) => {
    const subtotal = Math.round(lines.reduce((t, l) => t + l.qty * l.price, 0) * 100) / 100;
    const gst = Math.round(subtotal * 10) / 100;
    return { subtotal, gst, total: Math.round((subtotal + gst) * 100) / 100 };
  };

  const q1Lines = [
    { p: prod("Coastal Hybrid", "Natural Oak"), kind: "supply", description: "Coastal Hybrid, Natural Oak", qty: 96, unit: "m2", price: 67 },
    { kind: "labour", description: "Lay hybrid plank", qty: 96, unit: "m2", price: 27 },
    { kind: "labour", description: "Light prep", qty: 4, unit: "hour", price: 115 },
  ];
  const q2Lines = [
    { p: prod("Harbour Twist", "Sand"), kind: "supply", description: "Harbour Twist carpet, Sand", qty: 82, unit: "m2", price: 57 },
    { p: prod("Comfort Underlay", "10mm"), kind: "supply", description: "Comfort underlay 10mm", qty: 82, unit: "m2", price: 11.5 },
    { kind: "labour", description: "Lay broadloom carpet", qty: 82, unit: "m2", price: 19 },
  ];
  const t1 = quoteLines(q1Lines);
  const t2 = quoteLines(q2Lines);
  const quoteRows = await d
    .insert(s.quotes)
    .values([
      { number: 9501, jobId: job(9229), contactId: c("Priya"), siteId: site("Coomera"), status: "sent", ...t1, depositPercent: 30, validUntil: at(30, 0), sentAt: at(-2, 10), notes: "Demo quote." },
      { number: 9502, jobId: job(9224), companyId: builder!.id, contactId: c("Rick"), siteId: site("Helensvale"), status: "accepted", ...t2, validUntil: at(20, 0), sentAt: at(-9, 9), acceptedAt: at(-6, 15), notes: "Demo quote." },
    ])
    .returning();
  const qItems = (quoteId: number, lines: typeof q1Lines) =>
    lines.map((l, i) => ({
      quoteId,
      productId: l.p?.id ?? null,
      kind: l.kind,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitPrice: l.price,
      unitCost: l.p?.costPrice ?? null,
      total: Math.round(l.qty * l.price * 100) / 100,
      sortOrder: i,
    }));
  await d.insert(s.quoteItems).values([...qItems(quoteRows[0]!.id, q1Lines), ...qItems(quoteRows[1]!.id, q2Lines)]);

  /* --------------------------------------------------------- invoices */
  await d.insert(s.invoices).values([
    { number: 9701, jobId: job(9210), billToContactId: c("Tom"), status: "sent", subtotal: 1800, gst: 180, total: 1980, dueDate: at(13, 0) },
    { number: 9700, jobId: job(9218), billToContactId: c("Kerry"), status: "paid", subtotal: 1127.27, gst: 112.73, total: 1240, amountPaid: 1240, paidAt: at(-8, 11) },
  ]);

  await d.insert(s.activityLog).values([
    { jobId: job(9218), action: "job_created", detail: "Demo job created", actorName: "System" },
    { jobId: job(9218), action: "deposit_paid", detail: "Deposit $1,240 received", actorName: "System" },
    { jobId: job(9210), action: "task_complete", detail: "Mick R. finished the lounge", actorName: "Mick R.", actorRole: "installer" },
  ]);
}
