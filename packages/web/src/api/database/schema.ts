import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, unique, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export * from "./auth-schema";

const now = () => new Date();
const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
};

/* ---------------------------------------------------------------------------
 * Staff / access
 * ------------------------------------------------------------------------- */

/** Links a Better Auth user to a role. Access control is enforced server-side. */
export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().unique(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().default(""),
  /** "admin" = full access · "office" = day-to-day running · "field" (legacy value "installer") = own tasks only */
  role: text("role").notNull().default("field"),
  installerId: integer("installer_id"),
  phone: text("phone"),
  /** Office only: an Admin can switch this on so the person sees cost prices and margins. */
  canSeeCosts: integer("can_see_costs", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

/** Key/value app settings, e.g. installer_can_see_customer_phone. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(now),
});

/* ---------------------------------------------------------------------------
 * People & companies
 * A contact is a person and exists once, forever. Companies are optional
 * wrappers. Billing is decided per job, not per person.
 * ------------------------------------------------------------------------- */

export const companies = sqliteTable(
  "companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    abn: text("abn"),
    /** builder · real_estate · property_manager · insurer · commercial · government · retail · other */
    type: text("type").notNull().default("builder"),
    phone: text("phone"),
    email: text("email"),
    website: text("website"),
    billingAddress: text("billing_address"),
    /** Payment terms in days (0 = due on completion). */
    paymentTerms: integer("payment_terms").notNull().default(14),
    creditLimit: real("credit_limit"),
    /** Deposit % new quotes for this company start at. Null = 0 for a builder, 50 for anyone else. Always beats the contact's. */
    depositPercent: real("deposit_percent"),
    notes: text("notes"),
    /**
     * Blocks the company and everyone under it from any marketing, including a
     * hand written blast. Builders are already barred from journeys by
     * audience, this covers insolvency and fallings out too.
     */
    doNotMarket: integer("do_not_market", { mode: "boolean" }).notNull().default(false),
    doNotMarketReason: text("do_not_market_reason"),
    /** Every job for this company needs a signed SWMS before the crew start. */
    requiresSwms: integer("requires_swms", { mode: "boolean" }).notNull().default(false),
    /** True while a migrated record still needs a human decision. */
    needsReview: integer("needs_review", { mode: "boolean" }).notNull().default(false),
    /** The ServiceM8 company name this came in as. */
    externalRef: text("external_ref"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [index("companies_name_idx").on(t.name)],
);

export const contacts = sqliteTable(
  "contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    mobile: text("mobile"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    suburb: text("suburb"),
    postcode: text("postcode"),
    /** website · phone · hipages · referral · repeat · walk-in · other */
    source: text("source").notNull().default("other"),
    notes: text("notes"),
    /** Deposit % new quotes start at when there is no company on the quote. Null = 50. */
    depositPercent: real("deposit_percent"),
    /** Marketing consent for CRM campaigns (phase 4). */
    marketingOptIn: integer("marketing_opt_in", { mode: "boolean" }).notNull().default(false),
    /**
     * Why we believe we may market to this person. Under the Spam Act inferred
     * consent needs an existing relationship, and a finished job is the
     * strongest version of that.
     *
     *   none          no basis, never enrol
     *   completed_job they paid us for work, Damien's chosen basis
     *   express       they actually ticked a box or asked
     */
    marketingBasis: text("marketing_basis").notNull().default("none"),
    /**
     * A hard block that outranks everything else, including an opt-in and a
     * completed job. Set for Terra's own staff records, insolvent clients, and
     * anyone who asks off. Never cleared by an import.
     */
    doNotMarket: integer("do_not_market", { mode: "boolean" }).notNull().default(false),
    doNotMarketReason: text("do_not_market_reason"),
    /** Last completed job, the clock recency cutoffs are measured against. */
    lastCompletedAt: integer("last_completed_at", { mode: "timestamp" }),
    /**
     * homeowner · trade · unknown. A human's ruling on whether this contact is
     * a private customer or a business, which beats the heuristic in lib/trade.ts.
     *
     * It exists because ServiceM8 filed builder work against the company with
     * contact_id NULL, so the company link cannot answer the question: only two
     * of 1,653 contacts look like trade through their jobs, while real estate
     * agents, shopfitters and a body corporate manager sit in the homeowner
     * pool. Unknown plus a trade signal means held back, not mailed.
     */
    audienceKind: text("audience_kind").notNull().default("unknown"),
    /** Every job for this client needs a signed SWMS before the crew start. */
    requiresSwms: integer("requires_swms", { mode: "boolean" }).notNull().default(false),
    /** True while a migrated record still needs a human decision. */
    needsReview: integer("needs_review", { mode: "boolean" }).notNull().default(false),
    /** The ServiceM8 client name this came in as, for tracing and re-imports. */
    externalRef: text("external_ref"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [index("contacts_name_idx").on(t.lastName, t.firstName), index("contacts_mobile_idx").on(t.mobile)],
);

/** A person's role inside a company. A contact may sit in several companies. */
export const companyContacts = sqliteTable(
  "company_contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyId: integer("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    /** owner · manager · supervisor · accounts · property_manager · purchasing · other */
    role: text("role").notNull().default("other"),
    jobTitle: text("job_title"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (t) => [unique("company_contact_unique").on(t.companyId, t.contactId, t.role)],
);

/** A physical address work happens at. Owned by a contact and/or a company. */
export const sites = sqliteTable(
  "sites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    label: text("label"),
    address: text("address").notNull(),
    suburb: text("suburb").notNull().default(""),
    state: text("state").notNull().default("QLD"),
    postcode: text("postcode"),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    /** Lockbox codes, gate codes, parking, pets, stairs, lift bookings. */
    accessNotes: text("access_notes"),
    propertyType: text("property_type").notNull().default("residential"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("sites_address_idx").on(t.address)],
);

/* ---------------------------------------------------------------------------
 * Skills & installers
 * ------------------------------------------------------------------------- */

/** Editable in Settings — never a hardcoded enum. */
export const skills = sqliteTable("skills", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** carpet · resilient · timber · prep · demolition · trades · other */
  groupName: text("group_name").notNull().default("other"),
  /** Default crew size for tasks of this type. Kept as the dispatch default. */
  defaultCrewSize: integer("default_crew_size").notNull().default(1),
  /** Fewest bodies the work can be done with at all. */
  minCrew: integer("min_crew").notNull().default(1),
  /** What Terra would rather send, when the diary allows it. */
  recommendedCrew: integer("recommended_crew").notNull().default(1),
  /**
   * How much one crew gets through in a day, in `productionUnit`. Drives the
   * duration estimate: quantity ÷ (production rate × crews) = days on site.
   * Null = no estimate, the office puts the days in by hand.
   */
  productionRate: real("production_rate"),
  /** m2 · lm · each · step · hour */
  productionUnit: text("production_unit").notNull().default("m2"),
  /**
   * What each body after the first adds to the day's output, as a percentage.
   * Not 100: two people share a cut station, a room and a doorway, so they run
   * 30 to 40 per cent faster on resilient rather than twice as fast. Carpet
   * scales better, about 80 per cent, since 25lm a day becomes 45lm with two.
   */
  extraCrewUpliftPct: integer("extra_crew_uplift_pct").notNull().default(35),
  /**
   * Days the job sits there that have nothing to do with how big it is.
   * Sanding is the reason this exists: the coats have to dry, so a 50m2 floor
   * and a 120m2 floor both wear the same waiting. Area sets the sanding time,
   * this sets the drying time, and putting a second man on does not dry paint
   * any faster so the crew uplift never touches it.
   */
  fixedDays: real("fixed_days").notNull().default(0),
  /** How many completion photos the crew must add before they can mark it done. */
  minCompletionPhotos: integer("min_completion_photos").notNull().default(4),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

export const installers = sqliteTable("installers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  mobile: text("mobile"),
  email: text("email"),
  /** Better Auth user id once they've accepted their app invite. */
  userId: text("user_id"),
  /** solo · own_offsider · needs_partner */
  crewCapacity: text("crew_capacity").notNull().default("solo"),
  serviceArea: text("service_area"),
  /** JSON array of weekday numbers they don't work, e.g. [0,6]. */
  unavailableDays: text("unavailable_days").notNull().default("[]"),
  /**
   * 1-5, set by hand in the office. 5 and 4 star accept instantly; 3 and below
   * sit provisional while higher stars get first crack.
   */
  starRating: integer("star_rating").notNull().default(3),
  /** Dollar ceiling on materials taken on account. 0 = no account. */
  creditLimit: real("credit_limit").notNull().default(0),
  abn: text("abn"),
  insuranceExpiry: integer("insurance_expiry", { mode: "timestamp" }),
  licenceExpiry: integer("licence_expiry", { mode: "timestamp" }),
  colour: text("colour").notNull().default("#4A7FA5"),
  notes: text("notes"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  /** Set when the person moves to Admin or Office. Card leaves dispatch, history stays. */
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  /**
   * Location sharing. ON-SHIFT ONLY: the app reports a position while a task is
   * in progress and stops the second it's marked complete. Never outside that.
   * Null = never consented, so nothing is ever recorded.
   */
  locationConsentAt: integer("location_consent_at", { mode: "timestamp" }),
  /*
   * Contractor invoicing profile. What goes on the PDF this installer sends
   * Terra for their own pay. Kept separate from Terra's customer-facing
   * business details entirely.
   */
  tradingName: text("trading_name"),
  gstRegistered: integer("gst_registered", { mode: "boolean" }).notNull().default(false),
  businessAddress: text("business_address"),
  invoiceEmail: text("invoice_email"),
  logoUrl: text("logo_url"),
  bankAccountName: text("bank_account_name"),
  bankBsb: text("bank_bsb"),
  bankAccountNumber: text("bank_account_number"),
  /**
   * The next invoice number this installer will be given, in their own
   * sequence. Office-set only. An installer never picks their own number.
   * Null means the office hasn't started this installer's book yet, so they
   * can't submit an invoice.
   */
  nextInvoiceNumber: integer("next_invoice_number"),
  /**
   * Which maps app "Hey Siri, direct me to my next job in Terra" opens.
   * apple · google · waze. Picked by the installer on the Me tab.
   */
  navApp: text("nav_app").notNull().default("apple"),
  ...timestamps,
});

/**
 * Where the crew are, while they're on a job. Every row is tied to the task
 * that was running when it was captured — no task, no ping, by design.
 */
export const installerLocations = sqliteTable(
  "installer_locations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    installerId: integer("installer_id").notNull().references(() => installers.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "set null" }),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    /** Metres of GPS accuracy the phone reported. */
    accuracy: real("accuracy"),
    /** km/h, when the phone gives it. */
    speed: real("speed"),
    capturedAt: integer("captured_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("loc_installer_idx").on(t.installerId, t.capturedAt),
    index("loc_captured_idx").on(t.capturedAt),
  ],
);

/** The tick list: what this installer can do, their rate, and whether they can lead. */
export const installerSkills = sqliteTable(
  "installer_skills",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    installerId: integer("installer_id").notNull().references(() => installers.id, { onDelete: "cascade" }),
    skillId: integer("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
    /**
     * LEGACY. One rate per skill, before the rate book existed. Read nowhere in
     * pricing now, kept so nothing typed in the old screen is lost. Real pay
     * lives in `labourRates`, per work item, effective dated.
     */
    rateType: text("rate_type").notNull().default("per_m2"),
    rate: real("rate"),
    canLead: integer("can_lead", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [unique("installer_skill_unique").on(t.installerId, t.skillId)],
);

/* ---------------------------------------------------------------------------
 * Labour rate book
 *
 * Three ideas, kept apart on purpose:
 *   skills            what Terra can dispatch somebody for (the tick list)
 *   labourRateItems   the priceable work items under a skill, each with a unit
 *   labourRates       what an item pays, effective dated, Terra's default when
 *                     installerId is null and an override when it is set
 *
 * Nothing is ever copied from the default onto an installer. An installer with
 * no override follows Terra's default, so changing the default moves everybody
 * who has not been given their own number. Raising a rate never rewrites the
 * old one: the old row gets an effectiveTo and the new row starts the day after,
 * which is what keeps historical job costing honest.
 * ------------------------------------------------------------------------- */

/** The master list of things Terra pays for. Editable in Settings. */
export const labourRateItems = sqliteTable(
  "labour_rate_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The skill this priced under, so an installer only sees what he's ticked for. */
    skillId: integer("skill_id").references(() => skills.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** carpet · resilient · timber · prep · demolition · trades · surcharge · other */
    groupName: text("group_name").notNull().default("other"),
    /**
     * work      normal labour, priced by the unit
     * surcharge a loading on the labour, usually a percent
     * allowance a flat or per km add on, travel and the like
     */
    kind: text("kind").notNull().default("work"),
    /** m2 · lm · each · step · hour · day · job · percent · km. Never hardcoded. */
    unit: text("unit").notNull().default("m2"),
    /**
     * Percent added to Terra's cost to get the customer price ON THIS ITEM ONLY.
     *
     * Null is the normal case and means "use the standard markup chain" in
     * api/lib/pricing.ts, which comes out at 91.1%. This column exists because
     * a handful of items must NOT carry that: getting rid of the old floor is a
     * pass-through, not work Terra profits on, so Damien's rule is disposal and
     * tip runs go out at cost plus 15% and nothing more. Uplift, the labour of
     * pulling the carpet up, is real work and stays on the full chain.
     *
     * Set it only where the item genuinely prices differently. Every item left
     * null keeps behaving exactly as it did before this column existed.
     */
    markupPercent: real("markup_percent"),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [index("rate_items_group_idx").on(t.groupName), index("rate_items_skill_idx").on(t.skillId)],
);

/** One priced version of one item. Null installer = Terra's standard rate. */
export const labourRates = sqliteTable(
  "labour_rates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id").notNull().references(() => labourRateItems.id, { onDelete: "cascade" }),
    /** Null = Terra default. Set = this installer's own rate for the item. */
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "cascade" }),
    amount: real("amount").notNull(),
    /** Optional floor, e.g. two stairs still pays a call out. */
    minimumCharge: real("minimum_charge"),
    /** YYYY-MM-DD, the day this rate starts applying. */
    effectiveFrom: text("effective_from").notNull(),
    /** YYYY-MM-DD, set when a newer rate supersedes this one. Null = current. */
    effectiveTo: text("effective_to"),
    note: text("note"),
    /** Who changed it, for the history list. */
    createdByName: text("created_by_name").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    index("labour_rates_item_idx").on(t.itemId, t.installerId, t.effectiveFrom),
    index("labour_rates_installer_idx").on(t.installerId),
  ],
);

/**
 * The measured work on a task, in rate book terms: 82m² of broadloom, 14 stairs,
 * 3 hours of prep. Quantities only. What it costs depends on who does it, so the
 * money is never stored here, it is worked out against that installer's card.
 */
export const taskLabourLines = sqliteTable(
  "task_labour_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull().references(() => jobTasks.id, { onDelete: "cascade" }),
    itemId: integer("item_id").notNull().references(() => labourRateItems.id, { onDelete: "cascade" }),
    qty: real("qty").notNull().default(0),
    note: text("note"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("task_labour_task_idx").on(t.taskId), unique("task_labour_unique").on(t.taskId, t.itemId)],
);

/**
 * An installer ticking to say he has seen a rate change. Stored against the
 * date the new rates start, so one tick covers the whole card change.
 */
export const rateAcknowledgements = sqliteTable(
  "rate_acknowledgements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    installerId: integer("installer_id").notNull().references(() => installers.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD the acknowledged card takes effect. */
    effectiveFrom: text("effective_from").notNull(),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    ...timestamps,
  },
  (t) => [unique("rate_ack_unique").on(t.installerId, t.effectiveFrom)],
);

/**
 * Days an installer can't work. Typed in plain English in the office
 * ("can't work Dec 1-17, Japan trip") and parsed into a real blocked range, or
 * a standing rule ("never works weekends") via weekdayMask.
 */
export const installerUnavailability = sqliteTable(
  "installer_unavailability",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    installerId: integer("installer_id").notNull().references(() => installers.id, { onDelete: "cascade" }),
    /** range · recurring */
    kind: text("kind").notNull().default("range"),
    fromDate: text("from_date"),
    toDate: text("to_date"),
    /** JSON array of weekday numbers, 0 = Sunday. Used when kind = recurring. */
    weekdayMask: text("weekday_mask").notNull().default("[]"),
    reason: text("reason").notNull().default(""),
    /** What he typed, kept verbatim so he can see what was parsed. */
    rawText: text("raw_text").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("unavail_installer_idx").on(t.installerId), index("unavail_date_idx").on(t.fromDate, t.toDate)],
);

/**
 * Materials ledger. A charge is glue/leveller taken on account; a payment is
 * money in (weekly invoice settled, or Stripe later). Balance = sum of charges
 * minus payments, checked against installers.creditLimit before a new charge.
 */
export const installerAccountEntries = sqliteTable(
  "installer_account_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    installerId: integer("installer_id").notNull().references(() => installers.id, { onDelete: "cascade" }),
    /** charge · payment · adjustment */
    kind: text("kind").notNull().default("charge"),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "set null" }),
    description: text("description").notNull().default(""),
    qty: real("qty").notNull().default(1),
    unitPrice: real("unit_price").notNull().default(0),
    /** Positive dollars. kind decides the direction. */
    amount: real("amount").notNull().default(0),
    /** on_account · paid_now · invoiced · settled */
    status: text("status").notNull().default("on_account"),
    /** Weekly invoice this charge went out on, e.g. "2026-W36". */
    invoiceRef: text("invoice_ref"),
    settledAt: integer("settled_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [
    index("account_installer_idx").on(t.installerId, t.kind),
    index("account_invoice_idx").on(t.invoiceRef),
  ],
);

/* ---------------------------------------------------------------------------
 * Jobs
 * ------------------------------------------------------------------------- */

/** Editable pipeline — add/rename/reorder in Settings. */
export const jobStatuses = sqliteTable("job_statuses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  colour: text("colour").notNull().default("#7A736D"),
  sortOrder: integer("sort_order").notNull().default(0),
  /** open · won · scheduled · active · complete · closed */
  stage: text("stage").notNull().default("open"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Human job number, e.g. 218. */
    number: integer("number").notNull().unique(),
    title: text("title").notNull().default(""),
    statusId: integer("status_id").references(() => jobStatuses.id, { onDelete: "set null" }),
    siteId: integer("site_id").references(() => sites.id, { onDelete: "set null" }),
    /** Who the work is for. */
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    /** Billing is a separate decision: "company" or "contact". */
    billToType: text("bill_to_type").notNull().default("contact"),
    billToContactId: integer("bill_to_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    billToCompanyId: integer("bill_to_company_id").references(() => companies.id, { onDelete: "set null" }),
    /** Forces crew size 2 on install tasks. */
    furnitureOnSite: integer("furniture_on_site", { mode: "boolean" }).notNull().default(false),
    description: text("description"),
    /** Copied onto task cards for the field. */
    accessNotes: text("access_notes"),
    /** The plan for the job — PDF or photo. Shows on every task card. */
    planUrl: text("plan_url"),
    planName: text("plan_name"),
    planMime: text("plan_mime"),
    source: text("source").notNull().default("other"),
    scheduledStart: integer("scheduled_start", { mode: "timestamp" }),
    value: real("value").notNull().default(0),
    depositAmount: real("deposit_amount").notNull().default(0),
    depositPaid: integer("deposit_paid", { mode: "boolean" }).notNull().default(false),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    /** ServiceM8 job number, kept so history can be traced and re-imported. */
    externalRef: text("external_ref"),
    /** ServiceM8's own job category, e.g. "broadloom carpet install". */
    category: text("category"),
    /** SWMS override for this job. Null follows the client and company, true or false wins. */
    requiresSwms: integer("requires_swms", { mode: "boolean" }),
    /**
     * CALLBACKS. A callback is a normal job linked to the original. Every
     * callback in a chain points at the ORIGINAL job, never at another
     * callback, so the chain is one level deep and easy to list.
     */
    parentJobId: integer("parent_job_id").references((): AnySQLiteColumn => jobs.id, { onDelete: "set null" }),
    /** 1, 2, 3 within the chain. */
    callbackSeq: integer("callback_seq"),
    /**
     * What people see instead of the number, e.g. "3981-C1". Null on normal
     * jobs. Stored, not worked out on read, because the parent's number never
     * changes and every list would otherwise need a join.
     */
    displayNumber: text("display_number"),
    /** installer_error · product_fault · customer_damage · wear_and_tear · warranty · other. Never shown to Crew. */
    callbackCause: text("callback_cause"),
    /** True: quoted and invoiced as normal. False: nothing is billed. Never shown to Crew. */
    callbackChargeable: integer("callback_chargeable", { mode: "boolean" }),
    /** Installer error only: does the installer get paid for the return visit. Decided per callback. */
    callbackPayInstaller: integer("callback_pay_installer", { mode: "boolean" }),
    ...timestamps,
  },
  (t) => [
    index("jobs_status_idx").on(t.statusId),
    index("jobs_site_idx").on(t.siteId),
    index("jobs_external_idx").on(t.externalRef),
    index("jobs_contact_idx").on(t.contactId),
    index("jobs_parent_idx").on(t.parentJobId),
    unique("jobs_display_number_uq").on(t.displayNumber),
  ],
);

/**
 * What fixing a callback cost Terra: labour, replacement product, the return
 * trip. Held against the installer whose work caused it. Tracked and reported
 * only, never charged to the installer's account. Admin only: it is cost.
 */
export const callbackCosts = sqliteTable(
  "callback_costs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    /** The installer the cost is held against: whoever did the original work. */
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "set null" }),
    /** labour · product · trip · other */
    kind: text("kind").notNull().default("labour"),
    description: text("description").notNull().default(""),
    /** Dollars ex GST. */
    amount: real("amount").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("callback_costs_job_idx").on(t.jobId), index("callback_costs_installer_idx").on(t.installerId)],
);

/** Many contacts per job, each with a role and its own comms flags. */
export const jobContacts = sqliteTable(
  "job_contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    /** Legacy single role. Now always the first entry of `tags`, kept so older readers still work. */
    role: text("role").notNull().default("other"),
    /**
     * JSON list of tags this person holds on this job (lib/person-tags.ts):
     * owner · tenant · supervisor · property_manager · builder_contact · accounts · other.
     */
    tags: text("tags").notNull().default("[]"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    /** Site access: the person Crew rings to get in. */
    onSiteContact: integer("on_site_contact", { mode: "boolean" }).notNull().default(false),
    receivesSms: integer("receives_sms", { mode: "boolean" }).notNull().default(false),
    receivesEmail: integer("receives_email", { mode: "boolean" }).notNull().default(false),
    /** Decision-maker: approves colour, product and sign-off. */
    canApproveQuote: integer("can_approve_quote", { mode: "boolean" }).notNull().default(false),
    /**
     * Show to Crew: Crew sees this person on this job (name, number, tags, note).
     * Chosen job by job. Any tag can be shown, Supervisor included.
     */
    showToCrew: integer("show_to_crew", { mode: "boolean" }).notNull().default(false),
    /** When and how to reach them on this job. Crew sees it next to the call button. */
    whenToContact: text("when_to_contact"),
    /** The company they acted for when added. Referral credit stays with it if they move. */
    actedForCompanyId: integer("acted_for_company_id").references(() => companies.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [unique("job_contact_person_uq").on(t.jobId, t.contactId)],
);

/* ---------------------------------------------------------------------------
 * Tasks — the dispatch unit. A job holds many tasks; tasks get assigned.
 * ------------------------------------------------------------------------- */

export const jobTasks = sqliteTable(
  "job_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull().default(1),
    skillId: integer("skill_id").references(() => skills.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    areaM2: real("area_m2"),
    /** The locked-in day. Null until someone accepts and picks a day. */
    scheduledDate: text("scheduled_date"),
    /** Date window the work can land in, e.g. 2026-12-02 → 2026-12-05. */
    scheduledFrom: text("scheduled_from"),
    scheduledTo: text("scheduled_to"),
    /**
     * Out to tender: offers show plan, pay and photos only — no address, no
     * customer name, no phone. Unlocks the moment they win it.
     */
    tenderMode: integer("tender_mode", { mode: "boolean" }).notNull().default(false),
    /** Task-level plan, overrides the job plan when set. */
    planUrl: text("plan_url"),
    planName: text("plan_name"),
    planMime: text("plan_mime"),
    startTime: text("start_time"),
    durationHours: real("duration_hours").notNull().default(4),
    /**
     * Days on site, put in by hand. Set this and it wins over the rate-based
     * recommendation for good, because the office knows about the furniture,
     * the stairs and the parking and the rates do not.
     */
    manualDays: integer("manual_days"),
    /** 1 or 2. Forced to 2 when the job has furniture on site. */
    crewSize: integer("crew_size").notNull().default(1),
    /** unassigned · offered · assigned · in_progress · complete · cancelled */
    status: text("status").notNull().default("unassigned"),
    assignedInstallerId: integer("assigned_installer_id").references(() => installers.id, { onDelete: "set null" }),
    /** Second body when crewSize = 2 and the lead doesn't bring their own. */
    secondInstallerId: integer("second_installer_id").references(() => installers.id, { onDelete: "set null" }),
    payType: text("pay_type").notNull().default("per_job"),
    payAmount: real("pay_amount"),
    /**
     * Labour priced off the rate book the day this task was assigned, and then
     * left alone. A rate rise next year must not quietly rewrite what this job
     * cost, so the numbers are frozen here rather than recalculated on read.
     */
    labourCost: real("labour_cost"),
    /** JSON array of { itemId, name, unit, qty, rate, source, total }. */
    labourBreakdown: text("labour_breakdown"),
    /** YYYY-MM-DD the rates above were read on. */
    labourPricedOn: text("labour_priced_on"),
    startedAt: integer("started_at", { mode: "timestamp" }),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    signatureName: text("signature_name"),
    /**
     * Pre-start damage walk. They either add damage photos or tick "nothing
     * found" — until one of those happens they can't start the job.
     */
    damageCheckedAt: integer("damage_checked_at", { mode: "timestamp" }),
    damageNone: integer("damage_none", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index("tasks_job_idx").on(t.jobId),
    index("tasks_date_idx").on(t.scheduledDate),
    index("tasks_installer_idx").on(t.assignedInstallerId),
  ],
);

/**
 * The days one dispatch is booked for. A three day carpet lay is ONE task with
 * three of these, never three tasks: the labour, the offers, the checklist, the
 * photos and the installer invoice all hang off the task id, so splitting the
 * run into separate tasks would triple every one of them.
 *
 * Day one mirrors `jobTasks.scheduledDate`, and the run mirrors
 * `scheduledFrom`/`scheduledTo`, so anything reading a single date still works.
 */
export const taskDays = sqliteTable(
  "task_days",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull().references(() => jobTasks.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD. Days in a run can skip weekends, so these are not contiguous. */
    date: text("date").notNull(),
    /** 1-based position in the run, for "day 2 of 3" on the installer's phone. */
    seq: integer("seq").notNull().default(1),
    /**
     * The window the customer is told to expect them in, e.g. 07:00 → 11:00.
     * This is what the installer's job card leads with, not the start time.
     */
    arrivalStart: text("arrival_start"),
    arrivalEnd: text("arrival_end"),
    /** No window: the installer and the site sort the time out between them. */
    coordinate: integer("coordinate", { mode: "boolean" }).notNull().default(false),
    /**
     * Covers this one day when it isn't the task's own installer. Null means
     * whoever the task is assigned to, which is the normal case.
     */
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "set null" }),
    /** booked · complete · cancelled */
    status: text("status").notNull().default("booked"),
    /**
     * Set when the office booked over a clash or a day off on purpose. Kept so
     * the reason a double booking exists is on the record, not in someone's head.
     */
    overrideNote: text("override_note"),
    ...timestamps,
  },
  (t) => [
    index("task_days_task_idx").on(t.taskId),
    index("task_days_date_idx").on(t.date),
    index("task_days_installer_idx").on(t.installerId),
    unique("task_days_unique").on(t.taskId, t.date),
  ],
);

/** Direct offers and broadcasts. First accept wins; the rest auto-close. */
export const taskOffers = sqliteTable(
  "task_offers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull().references(() => jobTasks.id, { onDelete: "cascade" }),
    installerId: integer("installer_id").notNull().references(() => installers.id, { onDelete: "cascade" }),
    /** direct · broadcast */
    mode: text("mode").notNull().default("direct"),
    /** pending · provisional · accepted · declined · expired · filled · withdrawn */
    status: text("status").notNull().default("pending"),
    payAmount: real("pay_amount"),
    /**
     * Lower-star installers land on "provisional". If nobody higher takes it by
     * this time it converts to accepted. If a higher star takes it first the
     * holder is told only "this job was already accepted" — never why.
     */
    provisionalUntil: integer("provisional_until", { mode: "timestamp" }),
    /** The day they picked out of the task's date window. */
    chosenDate: text("chosen_date"),
    sentAt: integer("sent_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    respondedAt: integer("responded_at", { mode: "timestamp" }),
    declineReason: text("decline_reason"),
    ...timestamps,
  },
  (t) => [index("offers_task_idx").on(t.taskId), index("offers_installer_idx").on(t.installerId, t.status)],
);

export const taskChecklistItems = sqliteTable(
  "task_checklist_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull().references(() => jobTasks.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    doneAt: integer("done_at", { mode: "timestamp" }),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (t) => [index("checklist_task_idx").on(t.taskId)],
);

export const taskPhotos = sqliteTable(
  "task_photos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "cascade" }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    storageKey: text("storage_key"),
    /** before · during · after · issue · measure */
    kind: text("kind").notNull().default("during"),
    caption: text("caption"),
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("photos_job_idx").on(t.jobId)],
);

/* ---------------------------------------------------------------------------
 * The job file — areas and media. Replaces the ServiceM8 diary: every photo,
 * video or document lands in exactly one named bucket, never a loose feed.
 * ------------------------------------------------------------------------- */

/** A room or zone the work covers. Photos attach to the area, not the job. */
export const jobAreas = sqliteTable(
  "job_areas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    /** Optional: pin the area to one dispatch, e.g. only the tiler's rooms. */
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    areaM2: real("area_m2"),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("areas_job_idx").on(t.jobId)],
);

export const jobMedia = sqliteTable(
  "job_media",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "set null" }),
    areaId: integer("area_id").references(() => jobAreas.id, { onDelete: "set null" }),
    /** plan · access · area · damage · found · completion · defect */
    bucket: text("bucket").notNull().default("area"),
    /** photo · video · doc */
    kind: text("kind").notNull().default("photo"),
    storageKey: text("storage_key").notNull(),
    url: text("url").notNull(),
    filename: text("filename"),
    mime: text("mime"),
    sizeBytes: integer("size_bytes"),
    durationSeconds: real("duration_seconds"),
    caption: text("caption"),
    /** Stamped at capture so nobody has to name a file. */
    capturedLat: real("captured_lat"),
    capturedLng: real("captured_lng"),
    capturedAt: integer("captured_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    uploadedByInstallerId: integer("uploaded_by_installer_id").references(() => installers.id, { onDelete: "set null" }),
    uploadedByProfileId: integer("uploaded_by_profile_id").references(() => profiles.id, { onDelete: "set null" }),
    uploaderName: text("uploader_name"),
    /** Crew can never delete. Admin archives instead — the record survives. */
    archivedAt: integer("archived_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [
    index("media_job_idx").on(t.jobId, t.bucket),
    index("media_task_idx").on(t.taskId),
    index("media_area_idx").on(t.areaId),
  ],
);

/* ---------------------------------------------------------------------------
 * Suppliers
 * One row per supplier Terra buys from. Cost prices are ex-GST unless the row
 * says otherwise. Everything a supplier adds ON TOP of the per-m2 rate —
 * fuel surcharge, baling, freight — is DATA, never a constant in code, because
 * suppliers change these without notice (Terramater's fuel levy went 1.2% -> 2%).
 * ------------------------------------------------------------------------- */

export const suppliers = sqliteTable(
  "suppliers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    /** Short slug used on imports and price-book rows, e.g. "terramater". */
    code: text("code").notNull(),
    accountNumber: text("account_number"),
    phone: text("phone"),
    email: text("email"),
    /** Where stock ships FROM — decides the freight rule, e.g. "South Australia". */
    shipsFrom: text("ships_from"),

    /* ------------------------- fuel surcharge -------------------------
     * SUPERSEDED — DO NOT PUT MONEY THROUGH THESE COLUMNS.
     *
     * These four were built when a fuel surcharge was assumed to be one
     * percentage of the order total, because that is how Terramater charge it.
     * That assumption is wrong across the book: Chaparral charge fuel at
     * $2.00 per LINEAL METRE, which no percentage can express, and a supplier
     * can run a fuel surcharge AND a baling charge at the same time on two
     * different bases.
     *
     * Every charge a supplier adds now lives in `supplierFeeRules` — one row
     * per charge, each with its own basis, amount and dated window. A fuel
     * surcharge is just a rule with `kind: "fuel"`. `resolveSupplierCharges`
     * in api/lib/pricing.ts is the only thing that turns rules into money.
     *
     * The columns are KEPT, not dropped: dropping a column in SQLite rewrites
     * the table, and `fuelSurchargeNote` still holds the history of what
     * Terramater's levy used to be. They are read for DISPLAY only.
     */
    fuelSurchargeActive: integer("fuel_surcharge_active", { mode: "boolean" }).notNull().default(false),
    /** LEGACY. e.g. 2 = 2% of the order total. Not used in any calculation. */
    fuelSurchargePct: real("fuel_surcharge_pct").notNull().default(0),
    /** Free text: what the supplier called it, and what it was before. */
    fuelSurchargeNote: text("fuel_surcharge_note").notNull().default(""),
    fuelSurchargeUpdatedAt: integer("fuel_surcharge_updated_at", { mode: "timestamp" }),

    /* --------------------------- how it gets here ---------------------------
     * Whether the SUPPLIER delivers to Terra decides whether their published
     * delivery charge is Terra's cost at all.
     *
     * Chaparral is the case this exists for. They publish a delivery charge,
     * but Terra's Chaparral stock goes to Jocks Transport as on-forwarder and
     * Terra arranges and pays that leg itself. So their published charge must
     * NEVER auto-apply: putting it in the cost would double-count freight
     * against the carrier invoice Terra actually pays. Big Panda are the same
     * shape for a different reason — they do not deliver at all.
     */
    deliversDirect: integer("delivers_direct", { mode: "boolean" }).notNull().default(true),
    /** How stock actually reaches Terra, e.g. "Jocks Transport / on-forwarder". */
    freightMethod: text("freight_method").notNull().default(""),
    /** Who pays and how it is billed. Plain English, shown on the supplier card. */
    freightNote: text("freight_note").notNull().default(""),

    /* --------------------- conditional cost columns -------------------
     * Armstrong dealer price (credit account + displaying samples) and
     * Karndean display-stand pricing are the same shape: a cheaper column
     * Terra only gets if it qualifies. This flag picks which cost is live. */
    dealerPricingEligible: integer("dealer_pricing_eligible", { mode: "boolean" }).notNull().default(false),
    dealerPricingNote: text("dealer_pricing_note").notNull().default(""),

    /** true = the price list is quoted ex-GST (the normal case). */
    priceListExGst: integer("price_list_ex_gst", { mode: "boolean" }).notNull().default(true),
    /** Date printed on the list Terra is currently quoting off. */
    priceListEffectiveFrom: integer("price_list_effective_from", { mode: "timestamp" }),
    /** Hard expiry, where the supplier states one. Quoting WARNS past this. */
    priceListValidUntil: integer("price_list_valid_until", { mode: "timestamp" }),
    /** Filename of the document the prices were read from — dispute evidence. */
    priceListSource: text("price_list_source").notNull().default(""),
    notes: text("notes").notNull().default(""),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [unique("suppliers_code_uq").on(t.code)],
);

/**
 * Every charge a supplier adds on top of the rate. One row per charge, so a
 * supplier can run SEVERAL AT ONCE on different bases — Chaparral charge
 * $2.00 per lineal metre fuel AND $20.00 per roll baling on the same order,
 * and both have to show up as their own line.
 *
 * Charges are aggregated PER SUPPLIER ORDER, never per estimate line: one $30
 * baling fee no matter how many ranges are on it.
 *
 * A surcharge NEVER gets folded into a product's `costPrice`. Fuel levies come
 * and go, and if one is baked into 400 product rows it cannot be switched off
 * without re-importing the whole price list. The base rate stays the base rate;
 * the surcharge lives here with a date window and a toggle.
 */
export const supplierFeeRules = sqliteTable(
  "supplier_fee_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    /** What the supplier calls it, e.g. "Fuel Surcharge", "Baling Charge". */
    name: text("name").notNull(),
    /** fuel · delivery · handling · baling · storage · cutting · premium · levy · reschedule · credit · other */
    kind: text("kind").notNull().default("other"),
    /**
     * WHAT THE AMOUNT IS CHARGED PER. The whole point of this table: the same
     * kind of charge is quoted on a different basis by every supplier.
     *
     *   percent_of_order  % of the goods total      (Terramater's fuel levy)
     *   m2                $ per square metre
     *   lm                $ per lineal metre        (Chaparral's fuel surcharge)
     *   box               $ per box / carton / pack
     *   roll              $ per roll                (Chaparral's baling charge)
     *   each              $ per item or length
     *   order             flat $ per order
     *   shipment          $ per delivery
     *   pallet            $ per pallet
     *   week              $ per pallet per week     (storage)
     */
    basis: text("basis").notNull().default("order"),
    /** Dollar amount for a fixed fee. NULL when the fee is a percentage. */
    amount: real("amount"),
    /** Percentage for percent_of_order fees, e.g. 15 for a part-roll cutting fee. */
    percent: real("percent"),
    /**
     * What a percentage is worked out on.
     *   goods              the goods only (the normal case)
     *   goods_and_charges  goods plus the other charges on the order, not
     *                      freight. Hurford's work their fuel surcharge out
     *                      this way (invoice 474003: fuel on goods + broken pack).
     * Only ever changed by Damien approving a price check, never by itself.
     */
    percentBase: text("percent_base").notNull().default("goods"),
    /** false = `amount` is ex-GST (the normal case on a supplier schedule). */
    amountIncludesGst: integer("amount_includes_gst", { mode: "boolean" }).notNull().default(false),
    /** A credit, not a charge — Armstrong pays $50 back per crate returned. */
    isCredit: integer("is_credit", { mode: "boolean" }).notNull().default(false),
    /** true = added to every order automatically; false = the office ticks it on. */
    autoApply: integer("auto_apply", { mode: "boolean" }).notNull().default(false),

    /* --------------------------- dated window ---------------------------
     * Plain YYYY-MM-DD text in Brisbane time, both ends INCLUSIVE — the same
     * shape as `productSpecials.startsOn/endsOn`, and for the same reason: a
     * timestamp turns "from 1 June" into 31 May somewhere in the app.
     *
     * effectiveFrom NULL = it already applies, no start date recorded.
     * effectiveUntil NULL = UNTIL FURTHER NOTICE, which is how suppliers
     * actually word a fuel surcharge. It is not an open-ended guess that the
     * charge is permanent, it is the supplier declining to name an end date.
     */
    effectiveFrom: text("effective_from"),
    effectiveUntil: text("effective_until"),

    /** Plain English: when this fee actually bites. Shown next to the tickbox. */
    condition: text("condition").notNull().default(""),
    /** Free text — what the supplier's letter or price list actually said. */
    notes: text("notes").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [index("supplier_fee_supplier_idx").on(t.supplierId, t.sortOrder)],
);

/* ---------------------------------------------------------------------------
 * Products, quotes, invoices
 * ------------------------------------------------------------------------- */

/**
 * One row per BUYABLE VARIANT, not per range.
 *
 * Terramater, Riverhill and Sunstar quote one price for a whole range and the
 * colours inherit it. Airlay and Belgotex do not: the same range costs a
 * different amount on a different backing, width or thickness. So the variant
 * is the unit of price, and a "range" is just a group of variants that share a
 * name. `variantKey` is what an import matches on, because most suppliers give
 * no product code at all.
 *
 * `costPrice` is ALWAYS the supplier's STANDARD price, ex-GST, per `unit`.
 * A clearance or special price NEVER overwrites it — that lives in
 * `productSpecials` with a start and end date, so the standard price is what
 * the app falls back to the moment a special runs out.
 */
export const products = sqliteTable(
  "products",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    supplier: text("supplier").notNull().default(""),
    brand: text("brand").notNull().default(""),
    range: text("range").notNull().default(""),
    colour: text("colour").notNull().default(""),
    /** carpet · carpet_tile · vinyl · hybrid · laminate · timber · underlay · accessory · labour */
    category: text("category").notNull().default("carpet"),
    /** The supplier's own grade band where it has one, e.g. Belgotex PREMIUM / WOOL. */
    tier: text("tier").notNull().default(""),
    /** m2 · lm · each · roll — lm for broadloom and sheet vinyl, which are sold by the metre. */
    unit: text("unit").notNull().default("m2"),

    /* ------------------------- variant dimensions -------------------------
     * Whatever makes this variant cost a different amount from its siblings.
     * Blank where the supplier does not vary price on that axis. */
    /** Carpet-tile and carpet backing, e.g. Flexbac · ProBac · PU Cushion Back. */
    backing: text("backing").notNull().default(""),
    /** As the supplier prints it, e.g. "500 x 500mm", "1227 x 194mm". */
    size: text("size").notNull().default(""),
    /** Roll/broadloom width in metres, e.g. 4.0 or 3.66. Drives lm -> m2. */
    widthM: real("width_m"),
    /**
     * Board/plank/tile LENGTH in mm, parsed out of `size` on purpose.
     * FREIGHT DEPENDS ON IT: Terra's carriers price off a 1.20 m pallet, and
     * Jocks charges more for anything over 1200mm while Unified does not. That
     * call cannot be made off a size string, so it is a real numeric column.
     * For a random-length board this is the MINIMUM length (see `notes`).
     */
    lengthMm: real("length_mm"),
    /** Board/plank/tile width in mm. With `lengthMm` it derives the true `unitM2`. */
    widthMm: real("width_mm"),
    thicknessMm: real("thickness_mm"),
    /** Vinyl wear layer in mm, e.g. 0.55. Spec the customer asks about, not maths. */
    wearLayerMm: real("wear_layer_mm"),
    /** Face weight as printed, e.g. "1200g/m2 / 36oz/yd2". Sales copy, not maths. */
    weight: text("weight").notNull().default(""),

    /* --------------------------- pack arithmetic --------------------------
     * STORE THE INTEGER COUNT AND DERIVE m2. Supplier-printed m2/pack figures
     * are rounded (Sunstar and Airlay both drift), so ordering maths must never
     * be done off `packM2Printed`. */
    unitsPerPack: integer("units_per_pack"),
    /** m2 of ONE tile/board, e.g. 0.25 for a 500x500 tile. */
    unitM2: real("unit_m2"),
    /** The supplier's printed m2/carton, kept only for cross-checking an invoice. */
    packM2Printed: real("pack_m2_printed"),
    /** Cartons on a full pallet, where the supplier states it. Freight maths. */
    boxesPerPallet: integer("boxes_per_pallet"),

    /** Supplier's STANDARD price ex-GST per `unit`. Specials never overwrite it. */
    costPrice: real("cost_price"),
    sellPrice: real("sell_price"),

    /* ----------------------------- roll vs cut ----------------------------
     * Roll goods cost MORE per m2 when the supplier has to cut a part roll.
     * That is not a special and not a fee — it is a different rate on the same
     * product, chosen by the order QUANTITY, so it cannot live in `costPrice`.
     * `resolveRollCut` in api/lib/pricing.ts picks between them.
     *
     * Two shapes, because suppliers do this two different ways:
     *   `cutCostPrice`  Polyflor publishes an explicit per-m2 cut rate.
     *   `cutUpliftPct`  Armstrong adds a percentage on top of the roll rate
     *                   instead (e.g. 15 -> $100 of vinyl bills at $115).
     * Set one or the other, never both. Both null = no cut premium at all. */
    /** Per-`unit` cost ex-GST when buying less than `rollM2`. */
    cutCostPrice: real("cut_cost_price"),
    /** % added to the roll rate for a part roll, where the supplier works that way. */
    cutUpliftPct: real("cut_uplift_pct"),
    /**
     * Quantity on ONE full buying unit, in `unit` — the threshold itself.
     * Roll goods: m2 on one roll, 40 for a 2m x 20m sheet vinyl.
     * Pack goods: sheets in one pack, 75 for Hurfords 7mm plywood.
     */
    rollM2: real("roll_m2"),
    /**
     * Which SHAPE of break this is, because the arithmetic is identical but the
     * words are not. `roll` = a part roll gets cut and cut costs more per m2.
     * `pack` = sheet goods, where a full pack earns the pack rate and anything
     * short of it pays the loose rate (Hurfords plywood: 75 sheets @ $23.95,
     * fewer @ $25.87). Same resolver, different nouns in the quote note —
     * telling a plywood order it is "a cut off the roll" would be nonsense.
     */
    bulkKind: text("bulk_kind").notNull().default("roll"),

    /* ---------------------------- volume break ----------------------------
     * A THIRD rate, cheaper than the roll rate, earned by the SIZE OF THE
     * ORDER rather than by taking a whole roll.
     *
     * MJS publish three numbers on one line of sheet vinyl. Somplan 100 is
     * $20.56/m2 cut, $17.50/m2 a roll, and $16.90/m2 once the order passes
     * 300 m2. The roll/cut pair above cannot hold the third one, because the
     * pair answers "did the supplier have to cut this", and the third answers
     * "how big is the whole order" — two different questions that both move
     * the rate on the same product, and a 400 m2 order answers both at once.
     *
     * Only set this where the supplier PUBLISHES the deeper rate. It is not a
     * special: a special is a temporary buying win Terra keeps as margin, and
     * this is a standing rate any big-enough order earns, so it passes through
     * to the customer the same way a cut premium does.
     *
     * Leave both null on the three MJS accessories whose three price columns
     * print the SAME number — an identical rate is not a break, and seeding it
     * as one would have the app announce a saving of zero dollars.
     */
    /** Per-`unit` cost ex-GST once the order reaches `volumeQty`. */
    volumeCostPrice: real("volume_cost_price"),
    /** Order size in `unit` that earns `volumeCostPrice` — 300 for MJS's over-300m2 rate. */
    volumeQty: real("volume_qty"),
    /** true = no price published; the office has to ring the supplier for a rate. */
    priceOnApplication: integer("price_on_application", { mode: "boolean" }).notNull().default(false),
    /** Minimum the supplier will sell, in `unit` — Belgotex broadloom is 2.0 lm. */
    minOrderQty: real("min_order_qty"),
    /**
     * LAST day this cost is Terra's price, YYYY-MM-DD inclusive. Blank on an
     * open-ended price list, which is most of them.
     *
     * Mitre 10 is not a price list at all — it is a trade QUOTE, and a quote
     * lapses. It is also why this cannot live on the supplier: the structural
     * ply quote runs to 21 Oct 2026 while the mouldings quote (no. 6431308)
     * EXPIRED on 12 Jun 2026, and both are the same supplier. Quoting a
     * customer off a lapsed number is how Terra eats the difference, so the
     * date belongs on the line it governs.
     *
     * A lapsed cost is NOT deleted and the product stays quotable: the office
     * rings the branch for a current number. Nothing here silently reprices.
     */
    priceValidUntil: text("price_valid_until").notNull().default(""),
    /**
     * Trims and stair nosings are sold PER FLOOR RANGE, and a range with no
     * trim genuinely has none — Riverhill confirmed the gaps are real, not
     * missing data. This names the floor range an accessory fits so quoting
     * can never offer a nosing that does not exist. Empty = fits anything.
     */
    fitsRange: text("fits_range").notNull().default(""),
    /** Not stocked — the supplier makes it on order. Changes the promise to the customer. */
    madeToOrder: integer("made_to_order", { mode: "boolean" }).notNull().default(false),
    /**
     * Terra buys this one ahead and keeps it at the warehouse, so a job that
     * uses it must NOT put it on a supplier order. Dunlop Gold foam is the case:
     * it is bought in bulk and pulled off the rack, while the Green foam is
     * ordered per job.
     *
     * This is a flag, not stock control. It says "do not order this, we have
     * it", nothing about how much is left. Counting what is on the rack is a
     * separate job and is not built.
     */
    heldInWarehouse: integer("held_in_warehouse", { mode: "boolean" }).notNull().default(false),
    /** Working days to get it, where the supplier states one (Sunstar custom nosing: 10). */
    leadTimeDays: integer("lead_time_days"),
    /**
     * Soft warning, never a block. Airlay expanded every colour of a range the
     * price list only offered in "selected colours", so the row is quotable but
     * the office checks with the supplier at order time. Damien's call.
     */
    availabilityNote: text("availability_note").notNull().default(""),

    sku: text("sku"),
    /** Composite identity for suppliers that publish no codes. Unique per product. */
    variantKey: text("variant_key").notNull().default(""),
    /** Scanned in the office, scanned again by the installer in the app. */
    barcode: text("barcode"),
    /** What an installer pays for it. Never the customer sell price. */
    installerPrice: real("installer_price"),
    /** Where the colour name or price came from — dispute evidence. */
    sourceNote: text("source_note").notNull().default(""),
    notes: text("notes").notNull().default(""),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("products_range_idx").on(t.brand, t.range),
    index("products_barcode_idx").on(t.barcode),
    index("products_supplier_idx").on(t.supplierId, t.category, t.range),
    unique("products_variant_key_uq").on(t.variantKey),
  ],
);

/**
 * A dated price window on one variant — clearance, run-out, promo.
 *
 * THE POINT OF THIS TABLE: a special has an END DATE, and the day it passes
 * the app quotes the standard `products.costPrice` again with no one having to
 * remember. Nothing rewrites the product row, so there is no cron job that can
 * fail silently and no expired clearance price left sitting in the catalogue.
 * The active special is simply the row whose window contains today.
 *
 * Rows are KEPT, never deleted, so "what was Academia on special for in
 * September" is still answerable next year. Ending one early sets
 * `cancelledAt`; the window stays as it was.
 *
 * Dates are stored as plain YYYY-MM-DD CALENDAR DATES, not timestamps,
 * because a supplier's "clearance ends 30/09/2026" means the whole of that day
 * in Queensland, and a timestamp comparison would expire it hours early.
 * `endsOn` is INCLUSIVE.
 */
export const productSpecials = sqliteTable(
  "product_specials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** What the supplier called it, e.g. "Belgotex clearance", "Run-out". */
    label: text("label").notNull().default("Clearance"),
    /** clearance · run_out · promo · negotiated */
    kind: text("kind").notNull().default("clearance"),
    /** The special COST ex-GST per the product's unit. Sell is recalculated off it. */
    costPriceExGst: real("cost_price_ex_gst").notNull(),
    /** First day the special price applies, YYYY-MM-DD. */
    startsOn: text("starts_on").notNull(),
    /** LAST day it applies, YYYY-MM-DD inclusive. Standard price returns the next day. */
    endsOn: text("ends_on").notNull(),
    /** Set when the office kills a special early. Window is left intact for history. */
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    /**
     * false (default) = Terra keeps the saving as extra margin and the customer
     * price does not move. true = the discount is handed to the customer: new
     * quotes mark up off the special cost for as long as the window is live.
     * Quotes already written are never touched either way.
     */
    passOnToCustomer: integer("pass_on_to_customer", { mode: "boolean" }).notNull().default(false),
    /** Which document the special was read off. */
    source: text("source").notNull().default(""),
    notes: text("notes").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("product_specials_product_idx").on(t.productId, t.endsOn)],
);

export const jobMaterials = sqliteTable(
  "job_materials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "set null" }),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    qty: real("qty").notNull().default(0),
    unit: text("unit").notNull().default("m2"),
    /** to_order · ordered · on_site · installed */
    status: text("status").notNull().default("to_order"),
    ...timestamps,
  },
  (t) => [index("materials_job_idx").on(t.jobId)],
);

export const quotes = sqliteTable(
  "quotes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** One number per quote. Each new version reuses it, so number + version is what is unique. */
    number: integer("number").notNull(),
    version: integer("version").notNull().default(1),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    /** The supervisor who asked for this quote. Optional. Only ever someone at the quote's company. */
    supervisorContactId: integer("supervisor_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    siteId: integer("site_id").references(() => sites.id, { onDelete: "set null" }),
    /** draft · needs_review · sent · accepted · declined · expired */
    status: text("status").notNull().default("draft"),
    subtotal: real("subtotal").notNull().default(0),
    gst: real("gst").notNull().default(0),
    total: real("total").notNull().default(0),
    depositPercent: real("deposit_percent").notNull().default(0),
    /** Highest discount % an Admin has approved for this quote to go out at. */
    discountApprovedPercent: real("discount_approved_percent").notNull().default(0),
    discountApprovedBy: text("discount_approved_by"),
    discountApprovedAt: integer("discount_approved_at", { mode: "timestamp" }),
    validUntil: integer("valid_until", { mode: "timestamp" }),
    notes: text("notes"),
    terms: text("terms"),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    acceptedAt: integer("accepted_at", { mode: "timestamp" }),
    /** combined = one client bundle for the whole quote. split = one per floor type, plus one for other work. */
    bundleMode: text("bundle_mode").notNull().default("combined"),
    ...timestamps,
  },
  (t) => [index("quotes_contact_idx").on(t.contactId), unique("quotes_number_version_unique").on(t.number, t.version)],
);

export const quoteItems = sqliteTable(
  "quote_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quoteId: integer("quote_id").notNull().references(() => quotes.id, { onDelete: "cascade" }),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    /** supply · labour · prep · removal · accessory · other */
    kind: text("kind").notNull().default("supply"),
    description: text("description").notNull(),
    qty: real("qty").notNull().default(1),
    unit: text("unit").notNull().default("m2"),
    unitPrice: real("unit_price").notNull().default(0),
    /** Price book price before anyone hand-edited the line. Null = never edited. The gap is the discount. */
    listUnitPrice: real("list_unit_price"),
    unitCost: real("unit_cost"),
    /** Markup % this line was priced at (cost -> sell). Null on older lines: work it out from cost and sell. */
    markupPercent: real("markup_percent"),
    /** material · labour. Drives split material and labour invoices. Copied from the price book, editable per line. */
    lineType: text("line_type").notNull().default("material"),
    total: real("total").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * True when this line was created without a confident match (voice
     * capture or any other source) and needs a human's eyes before the quote
     * can go out. `flagReason` is a short plain English note of why.
     */
    flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
    flagReason: text("flag_reason"),
    /**
     * The raw, normalised phrase Damien spoke for this line, when it came
     * from a voice capture. Kept so a human's correction (picking the right
     * product) can be learned against the exact words that produced it.
     */
    voicePhrase: text("voice_phrase"),
    /** Which client bundle this line sits in when the quote is split. Null = worked out from product category and kind. */
    floorCategory: text("floor_category"),
    ...timestamps,
  },
  (t) => [index("quote_items_quote_idx").on(t.quoteId)],
);

/** People on a quote, same shape as job_contacts. Copied onto the job on accept or convert. */
export const quoteContacts = sqliteTable(
  "quote_contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quoteId: integer("quote_id").notNull().references(() => quotes.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
    tags: text("tags").notNull().default("[]"),
    canApproveQuote: integer("can_approve_quote", { mode: "boolean" }).notNull().default(false),
    onSiteContact: integer("on_site_contact", { mode: "boolean" }).notNull().default(false),
    receivesSms: integer("receives_sms", { mode: "boolean" }).notNull().default(false),
    receivesEmail: integer("receives_email", { mode: "boolean" }).notNull().default(false),
    /** Show to Crew, carried onto the job with the person. */
    showToCrew: integer("show_to_crew", { mode: "boolean" }).notNull().default(false),
    whenToContact: text("when_to_contact"),
    actedForCompanyId: integer("acted_for_company_id").references(() => companies.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [unique("quote_contact_person_uq").on(t.quoteId, t.contactId)],
);

/* ---------------------------------------------------------------------------
 * Client bundles. The client only ever sees a bundle's title, wording and
 * total. Never qty, m2, rates or line prices.
 * ------------------------------------------------------------------------- */
export const quoteBundles = sqliteTable(
  "quote_bundles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quoteId: integer("quote_id").notNull().references(() => quotes.id, { onDelete: "cascade" }),
    /** 'all' in combined mode, else a floor category or 'extras'. */
    bundleKey: text("bundle_key").notNull(),
    title: text("title").notNull().default(""),
    wording: text("wording").notNull().default(""),
    /** ai · manual · '' (never written) */
    wordingSource: text("wording_source").notNull().default(""),
    /** Signature of the lines the wording was written for. Different from now = stale. */
    lineSignature: text("line_signature").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [unique("quote_bundles_quote_key_uq").on(t.quoteId, t.bundleKey)],
);

/** Quote agent chat, saved per quote. */
export const quoteAgentMessages = sqliteTable(
  "quote_agent_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quoteId: integer("quote_id").notNull().references(() => quotes.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    userName: text("user_name").notNull().default(""),
    /** user · assistant */
    role: text("role").notNull(),
    content: text("content").notNull().default(""),
    /** JSON list of proposed changes the user can Apply. Null = plain answer. */
    proposal: text("proposal"),
    appliedAt: integer("applied_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("quote_agent_messages_quote_idx").on(t.quoteId, t.id)],
);

/* ---------------------------------------------------------------------------
 * Quote price history. One row per product line the moment a quote is SENT, so
 * "what were they last quoted" never depends on a quote that was later edited.
 * Append only. Source 'backfill' rows come from quotes that existed before this
 * table did.
 * ------------------------------------------------------------------------- */

export const quotePriceHistory = sqliteTable(
  "quote_price_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quoteId: integer("quote_id").references(() => quotes.id, { onDelete: "set null" }),
    quoteItemId: integer("quote_item_id"),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    supervisorContactId: integer("supervisor_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    unit: text("unit").notNull().default("m2"),
    unitPrice: real("unit_price").notNull(),
    quotedByName: text("quoted_by_name").notNull().default(""),
    /** quote · backfill */
    source: text("source").notNull().default("quote"),
    quotedAt: integer("quoted_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [
    index("qph_company_product_idx").on(t.companyId, t.productId),
    index("qph_contact_product_idx").on(t.contactId, t.productId),
  ],
);

/* ---------------------------------------------------------------------------
 * Voice quote capture
 * Damien talks on site, the recording and its transcript are kept against the
 * quote it produced, and every draft it makes goes through the SAME quotes /
 * quoteItems tables above, never a shadow copy.
 * ------------------------------------------------------------------------- */

export const voiceQuoteCaptures = sqliteTable(
  "voice_quote_captures",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quoteId: integer("quote_id").references(() => quotes.id, { onDelete: "set null" }),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** Tigris storage key for the original recording. Never deleted. */
    audioKey: text("audio_key").notNull(),
    audioUrl: text("audio_url"),
    durationSeconds: real("duration_seconds"),
    /** Raw Whisper transcript, unedited, kept for playback-and-check. */
    transcript: text("transcript").notNull().default(""),
    /** The structured fields the LLM extracted from the transcript, as JSON. */
    extractedJson: text("extracted_json"),
    /** captured · transcribing · extracting · priced · failed */
    status: text("status").notNull().default("captured"),
    errorMessage: text("error_message"),
    capturedByProfileId: integer("captured_by_profile_id").references(() => profiles.id, { onDelete: "set null" }),
    capturedByName: text("captured_by_name").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("voice_captures_quote_idx").on(t.quoteId)],
);

/**
 * A simple spoken-phrase to product mapping, learned from Damien's own
 * corrections. "Gold foam" said three times and picked to the same underlay
 * product means the fourth time it auto-matches. One flat table, no per
 * business scoping beyond what already exists (Terra only runs the one book).
 */
export const voicePhraseProductMatches = sqliteTable(
  "voice_phrase_product_matches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Lowercased, trimmed, exactly as heard. Matching is deliberately dumb. */
    phrase: text("phrase").notNull(),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    /** How many times Damien has confirmed this exact pairing. */
    confirmCount: integer("confirm_count").notNull().default(1),
    lastConfirmedAt: integer("last_confirmed_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    ...timestamps,
  },
  (t) => [unique("voice_phrase_product_unique").on(t.phrase, t.productId), index("voice_phrase_idx").on(t.phrase)],
);

export const invoices = sqliteTable(
  "invoices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    number: integer("number").notNull().unique(),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
    billToType: text("bill_to_type").notNull().default("contact"),
    billToContactId: integer("bill_to_contact_id").references(() => contacts.id, { onDelete: "set null" }),
    billToCompanyId: integer("bill_to_company_id").references(() => companies.id, { onDelete: "set null" }),
    /** draft · sent · part_paid · paid · overdue · void */
    status: text("status").notNull().default("draft"),
    subtotal: real("subtotal").notNull().default(0),
    gst: real("gst").notNull().default(0),
    total: real("total").notNull().default(0),
    amountPaid: real("amount_paid").notNull().default(0),
    dueDate: integer("due_date", { mode: "timestamp" }),
    /** Phase 3 — set once pushed to Xero / paid via Stripe. */
    xeroInvoiceId: text("xero_invoice_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [index("invoices_job_idx").on(t.jobId)],
);

/* ---------------------------------------------------------------------------
 * CONVERSATIONS
 *
 * A conversation is its own thing. It is not an inbox bolted onto a job, and it
 * is not a per-contact chat log. It is the whole talking history of one piece of
 * work, and it survives that work changing shape.
 *
 * Four rules the rest of the code has to respect:
 *
 *  1. THE QUOTE AND THE JOB SHARE ONE HISTORY. A conversation opens on the
 *     quote. When the quote converts, `jobId` is filled in on the SAME row and
 *     `originQuoteNumber` remembers where it began. A second thread is never
 *     started, because the customer never started a second conversation.
 *
 *  2. THREADING IS DONE ON HEADERS, NOT ON THE SUBJECT LINE. "[Terra #4335]" is
 *     a handle for humans to read and search. Replies are matched on the stored
 *     Message-ID / In-Reply-To / References, so a reply still lands in the right
 *     place after someone's phone mangles the subject.
 *
 *  3. CHANNELS SPLIT WHEN SENDING, MERGE WHEN READING. An internal note and a
 *     customer email are the same shape of record but a different `audience`, so
 *     an internal note physically cannot go out to a customer. Reading is where
 *     they come back together into one timeline.
 *
 *  4. UNASSIGNED IS A REAL STATE. Mail with no job on it opens a conversation
 *     with state "unassigned" instead of being dropped or guessed at. Attaching
 *     it later just sets jobId, so the thread moves in whole.
 *
 * Status is reported honestly. Delivered means the carrier said delivered, read
 * means the crew app genuinely opened it. Email read is NOT tracked and never
 * displayed, because a tracking pixel is a guess dressed up as a fact.
 * ------------------------------------------------------------------------- */

export const conversations = sqliteTable(
  "conversations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The human handle, e.g. "Terra #4335" or "Terra Q-1042". Searchable, never authoritative. */
    ref: text("ref").notNull().default(""),
    subject: text("subject").notNull().default(""),
    /** Filled when the work is a job. Set on conversion, the row is not replaced. */
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    /** Where it began, if it began on a quote. */
    quoteId: integer("quote_id").references(() => quotes.id, { onDelete: "set null" }),
    /** Kept as text so the header still reads right after a quote is deleted. */
    originQuoteNumber: text("origin_quote_number"),
    /** The other side, for the contact-level rollup. */
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    /** unassigned · open · closed */
    state: text("state").notNull().default("open"),
    lastMessageAt: integer("last_message_at", { mode: "timestamp" }),
    lastMessagePreview: text("last_message_preview").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    index("conversations_job_idx").on(t.jobId),
    index("conversations_quote_idx").on(t.quoteId),
    index("conversations_contact_idx").on(t.contactId),
    index("conversations_state_idx").on(t.state, t.lastMessageAt),
  ],
);

/**
 * Who is in the conversation. One row per person per conversation, whatever kind
 * of person they are, so "who was on this thread" is one query and not four.
 * `lastReadAt` is per staff member, which is what an unread count actually means.
 */
export const conversationParticipants = sqliteTable(
  "conversation_participants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** customer · installer · supplier · staff · other */
    role: text("role").notNull().default("customer"),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "set null" }),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    profileId: integer("profile_id").references(() => profiles.id, { onDelete: "set null" }),
    /** Snapshot of how they appeared, so an outside emailer still has a name. */
    name: text("name").notNull().default(""),
    email: text("email"),
    mobile: text("mobile"),
    lastReadAt: integer("last_read_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [
    index("conv_participants_conv_idx").on(t.conversationId),
    index("conv_participants_contact_idx").on(t.contactId),
  ],
);

/**
 * One message, whatever it arrived as. Email, SMS, an internal note, a crew app
 * message: the same table, because the timeline has to read as one story.
 *
 * `audience` is the safety rail. "internal" never leaves the building.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "set null" }),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    /** HOW it travelled: sms · email · note · app */
    channel: text("channel").notNull().default("note"),
    /** WHO it is for: customer · installer · supplier · internal */
    audience: text("audience").notNull().default("internal"),
    /** in · out */
    direction: text("direction").notNull().default("out"),
    subject: text("subject"),
    body: text("body").notNull(),
    /** Original HTML of an inbound email, kept so nothing is lost in the strip-down. */
    bodyHtml: text("body_html"),
    authorName: text("author_name").notNull().default(""),
    authorProfileId: integer("author_profile_id").references(() => profiles.id, { onDelete: "set null" }),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    ccAddress: text("cc_address"),
    /* Real threading, from the real headers. */
    messageIdHeader: text("message_id_header"),
    inReplyTo: text("in_reply_to"),
    referencesHeader: text("references_header"),
    /** The provider's own id: a Resend email id or a ClickSend message id. */
    providerId: text("provider_id"),
    /** queued · sent · delivered · failed · bounced · received. Only ever what the provider said. */
    status: text("status").notNull().default("sent"),
    statusDetail: text("status_detail"),
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
    failedAt: integer("failed_at", { mode: "timestamp" }),
    /** Crew app only. Email is never marked read, because we cannot honestly know. */
    readAt: integer("read_at", { mode: "timestamp" }),
    /** Pinned into "Important job information" so it is not buried by chatter. */
    pinnedAt: integer("pinned_at", { mode: "timestamp" }),
    pinnedLabel: text("pinned_label"),
    pinnedByName: text("pinned_by_name"),
    ...timestamps,
  },
  (t) => [
    index("messages_job_idx").on(t.jobId),
    index("messages_contact_idx").on(t.contactId),
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    index("messages_header_idx").on(t.messageIdHeader),
    index("messages_provider_idx").on(t.providerId),
  ],
);

/**
 * A file that came in on, or went out with, a message. It shows inline in the
 * thread AND is filed into the job's media so it turns up in Job → Files, which
 * is where anyone looks for it six months later. `mediaId` is that link.
 */
export const messageAttachments = sqliteTable(
  "message_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** The same file's row in the job file, when there is a job to file it under. */
    mediaId: integer("media_id").references(() => jobMedia.id, { onDelete: "set null" }),
    filename: text("filename").notNull().default(""),
    mime: text("mime"),
    sizeBytes: integer("size_bytes"),
    storageKey: text("storage_key").notNull().default(""),
    url: text("url").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("message_attachments_message_idx").on(t.messageId)],
);

/**
 * An @mention on an internal note. It notifies one staff member and deep links
 * back to the exact message, not just to the job.
 */
export const messageMentions = sqliteTable(
  "message_mentions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    profileId: integer("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    seenAt: integer("seen_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [index("message_mentions_profile_idx").on(t.profileId, t.seenAt)],
);

/**
 * A variation the CUSTOMER approved, with the message that approved it kept as
 * evidence. Deliberately separate from a crew variation form: that one is the
 * crew describing extra work, this one is proof Terra was told to do it and at
 * what price. In a dispute the source message is the whole argument.
 */
export const variations = sqliteTable(
  "variations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** e.g. V-4335-01 */
    ref: text("ref").notNull().default(""),
    seq: integer("seq").notNull().default(1),
    description: text("description").notNull().default(""),
    amount: real("amount").notNull().default(0),
    /** draft · approved · rejected · invoiced */
    status: text("status").notNull().default("draft"),
    /** The message that IS the approval. The evidence, not a note about it. */
    sourceMessageId: integer("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    /** Snapshotted off the message so the audit trail reads without a join. */
    approvalChannel: text("approval_channel"),
    approvalQuote: text("approval_quote"),
    approvedByName: text("approved_by_name"),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    createdByName: text("created_by_name").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("variations_job_idx").on(t.jobId), unique("variation_ref_unique").on(t.jobId, t.seq)],
);

/**
 * An office follow-up, usually made straight off a message. "Order this
 * tomorrow", "ring them back Monday". It keeps `sourceMessageId` so the task
 * always reads with the sentence that caused it, rather than someone's
 * paraphrase of it a week later.
 */
export const officeTasks = sqliteTable(
  "office_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    /** The message this came out of. The evidence, same idea as a variation. */
    sourceMessageId: integer("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    title: text("title").notNull().default(""),
    detail: text("detail").notNull().default(""),
    assignedProfileId: integer("assigned_profile_id").references(() => profiles.id, { onDelete: "set null" }),
    assignedName: text("assigned_name").notNull().default(""),
    /** YYYY-MM-DD. Null means no date was put on it. */
    dueDate: text("due_date"),
    /** open · done */
    status: text("status").notNull().default("open"),
    createdByName: text("created_by_name").notNull().default(""),
    completedAt: integer("completed_at", { mode: "timestamp" }),
    completedByName: text("completed_by_name"),
    ...timestamps,
    /** When to nudge the assignee's phone. Null is a task with no timed reminder. */
    remindAt: integer("remind_at", { mode: "timestamp" }),
    /** Set once the push has gone, so a reminder fires exactly once. */
    remindedAt: integer("reminded_at", { mode: "timestamp" }),
  },
  (t) => [
    index("office_tasks_job_idx").on(t.jobId),
    index("office_tasks_open_idx").on(t.status, t.dueDate),
    index("office_tasks_assignee_idx").on(t.assignedProfileId, t.status),
  ],
);

/* ---------------------------------------------------------------------------
 * FINANCE — the cashflow engine's inputs.
 *
 * The forecast is not built off invoice due dates. It is built off what has
 * been AGREED, so an accepted job feeds the forecast before anyone invoices
 * anything. That needs three things this section holds:
 *
 *  1. HOW each customer pays, learnt at company level and overridable per job.
 *     A builder on 30 days EOM and a homeowner on 50% deposit produce
 *     completely different cash, off the same contract value.
 *
 *  2. WHAT the job costs and WHEN that money leaves. Material on 30 days EOM
 *     from the supplier, the installer 7 days after his invoice. A job can be
 *     profitable and still need $19,500 of Terra's cash first, and that gap is
 *     the whole reason this exists.
 *
 *  3. HOW CERTAIN each number is. Committed, expected and pipeline money are
 *     never added together as if they were the same thing.
 * ------------------------------------------------------------------------- */

/**
 * A payment structure. One row per company (their standard terms), and one row
 * per job when that job is different. The job row wins.
 *
 * Kept as its own table rather than columns on jobs because a progress-claim
 * structure is a list of claims, not a single number, and because the company
 * default has to be readable on its own to show "Ambrose pays 30 days EOM".
 */
export const paymentTerms = sqliteTable(
  "payment_terms",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Exactly one of these is set. Company = the default, job = the override. */
    companyId: integer("company_id").references(() => companies.id, { onDelete: "cascade" }),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    /**
     * deposit_balance   a deposit up front, the rest on completion (residential)
     * on_completion     one invoice when the work is done
     * progress_claims   claimed in stages, the claims table below
     */
    structure: text("structure").notNull().default("deposit_balance"),
    /** Percent of the contract taken before material is ordered. */
    depositPercent: real("deposit_percent").notNull().default(0),
    /**
     * When the clock starts: invoice · completion.
     * A builder counts from your invoice, a homeowner from the day you finish.
     */
    termsFrom: text("terms_from").notNull().default("invoice"),
    /** Days allowed after that point. */
    termsDays: integer("terms_days").notNull().default(30),
    /**
     * True for "30 days END OF MONTH", which is not 30 days. An invoice on
     * 2 October is not due until 30 November, and that month of drift is
     * exactly what catches people out.
     */
    endOfMonth: integer("end_of_month", { mode: "boolean" }).notNull().default(false),
    /** Percent held back until practical completion or defects liability. */
    retentionPercent: real("retention_percent").notNull().default(0),
    /** Days after completion retention is released. */
    retentionDays: integer("retention_days").notNull().default(0),
    /**
     * What this payer ACTUALLY does, measured, not what they promised. Filled
     * by the engine off paid invoices and added to the predicted date, so a
     * builder who always runs 12 days late is forecast 12 days late.
     */
    observedDaysLate: real("observed_days_late").notNull().default(0),
    notes: text("notes").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    unique("payment_terms_company_unique").on(t.companyId),
    unique("payment_terms_job_unique").on(t.jobId),
  ],
);

/** One stage of a progress-claim structure, e.g. 40% at material delivery. */
export const paymentMilestones = sqliteTable(
  "payment_milestones",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    termsId: integer("terms_id")
      .notNull()
      .references(() => paymentTerms.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull().default(1),
    label: text("label").notNull().default(""),
    percent: real("percent").notNull().default(0),
    /** acceptance · order · delivery · start · completion · fixed_date */
    trigger: text("trigger").notNull().default("completion"),
    /** Days after the trigger the claim goes out. */
    offsetDays: integer("offset_days").notNull().default(0),
    /** Used when trigger is fixed_date. YYYY-MM-DD. */
    onDate: text("on_date"),
    ...timestamps,
  },
  (t) => [index("payment_milestones_terms_idx").on(t.termsId)],
);

/**
 * Money going OUT on a job, and when. One row per commitment: the material
 * order, the installer, a skip bin, a subfloor grinder hire.
 *
 * `dueDate` is what the forecast uses. It is set from the supplier's or
 * installer's own terms when the commitment is created, and can be corrected by
 * hand, because the office often knows better than the rule.
 */
export const jobCosts = sqliteTable(
  "job_costs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    /** materials · installer · other */
    kind: text("kind").notNull().default("materials"),
    description: text("description").notNull().default(""),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "set null" }),
    amount: real("amount").notNull().default(0),
    /**
     * budget    Terra's own estimate, no bill yet. Forecast as expected.
     * committed ordered or the work is booked. Forecast as committed.
     * invoiced  the bill is in, with a real due date.
     * paid      gone. Out of the forecast, into history.
     */
    state: text("state").notNull().default("budget"),
    /** YYYY-MM-DD the cash is expected to leave. */
    dueDate: text("due_date"),
    /** Set true when a human typed the date, so the engine stops moving it. */
    dueDateLocked: integer("due_date_locked", { mode: "boolean" }).notNull().default(false),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    invoiceRef: text("invoice_ref"),
    notes: text("notes").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    index("job_costs_job_idx").on(t.jobId),
    index("job_costs_due_idx").on(t.state, t.dueDate),
  ],
);

/**
 * One predicted movement of cash, in or out, written by the engine.
 *
 * Kept rather than computed on every read so the forecast can be looked back
 * at: what did we think on 1 October, and what actually happened. The engine
 * rebuilds unpaid rows, never touches rows marked actual.
 */
export const cashEvents = sqliteTable(
  "cash_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** in · out */
    direction: text("direction").notNull().default("in"),
    /**
     * committed  agreed work or a placed order. Real money, date may move.
     * expected   accepted but not yet scheduled or ordered.
     * pipeline   a quote nobody has accepted. Never added to the others.
     */
    confidence: text("confidence").notNull().default("expected"),
    /** customer_payment · deposit · progress_claim · retention · materials · installer · other */
    kind: text("kind").notNull().default("customer_payment"),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    quoteId: integer("quote_id").references(() => quotes.id, { onDelete: "cascade" }),
    costId: integer("cost_id").references(() => jobCosts.id, { onDelete: "cascade" }),
    invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "cascade" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    label: text("label").notNull().default(""),
    /** Always positive. `direction` carries the sign. */
    amount: real("amount").notNull().default(0),
    /** YYYY-MM-DD. */
    dueDate: text("due_date").notNull(),
    /** How the date was arrived at, shown in the UI so it can be argued with. */
    basis: text("basis").notNull().default(""),
    /** True once it actually happened. The engine never rewrites these. */
    actual: integer("actual", { mode: "boolean" }).notNull().default(false),
    actualDate: text("actual_date"),
    ...timestamps,
  },
  (t) => [
    index("cash_events_date_idx").on(t.dueDate, t.direction),
    index("cash_events_job_idx").on(t.jobId),
    index("cash_events_conf_idx").on(t.confidence, t.dueDate),
  ],
);

/* ---------------------------------------------------------------------------
 * Forms engine. Templates are editable data in Settings, never hardcoded.
 * Crew fill them on site; the office reviews. A variation submission is
 * described by the crew and PRICED BY THE OFFICE — crew never see or enter
 * a customer price.
 * ------------------------------------------------------------------------- */

export const formTemplates = sqliteTable("form_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  /** variation · prestart · defect · moisture · swms · toolbox · vehicle · custom */
  kind: text("kind").notNull().default("custom"),
  description: text("description").notNull().default(""),
  /** Crew see it on a task only when active. */
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  /** A variation submission lands in the office as a pending item to price. */
  needsOfficeReview: integer("needs_office_review", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

export const formFields = sqliteTable(
  "form_fields",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    templateId: integer("template_id")
      .notNull()
      .references(() => formTemplates.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** text · textarea · number · select · checkbox · photo · signature · date */
    type: text("type").notNull().default("text"),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    helpText: text("help_text").notNull().default(""),
    /** JSON array of choices for select. Blank for every other type. */
    options: text("options").notNull().default("[]"),
    /** Photo answers land in this job-file bucket. */
    mediaBucket: text("media_bucket"),
    unit: text("unit").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("form_fields_template_idx").on(t.templateId)],
);

export const formSubmissions = sqliteTable(
  "form_submissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    templateId: integer("template_id")
      .notNull()
      .references(() => formTemplates.id, { onDelete: "restrict" }),
    /** Snapshot so a later template rename never rewrites history. */
    templateName: text("template_name").notNull().default(""),
    templateKind: text("template_kind").notNull().default("custom"),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "set null" }),
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "set null" }),
    submittedByName: text("submitted_by_name").notNull().default(""),
    submittedAt: integer("submitted_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    /** pending · priced · approved · rejected · closed */
    status: text("status").notNull().default("pending"),
    reviewNote: text("review_note").notNull().default(""),
    reviewedByProfileId: integer("reviewed_by_profile_id").references(() => profiles.id, { onDelete: "set null" }),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [
    index("form_subs_job_idx").on(t.jobId),
    index("form_subs_status_idx").on(t.status),
    index("form_subs_task_idx").on(t.taskId),
  ],
);

export const formAnswers = sqliteTable(
  "form_answers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    submissionId: integer("submission_id")
      .notNull()
      .references(() => formSubmissions.id, { onDelete: "cascade" }),
    fieldId: integer("field_id").references(() => formFields.id, { onDelete: "set null" }),
    /** Snapshot of the question as it was asked. */
    label: text("label").notNull().default(""),
    type: text("type").notNull().default("text"),
    unit: text("unit").notNull().default(""),
    value: text("value").notNull().default(""),
    /** Photo/signature answers point at the job-file record. */
    mediaId: integer("media_id").references(() => jobMedia.id, { onDelete: "set null" }),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("form_answers_sub_idx").on(t.submissionId)],
);

/** Every status change, assignment, offer response and edit. */
export const activityLog = sqliteTable(
  "activity_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "cascade" }),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    entityType: text("entity_type").notNull().default("job"),
    entityId: integer("entity_id"),
    action: text("action").notNull(),
    detail: text("detail").notNull().default(""),
    actorName: text("actor_name").notNull().default("System"),
    actorRole: text("actor_role").notNull().default("system"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("activity_job_idx").on(t.jobId)],
);

/* ---------------------------------------------------------------------------
 * Marketing. Journeys, templates, segments, and a record of every send.
 *
 * THE RULE THAT GOVERNS THIS WHOLE SECTION: automation only ever touches
 * HOMEOWNERS. A contact sitting under a company is a builder, and a builder
 * can never be enrolled in a journey. Builders can still be emailed, but only
 * by hand, as a one-off the office writes and sends itself. That fence is
 * enforced server-side in the marketing routes, not left to whoever is
 * clicking, because a homeowner-worded email landing on a builder who sends
 * Terra forty jobs a year reads badly and cannot be taken back.
 *
 * Marketing goes out as team@terraflooring.com.au. Quotes keep going out as
 * damien@terraflooring.com.au exactly as they always have, and nothing in
 * this section touches them.
 * ------------------------------------------------------------------------- */

/** One automated follow-up sequence. Draft enrols nobody and sends nothing. */
export const journeys = sqliteTable(
  "journeys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /**
     * What puts someone in. Each one reads jobs and quotes Terra already has,
     * so nothing is ever entered twice:
     * job_completed · quote_no_reply · quote_accepted · appointment_booked
     * dormant_12_months · install_anniversary · manual
     */
    trigger: text("trigger").notNull().default("manual"),
    /** Days after the trigger before step one runs. Quote chasing uses this. */
    triggerDelayDays: integer("trigger_delay_days").notNull().default(0),
    /**
     * homeowner · builder. Builder journeys are refused on write. The column
     * exists so the refusal is explicit and auditable rather than implied.
     */
    audience: text("audience").notNull().default("homeowner"),
    /** draft · active · paused. Only active sends. */
    status: text("status").notNull().default("draft"),
    /** Never enrol the same person twice while they are still mid-journey. */
    allowReentry: integer("allow_reentry", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (t) => [index("journeys_status_idx").on(t.status), index("journeys_trigger_idx").on(t.trigger)],
);

/** The steps, in order. A branch points at two of its own siblings. */
export const journeySteps = sqliteTable(
  "journey_steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    journeyId: integer("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    /** email · sms · wait · branch · notify · move_journey · set_tag */
    kind: text("kind").notNull(),
    /** Shown on the canvas card so the office reads intent, not config. */
    label: text("label").notNull().default(""),
    /** email · sms steps point at a template. */
    templateId: integer("template_id").references(() => emailTemplates.id, { onDelete: "set null" }),
    /** SMS body lives inline. A text is one paragraph, a template is overkill. */
    smsBody: text("sms_body").notNull().default(""),
    /** wait steps only. Hours, so "wait 4 hours" and "wait 3 days" are one field. */
    waitHours: integer("wait_hours").notNull().default(0),
    /**
     * branch steps only:
     * opened_email · clicked_link · replied · quote_accepted · job_booked
     * has_mobile · marketing_opt_in
     */
    condition: text("condition").notNull().default(""),
    /** Where each arm goes next. Null ends that arm. */
    yesStepId: integer("yes_step_id"),
    noStepId: integer("no_step_id"),
    /** move_journey steps only. */
    targetJourneyId: integer("target_journey_id").references(() => journeys.id, { onDelete: "set null" }),
    /** Anything the step kind needs beyond the columns above. JSON. */
    config: text("config").notNull().default("{}"),
    ...timestamps,
  },
  (t) => [index("journey_steps_journey_idx").on(t.journeyId, t.sortOrder)],
);

/**
 * One person's run through one journey. This table is the engine's entire
 * memory: where they are, when the next step is due, and why they left.
 */
export const journeyEnrolments = sqliteTable(
  "journey_enrolments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    journeyId: integer("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** The job or quote that triggered it, for context in the office. */
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
    quoteId: integer("quote_id").references(() => quotes.id, { onDelete: "set null" }),
    /** active · finished · exited · failed */
    status: text("status").notNull().default("active"),
    currentStepId: integer("current_step_id").references(() => journeySteps.id, { onDelete: "set null" }),
    /** The worker picks up any active row whose next step is due. */
    nextRunAt: integer("next_run_at", { mode: "timestamp" }),
    /** Plain English, shown in the office: "unsubscribed", "quote accepted". */
    exitReason: text("exit_reason").notNull().default(""),
    enrolledAt: integer("enrolled_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [
    index("enrol_due_idx").on(t.status, t.nextRunAt),
    index("enrol_contact_idx").on(t.contactId),
    index("enrol_journey_idx").on(t.journeyId, t.status),
  ],
);

/** Editable email bodies. Merge fields fill at send time, never hardcoded. */
export const emailTemplates = sqliteTable("email_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  subject: text("subject").notNull().default(""),
  /** Mostly-text on purpose. That is what lands in the inbox. */
  body: text("body").notNull().default(""),
  /** Logo, Terra's details and the unsubscribe line. Off only for a plain reply. */
  useWrapper: integer("use_wrapper", { mode: "boolean" }).notNull().default(true),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

/**
 * A saved list, kept up to date by its own rules. A segment marked builder can
 * never be attached to a journey, only to a one-off send the office writes.
 */
export const segments = sqliteTable("segments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** homeowner · builder */
  audience: text("audience").notNull().default("homeowner"),
  /** JSON rule set: suburbs, product bought, last job window, source. */
  rules: text("rules").notNull().default("{}"),
  /** False for every builder segment, enforced on write. */
  journeyEligible: integer("journey_eligible", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

/**
 * Every email and text that left the building. The audit trail: if a homeowner
 * rings up asking what Terra sent them, the answer is in here, as sent.
 */
export const sends = sqliteTable(
  "sends",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    journeyId: integer("journey_id").references(() => journeys.id, { onDelete: "set null" }),
    stepId: integer("step_id").references(() => journeySteps.id, { onDelete: "set null" }),
    enrolmentId: integer("enrolment_id").references(() => journeyEnrolments.id, { onDelete: "set null" }),
    /** Blasts carry no journey, so the segment is how they are grouped. */
    segmentId: integer("segment_id").references(() => segments.id, { onDelete: "set null" }),
    /** email · sms */
    channel: text("channel").notNull().default("email"),
    /** Snapshot. A later template edit must never rewrite what was sent. */
    toAddress: text("to_address").notNull().default(""),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    /**
     * queued · sent · deferred · failed · bounced
     * deferred is the important one. A send knocked back by the Resend free
     * plan ceiling or an empty ClickSend wallet waits here and goes out
     * tomorrow. It must never silently disappear.
     */
    status: text("status").notNull().default("queued"),
    /** Resend or ClickSend id, for matching webhooks back to this row. */
    providerId: text("provider_id").notNull().default(""),
    failReason: text("fail_reason").notNull().default(""),
    attempts: integer("attempts").notNull().default(0),
    /** AUD. SMS costs real money per message, email does not. */
    cost: real("cost").notNull().default(0),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [
    index("sends_contact_idx").on(t.contactId),
    index("sends_status_idx").on(t.status),
    index("sends_journey_idx").on(t.journeyId),
    index("sends_provider_idx").on(t.providerId),
  ],
);

/** Delivered, opened, clicked, bounced, replied. Fed by Resend webhooks. */
export const emailEvents = sqliteTable(
  "email_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sendId: integer("send_id").references(() => sends.id, { onDelete: "cascade" }),
    /** delivered · opened · clicked · bounced · complained · replied · unsubscribed */
    type: text("type").notNull(),
    /** Which link, for clicks. */
    url: text("url").notNull().default(""),
    /** Bounce detail, so a dead address gets retired instead of retried. */
    detail: text("detail").notNull().default(""),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    ...timestamps,
  },
  (t) => [index("email_events_send_idx").on(t.sendId), index("email_events_type_idx").on(t.type)],
);

/**
 * Opted out, and staying out. Checked before EVERY send with no exceptions,
 * including one-off blasts. Australian spam law is not a preference setting,
 * and the fines are real.
 */
export const unsubscribes = sqliteTable(
  "unsubscribes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Held as the address itself, so a deleted contact cannot resurrect consent. */
    email: text("email").notNull().default(""),
    mobile: text("mobile").notNull().default(""),
    contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    /** email · sms · all */
    channel: text("channel").notNull().default("all"),
    /** Which journey they walked out of, where known. */
    journeyId: integer("journey_id").references(() => journeys.id, { onDelete: "set null" }),
    /** Unguessable token behind the unsubscribe link. One per contact. */
    token: text("token").notNull().default(""),
    /** link · reply_stop · office · bounce · complaint */
    source: text("source").notNull().default("link"),
    ...timestamps,
  },
  (t) => [
    index("unsub_email_idx").on(t.email),
    index("unsub_mobile_idx").on(t.mobile),
    index("unsub_token_idx").on(t.token),
  ],
);

/* ---------------------------------------------------------------------------
 * Native app devices
 * ------------------------------------------------------------------------- */

/**
 * One row per phone signed in to the Terra Ops app, holding the Expo push
 * token that phone is reachable on. The same person can carry two devices, and
 * the same device can be handed to someone else, so the token is the key and
 * the user on it is overwritten on every sign-in.
 */
export const deviceTokens = sqliteTable(
  "device_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Better Auth user the device was last signed in as. */
    userId: text("user_id").notNull(),
    /** Expo push token, e.g. ExponentPushToken[xxx]. Unique per install. */
    token: text("token").notNull(),
    /** ios · android */
    platform: text("platform").notNull().default(""),
    /** Free text off the handset, for working out which phone this is. */
    deviceName: text("device_name").notNull().default(""),
    appVersion: text("app_version").notNull().default(""),
    /** Turned off when Expo reports the token dead, rather than deleted. */
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    ...timestamps,
  },
  (t) => [
    unique("device_token_unique").on(t.token),
    index("device_tokens_user_idx").on(t.userId),
  ],
);

/* ---------------------------------------------------------------------------
 * Subcontractor invoicing
 * The installer's own outgoing invoice to Terra for their pay on a finished
 * task, not Terra's customer-facing invoice. Extras never appear here unless
 * the office already approved them as a variation.
 * ------------------------------------------------------------------------- */

/**
 * An installer asking to be paid for something outside the task's frozen
 * labour lines. Sits pending until the office approves it. Only once approved
 * does it attach to an invoice; nothing here is ever invoiceable on its own.
 */
export const installerVariationRequests = sqliteTable(
  "installer_variation_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => jobTasks.id, { onDelete: "cascade" }),
    installerId: integer("installer_id")
      .notNull()
      .references(() => installers.id, { onDelete: "cascade" }),
    description: text("description").notNull().default(""),
    amount: real("amount").notNull().default(0),
    /** pending · approved · rejected */
    status: text("status").notNull().default("pending"),
    requestedAt: integer("requested_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    decidedByName: text("decided_by_name"),
    adminNotes: text("admin_notes"),
    /** Set once an approved amount has been pulled onto an invoice, so it can't be used twice. */
    invoiceId: integer("invoice_id"),
    ...timestamps,
  },
  (t) => [
    index("installer_var_task_idx").on(t.taskId),
    index("installer_var_installer_idx").on(t.installerId, t.status),
  ],
);

/**
 * The installer's own invoice for a completed task, in their business name,
 * billed to Arclan Pty Ltd t/a Terra Flooring. Every business detail is
 * snapshotted at submission so a later profile edit never rewrites a locked
 * invoice. Immutable to the installer the moment status leaves "submitted".
 */
export const installerInvoices = sqliteTable(
  "installer_invoices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => jobTasks.id, { onDelete: "cascade" }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    installerId: integer("installer_id")
      .notNull()
      .references(() => installers.id, { onDelete: "cascade" }),
    invoiceNumber: integer("invoice_number").notNull(),
    /** submitted · approved · scheduled_for_payment · paid */
    status: text("status").notNull().default("submitted"),
    /* Snapshot of the installer's contractor profile at submission time. */
    tradingName: text("trading_name").notNull().default(""),
    installerName: text("installer_name").notNull().default(""),
    abn: text("abn"),
    gstRegistered: integer("gst_registered", { mode: "boolean" }).notNull().default(false),
    businessAddress: text("business_address"),
    invoiceEmail: text("invoice_email"),
    mobile: text("mobile"),
    logoUrl: text("logo_url"),
    bankAccountName: text("bank_account_name"),
    bankBsb: text("bank_bsb"),
    bankAccountNumber: text("bank_account_number"),
    /* Snapshot of the job the invoice is for, so it reads without a join. */
    jobNumber: integer("job_number").notNull().default(0),
    siteAddress: text("site_address"),
    taskTitle: text("task_title").notNull().default(""),
    /** JSON array of { description, unit, qty, rate, total }, work lines plus approved extras. */
    lineItems: text("line_items").notNull().default("[]"),
    subtotal: real("subtotal").notNull().default(0),
    gstAmount: real("gst_amount").notNull().default(0),
    total: real("total").notNull().default(0),
    /** Storage key for the generated PDF. */
    pdfKey: text("pdf_key"),
    /**
     * Did the invoice actually REACH Terra. Submitting writes the row and the
     * PDF, emailing it is a separate thing that can fail on its own, and an
     * invoice nobody received is not a submitted invoice. Null means the email
     * never went, so the app can say so and offer to send it again.
     */
    emailedToTerraAt: integer("emailed_to_terra_at", { mode: "timestamp" }),
    emailedToInstallerAt: integer("emailed_to_installer_at", { mode: "timestamp" }),
    /** Why the last send failed, in the provider's own words. */
    emailError: text("email_error"),
    confirmedAt: integer("confirmed_at", { mode: "timestamp" }),
    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    scheduledAt: integer("scheduled_at", { mode: "timestamp" }),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    adminNotes: text("admin_notes"),
    ...timestamps,
  },
  (t) => [
    unique("installer_invoice_task_unique").on(t.taskId, t.installerId),
    unique("installer_invoice_number_unique").on(t.installerId, t.invoiceNumber),
    index("installer_invoices_installer_idx").on(t.installerId, t.status),
    index("installer_invoices_job_idx").on(t.jobId),
    index("installer_invoices_status_idx").on(t.status),
  ],
);

/* ---------------------------------------------------------------------------
 * Hands-free crew: site visits and Siri.
 * ------------------------------------------------------------------------- */

/**
 * One stretch of time an installer spent at a job site. The phone stamps these
 * itself when it crosses the circle round the site (geofence), or the installer
 * taps Arrived and Left site by hand when they have not allowed "Always"
 * location. A three day lay with a lunch run each day is six visits.
 *
 * Arriving never starts the task. It is a time stamp for the office, nothing
 * more: the damage walk and the Start tap stay with the installer.
 */
export const siteVisits = sqliteTable(
  "site_visits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull().references(() => jobTasks.id, { onDelete: "cascade" }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    installerId: integer("installer_id").notNull().references(() => installers.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD, Gold Coast time, of the arrival. The day the photo rule is checked against. */
    visitDate: text("visit_date").notNull(),
    arrivedAt: integer("arrived_at", { mode: "timestamp" }).notNull(),
    leftAt: integer("left_at", { mode: "timestamp" }),
    /** geofence · manual */
    arriveSource: text("arrive_source").notNull().default("manual"),
    leaveSource: text("leave_source"),
    /**
     * Set when a geofence visit is too short to be real, e.g. driving past or
     * parking down the street. Kept, not deleted, so a bad fence can be seen.
     */
    voidedAt: integer("voided_at", { mode: "timestamp" }),
    voidReason: text("void_reason"),
    /** When the office was told they had arrived. Once per visit. */
    announcedAt: integer("announced_at", { mode: "timestamp" }),
    /** left_without_completion_photos, or null. */
    flag: text("flag"),
    /** Photos that day against what the trade needs, at the moment they left. */
    photosHad: integer("photos_had"),
    photosNeeded: integer("photos_needed"),
    /** Cleared by the photos turning up that day, or by them coming back. */
    flagClearedAt: integer("flag_cleared_at", { mode: "timestamp" }),
    flagClearedReason: text("flag_cleared_reason"),
    ...timestamps,
  },
  (t) => [
    index("site_visits_task_idx").on(t.taskId, t.visitDate),
    index("site_visits_installer_idx").on(t.installerId, t.arrivedAt),
    index("site_visits_flag_idx").on(t.flag),
  ],
);

/**
 * Every Siri action that does something: a text, a call, a note. Siri reads
 * back what it is about to do, and only a "yes" within two minutes makes it
 * happen. The read back and the answer are both kept, so "I never sent that"
 * can be settled.
 */
export const voiceActions = sqliteTable(
  "voice_actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** sha256 of the one-time confirm code. The code itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    installerId: integer("installer_id").notNull().references(() => installers.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "set null" }),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** late_client · late_office · call_contact · call_office · note */
    kind: text("kind").notNull(),
    /** Exactly what Siri said back to them. */
    readBack: text("read_back").notNull(),
    /** JSON: the text body, the number, the minutes. What confirm acts on. */
    payload: text("payload").notNull().default("{}"),
    /** pending · confirmed · cancelled · expired · failed */
    status: text("status").notNull().default("pending"),
    /** yes · no · silence, as the phone reported it. */
    answer: text("answer"),
    resultDetail: text("result_detail"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    answeredAt: integer("answered_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [
    unique("voice_actions_token_unique").on(t.tokenHash),
    index("voice_actions_installer_idx").on(t.installerId, t.createdAt),
  ],
);

/**
 * A key per phone, so Siri can reach Terra while the app is closed and the
 * phone is in a pocket. Only a hash is stored. Revoking one cuts that phone
 * off Siri straight away without signing anyone out of the app.
 */
export const voiceKeys = sqliteTable(
  "voice_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    installerId: integer("installer_id").notNull().references(() => installers.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    keyHash: text("key_hash").notNull(),
    deviceName: text("device_name").notNull().default(""),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [unique("voice_keys_hash_unique").on(t.keyHash), index("voice_keys_installer_idx").on(t.installerId)],
);

/* ---------------------------------------------------------------------------
 * Purchasing and supplier invoices.
 *
 * A PO is raised from a job in Ops and numbered off the job: 4113-A, 4113-B.
 * The supplier is asked to quote that number and send the invoice to
 * billing@. The email agent reads billing@ (and damien@, read only), pulls
 * each invoice and statement apart, and matches the invoice to its PO.
 *
 * Costs on a PO are what Terra PAYS, so a live special lowers them. That is
 * the buying side of the pricing rule: the customer's sell price never moves.
 * ------------------------------------------------------------------------- */

export const purchaseOrders = sqliteTable(
  "purchase_orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** "4113-A". Job number plus a letter, unique for ever. */
    number: text("number").notNull(),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "restrict" }),
    supplierId: integer("supplier_id").notNull().references(() => suppliers.id, { onDelete: "restrict" }),
    /** draft · sent · invoiced · cancelled */
    status: text("status").notNull().default("draft"),
    /** warehouse · site */
    deliverTo: text("deliver_to").notNull().default("warehouse"),
    deliveryAddress: text("delivery_address").notNull().default(""),
    goodsExGst: real("goods_ex_gst").notNull().default(0),
    /** Supplier charges that are not freight: fuel levy, cutting, baling. */
    chargesExGst: real("charges_ex_gst").notNull().default(0),
    freightExGst: real("freight_ex_gst").notNull().default(0),
    totalExGst: real("total_ex_gst").notNull().default(0),
    notes: text("notes").notNull().default(""),
    /** JSON: { pickedFeeIds, rolls, pallets, boxes }. What the charges were worked off, so a re-price agrees. */
    pricingInputs: text("pricing_inputs").notNull().default("{}"),
    /** email · other (phoned, portal). How it reached the supplier. */
    sentVia: text("sent_via"),
    sentTo: text("sent_to"),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    /** The forecast line this PO feeds. */
    jobCostId: integer("job_cost_id").references(() => jobCosts.id, { onDelete: "set null" }),
    createdByProfileId: integer("created_by_profile_id").references(() => profiles.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    unique("purchase_orders_number_unique").on(t.number),
    index("purchase_orders_job_idx").on(t.jobId),
    index("purchase_orders_supplier_idx").on(t.supplierId, t.status),
  ],
);

export const purchaseOrderLines = sqliteTable(
  "purchase_order_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    poId: integer("po_id").notNull().references(() => purchaseOrders.id, { onDelete: "cascade" }),
    jobMaterialId: integer("job_material_id").references(() => jobMaterials.id, { onDelete: "set null" }),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    /** goods · charge (fuel, baling, handling) · freight */
    kind: text("kind").notNull().default("goods"),
    description: text("description").notNull(),
    qty: real("qty").notNull().default(0),
    unit: text("unit").notNull().default("m2"),
    unitCostExGst: real("unit_cost_ex_gst").notNull().default(0),
    totalExGst: real("total_ex_gst").notNull().default(0),
    /** Standard cost when a special made this line cheaper. Shown, never charged. */
    standardUnitCostExGst: real("standard_unit_cost_ex_gst"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("po_lines_po_idx").on(t.poId)],
);

/**
 * A Google mailbox the agent may read. Only three addresses are ever allowed,
 * fixed in code (lib/gmail.ts). `canSend` is true for team@ only and is
 * re-checked in code on every send, never trusted from this row alone.
 */
export const mailAccounts = sqliteTable(
  "mail_accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    address: text("address").notNull(),
    canSend: integer("can_send", { mode: "boolean" }).notNull().default(false),
    /** AES-GCM sealed with MAIL_TOKEN_KEY. Never returned by any route. */
    refreshTokenSealed: text("refresh_token_sealed"),
    /** Space separated, exactly what Google granted. */
    scopes: text("scopes").notNull().default(""),
    /** epoch seconds of the newest message already looked at. */
    syncedThrough: integer("synced_through"),
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
    lastError: text("last_error"),
    connectedByProfileId: integer("connected_by_profile_id").references(() => profiles.id, { onDelete: "set null" }),
    connectedAt: integer("connected_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (t) => [unique("mail_accounts_address_unique").on(t.address)],
);

/** Every email the agent has opened, so nothing is read twice. */
export const mailMessages = sqliteTable(
  "mail_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id").notNull().references(() => mailAccounts.id, { onDelete: "cascade" }),
    gmailId: text("gmail_id").notNull(),
    threadId: text("thread_id"),
    fromAddress: text("from_address").notNull().default(""),
    subject: text("subject").notNull().default(""),
    receivedAt: integer("received_at", { mode: "timestamp" }),
    /** done · skipped · error */
    status: text("status").notNull().default("done"),
    /** What was found: "2 invoices, 1 statement", or why it was skipped. */
    note: text("note").notNull().default(""),
    attempts: integer("attempts").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique("mail_messages_account_gmail_unique").on(t.accountId, t.gmailId),
    index("mail_messages_status_idx").on(t.status),
  ],
);

export const supplierInvoices = sqliteTable(
  "supplier_invoices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    /** The name exactly as printed, kept for when no supplier matched. */
    supplierNameRaw: text("supplier_name_raw").notNull().default(""),
    invoiceNumber: text("invoice_number").notNull(),
    /** supplier id (or squashed name) + squashed invoice number. One row per real invoice. */
    dedupeKey: text("dedupe_key").notNull(),
    /** invoice · credit */
    docType: text("doc_type").notNull().default("invoice"),
    /** The order reference as printed, before any matching. */
    poRefRaw: text("po_ref_raw"),
    /** Other references printed (customer order no, delivery docket, job). Read for bare job numbers. */
    otherRefs: text("other_refs"),
    poId: integer("po_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
    invoiceDate: text("invoice_date"),
    dueDate: text("due_date"),
    goodsExGst: real("goods_ex_gst"),
    freightExGst: real("freight_ex_gst"),
    totalExGst: real("total_ex_gst"),
    gst: real("gst"),
    totalIncGst: real("total_inc_gst").notNull().default(0),
    /** JSON array of the printed lines: description, qty, unit, unitPrice, total. */
    lines: text("lines").notNull().default("[]"),
    /**
     * matched     ties to its PO and the money agrees
     * different   ties to its PO but the money does not
     * needs_you   could not be tied to a PO with confidence
     */
    matchStatus: text("match_status").notNull().default("needs_you"),
    /** How it was matched or why not, in plain words. */
    matchNote: text("match_note").notNull().default(""),
    /** Invoice ex-GST minus PO ex-GST. Positive = charged more than ordered. */
    diffExGst: real("diff_ex_gst"),
    /** unpaid · paid */
    payState: text("pay_state").notNull().default("unpaid"),
    paidNote: text("paid_note").notNull().default(""),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    /** Someone looked at a difference or a no-PO invoice and okayed it. Takes it off "Needs you". */
    checkedAt: integer("checked_at", { mode: "timestamp" }),
    checkedBy: text("checked_by"),
    pdfKey: text("pdf_key"),
    pdfName: text("pdf_name"),
    mailMessageId: integer("mail_message_id").references(() => mailMessages.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    unique("supplier_invoices_dedupe_unique").on(t.dedupeKey),
    index("supplier_invoices_supplier_idx").on(t.supplierId, t.payState),
    index("supplier_invoices_po_idx").on(t.poId),
    index("supplier_invoices_match_idx").on(t.matchStatus),
  ],
);

export const supplierStatements = sqliteTable(
  "supplier_statements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    supplierNameRaw: text("supplier_name_raw").notNull().default(""),
    statementDate: text("statement_date"),
    balanceIncGst: real("balance_inc_gst"),
    overdueIncGst: real("overdue_inc_gst"),
    /** JSON array: invoiceNumber, date, amount (inc GST, negative for credits). */
    lines: text("lines").notNull().default("[]"),
    pdfKey: text("pdf_key"),
    pdfName: text("pdf_name"),
    mailMessageId: integer("mail_message_id").references(() => mailMessages.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("supplier_statements_supplier_idx").on(t.supplierId, t.statementDate)],
);

/**
 * "Please send invoice X to billing@." Written by the agent when a statement
 * lists an invoice Ops never received. Always sent from team@.
 */
export const invoiceRequests = sqliteTable(
  "invoice_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    supplierNameRaw: text("supplier_name_raw").notNull().default(""),
    invoiceNumber: text("invoice_number").notNull(),
    /** Same key as supplier_invoices.dedupe_key, so a received invoice closes its request. */
    dedupeKey: text("dedupe_key").notNull(),
    invoiceDate: text("invoice_date"),
    amountIncGst: real("amount_inc_gst"),
    statementId: integer("statement_id").references(() => supplierStatements.id, { onDelete: "set null" }),
    toAddress: text("to_address"),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    /** waiting_ok · sent · received · cancelled · no_email */
    status: text("status").notNull().default("waiting_ok"),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    gmailMessageId: text("gmail_message_id"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    unique("invoice_requests_dedupe_unique").on(t.dedupeKey),
    index("invoice_requests_status_idx").on(t.status),
  ],
);

/**
 * PRICE CHECKS. A supplier invoice that bills a different rate from the Ops
 * price list or the supplier's charge rules: a product price, a fuel
 * surcharge, a broken pack or baling fee, freight.
 *
 * Nothing here ever changes a price by itself. Each row waits for Damien.
 * Approve changes that one rate and logs it against the invoice. Ignore leaves
 * the price list alone. A special or clearance price on an invoice is never
 * offered as a price list change, because specials never move the sell price.
 */
export const priceFlags = sqliteTable(
  "price_flags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    invoiceId: integer("invoice_id").notNull().references(() => supplierInvoices.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    /**
     * product_cost    standard cost on the invoice is not the price list's (can approve)
     * special_missed  billed at standard while Ops has a live special (chase a credit)
     * invoice_special billed under the price list as a special (extra margin, info)
     * product_other   rate differs but cannot be pinned to one price (info)
     * fee_amount      flat or per-unit charge differs (can approve)
     * fee_percent     percentage differs (can approve)
     * fee_basis       same percentage, worked out on a different base (can approve)
     * freight         freight billed that Ops did not expect (info)
     * new_charge      a charge Ops has no rule for (info)
     * missing_charge  an Ops surcharge the invoice did not bill (info)
     */
    kind: text("kind").notNull(),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    feeRuleId: integer("fee_rule_id").references(() => supplierFeeRules.id, { onDelete: "set null" }),
    /** The invoice line as printed. */
    lineText: text("line_text").notNull().default(""),
    /** What Ops has, and what the invoice billed, in the same unit. */
    opsValue: real("ops_value"),
    invoiceValue: real("invoice_value"),
    /** "m2", "%", "order". What the two values are per. */
    unit: text("unit").notNull().default(""),
    qty: real("qty"),
    /** What the difference costs on this invoice, ex GST. Positive = billed more. */
    impactExGst: real("impact_ex_gst").notNull().default(0),
    title: text("title").notNull().default(""),
    detail: text("detail").notNull().default(""),
    /** JSON of what Approve would change. Null when there is nothing to change. */
    change: text("change"),
    /** open · approved · ignored */
    status: text("status").notNull().default("open"),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
    decidedBy: text("decided_by"),
    /** What Approve actually did, in plain words. */
    outcome: text("outcome").notNull().default(""),
    /** invoice + kind + product or rule. One flag per thing per invoice. */
    dedupeKey: text("dedupe_key").notNull(),
    ...timestamps,
  },
  (t) => [
    unique("price_flags_dedupe_unique").on(t.dedupeKey),
    index("price_flags_status_idx").on(t.status),
    index("price_flags_invoice_idx").on(t.invoiceId),
  ],
);

/* ---------------------------------------------------------------------------
 * SWMS and the safety document library.
 *
 * A SWMS is signed per worker, per job, per work day. The first one on a job
 * is the full review; later days start from it and are re-confirmed and signed
 * again. The content is a frozen snapshot of what was ticked, so editing the
 * hazard library later never rewrites a signed record.
 * ------------------------------------------------------------------------- */

export const safetyDocs = sqliteTable(
  "safety_docs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Which library item this is, e.g. "acouslime-3in1". See lib/swms-library.ts. */
    code: text("code").notNull(),
    product: text("product").notNull(),
    supplier: text("supplier").notNull().default(""),
    /** sds · pds (a product data sheet is kept, but never counts as the SDS) */
    kind: text("kind").notNull().default("sds"),
    revision: text("revision").notNull().default(""),
    issuedOn: text("issued_on"),
    /** AU or NZ. An NZ sheet is flagged until the Australian one is on file. */
    region: text("region").notNull().default("AU"),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull().default(""),
    sizeBytes: integer("size_bytes"),
    notes: text("notes").notNull().default(""),
    /** Replaced sheets are kept for old records, just not attached to new ones. */
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    uploadedByName: text("uploaded_by_name").notNull().default(""),
    /** YYYY-MM-DD. When the sheet is due for review. Blank means 5 years after issue. */
    reviewOn: text("review_on"),
    ...timestamps,
  },
  (t) => [index("safety_docs_code_idx").on(t.code, t.active)],
);

export const swmsRecords = sqliteTable(
  "swms_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "set null" }),
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "set null" }),
    installerName: text("installer_name").notNull().default(""),
    /** Gold Coast date the SWMS covers. */
    workDate: text("work_date").notNull(),
    /** full · reconfirm */
    kind: text("kind").notNull().default("full"),
    basedOnId: integer("based_on_id"),
    siteAddress: text("site_address").notNull().default(""),
    /** JSON snapshot: common hazards and flooring sections, each item ticked or not. */
    content: text("content").notNull().default("{}"),
    customHazard: text("custom_hazard").notNull().default(""),
    signedName: text("signed_name").notNull(),
    /** JSON strokes from the phone, drawn into the PDF by the server. */
    signature: text("signature").notNull().default("{}"),
    /** JSON array of safety_docs ids attached at signing. */
    sdsDocIds: text("sds_doc_ids").notNull().default("[]"),
    pdfKey: text("pdf_key"),
    signedAt: integer("signed_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    /** Where the phone was at signing (Stage 3). Null on older signings. */
    gpsLat: real("gps_lat"),
    gpsLng: real("gps_lng"),
    /** Metres. */
    gpsAccuracy: real("gps_accuracy"),
    /** ok · denied · timeout · unavailable · not_sent (an older app). Null before Stage 3. */
    gpsStatus: text("gps_status"),
    /** JSON list of { checkId, question, answer, flagged, blocks, cleared }. */
    siteAnswers: text("site_answers"),
    ...timestamps,
  },
  (t) => [index("swms_job_day_idx").on(t.jobId, t.workDate), index("swms_installer_idx").on(t.installerId, t.workDate)],
);

/* ---------------------------------------------------------------------------
 * SWMS content, edited in Ops (Stage 2).
 *
 * Task blocks are written once and shared by templates. A template is an
 * ordered list of blocks. Edits are a draft until someone publishes, which
 * freezes the whole template, blocks included, into swms_template_versions.
 * Crew only ever sees the latest published version. Signed records keep their
 * own copy, so nothing here ever rewrites a signed SWMS.
 * ------------------------------------------------------------------------- */

export const sdsProducts = sqliteTable("sds_products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Matches safety_docs.code and the sds field on block items. */
  code: text("code").notNull().unique(),
  product: text("product").notNull(),
  supplier: text("supplier").notNull().default(""),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

export const swmsBlocks = sqliteTable("swms_blocks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  title: text("title").notNull(),
  /** What the task is, one line. */
  task: text("task").notNull().default(""),
  /** JSON array of PPE names. */
  ppe: text("ppe").notNull().default("[]"),
  /** JSON array of { id, label, controls, riskBefore, riskAfter, sds }. Item ids never change. */
  items: text("items").notNull().default("[]"),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  updatedByName: text("updated_by_name").notNull().default(""),
  ...timestamps,
});

export const swmsTemplates = sqliteTable("swms_templates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Stable key. Signed records and the phone refer to the template by it. */
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  workType: text("work_type").notNull().default(""),
  activity: text("activity").notNull().default(""),
  /** JSON array of PPE names, on top of the blocks' own. */
  ppe: text("ppe").notNull().default("[]"),
  /** JSON array of swms_blocks ids, in order. */
  blockIds: text("block_ids").notNull().default("[]"),
  /** The 8 every-job hazards. Shown on every SWMS, never picked. */
  everyJob: integer("every_job", { mode: "boolean" }).notNull().default(false),
  /** JSON array of words matched against the labour names on the job. Applies straight away. */
  matchTerms: text("match_terms").notNull().default("[]"),
  /** JSON array matched against the job category, only when no labour matched anything. */
  categoryTerms: text("category_terms").notNull().default("[]"),
  /** JSON array of other template keys this one always brings in. */
  alsoAdds: text("also_adds").notNull().default("[]"),
  /** On first publish, this template takes the matching words of that one, and archives it once it has none left. */
  replacesKey: text("replaces_key"),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  updatedByName: text("updated_by_name").notNull().default(""),
  ...timestamps,
});

export const swmsTemplateVersions = sqliteTable(
  "swms_template_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    templateId: integer("template_id")
      .notNull()
      .references(() => swmsTemplates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** JSON. The template with its blocks, frozen at publish. */
    content: text("content").notNull(),
    whatChanged: text("what_changed").notNull().default(""),
    publishedByName: text("published_by_name").notNull().default(""),
    publishedAt: integer("published_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    reviewedByName: text("reviewed_by_name").notNull().default(""),
    reviewedByQualification: text("reviewed_by_qualification").notNull().default(""),
    reviewedOn: text("reviewed_on"),
  },
  (t) => [unique("swms_template_versions_uq").on(t.templateId, t.version)],
);

export const swmsSiteChecks = sqliteTable("swms_site_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  question: text("question").notNull(),
  /** JSON array from yes, no, unsure, na. */
  answers: text("answers").notNull().default('["yes","no"]'),
  /** JSON array of answers that flag the job. */
  flagOn: text("flag_on").notNull().default('["no","unsure"]'),
  /** A flagged answer stops the job starting, not just flags it. */
  blocks: integer("blocks", { mode: "boolean" }).notNull().default(false),
  /** Shown on every SWMS. Otherwise only on the templates in templateKeys. */
  appliesAll: integer("applies_all", { mode: "boolean" }).notNull().default(true),
  templateKeys: text("template_keys").notNull().default("[]"),
  sortOrder: integer("sort_order").notNull().default(0),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  ...timestamps,
});

export const swmsChanges = sqliteTable(
  "swms_changes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** template · block · site_check · sds */
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id"),
    action: text("action").notNull(),
    summary: text("summary").notNull().default(""),
    actorName: text("actor_name").notNull().default("System"),
    actorRole: text("actor_role").notNull().default("system"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [index("swms_changes_entity_idx").on(t.entityType, t.entityId)],
);

/**
 * A flagged site check answer: the red card on the job (Stage 3). One open per
 * job and check. Clearing fills in who, when and the note. Nothing is deleted.
 */
export const swmsFlags = sqliteTable(
  "swms_flags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    /** The signing it came with. Null when Crew flagged it before signing (a check that blocks). */
    recordId: integer("record_id").references(() => swmsRecords.id, { onDelete: "set null" }),
    taskId: integer("task_id").references(() => jobTasks.id, { onDelete: "set null" }),
    installerId: integer("installer_id").references(() => installers.id, { onDelete: "set null" }),
    installerName: text("installer_name").notNull().default(""),
    checkId: integer("check_id").references(() => swmsSiteChecks.id, { onDelete: "set null" }),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    blocks: integer("blocks", { mode: "boolean" }).notNull().default(false),
    emailed: integer("emailed", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    clearedByName: text("cleared_by_name"),
    clearedAt: integer("cleared_at", { mode: "timestamp" }),
    clearNote: text("clear_note"),
  },
  (t) => [index("swms_flags_job_idx").on(t.jobId, t.clearedAt)],
);

/** Every time Office emails a signed SWMS to the builder. One row per address. */
export const swmsEmails = sqliteTable(
  "swms_emails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    recordId: integer("record_id").references(() => swmsRecords.id, { onDelete: "set null" }),
    toEmail: text("to_email").notNull(),
    sentByName: text("sent_by_name").notNull().default(""),
    sentAt: integer("sent_at", { mode: "timestamp" }).notNull().$defaultFn(now),
    ok: integer("ok", { mode: "boolean" }).notNull().default(false),
    error: text("error"),
  },
  (t) => [index("swms_emails_job_idx").on(t.jobId, t.sentAt)],
);

/** Extra templates Office pins on one job, on top of the ones the labour brings in. */
export const jobSwmsTemplates = sqliteTable(
  "job_swms_templates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    addedByName: text("added_by_name").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(now),
  },
  (t) => [unique("job_swms_templates_uq").on(t.jobId, t.templateKey)],
);
