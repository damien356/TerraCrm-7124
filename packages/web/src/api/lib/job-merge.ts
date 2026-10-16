import type { Client, InStatement } from "@libsql/client";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { rebuildForecast } from "./cashflow";
import { jobRef as threadRef } from "./conversations";
import { mergePerson } from "./job-people";
import { parseTags, tagsJson } from "./person-tags";
import { jobText, taskRef, variationRef } from "./refs";

/* ---------------------------------------------------------------------------
 * MERGE A JOB INTO ANOTHER (notes 18.48, Damien 27 Oct). Admin only.
 *
 * One builder sent three POs for one site and Ops made two jobs (188012 and
 * 188013). The merge keeps the job you pick as the main job and moves
 * everything from the other one onto it: quotes, emails and the conversation,
 * photos and files, notes, timeline, people, office tasks, dispatches, POs.
 *
 * The merged job is kept, marked "Merged into 188012", and hidden from the job
 * lists. A search for its number still finds it and opens the main job, and an
 * email tagged [#188013] lands on 188012's conversation. Emails keep their own
 * Message-ID and Gmail thread, so a reply to one still finds the thread.
 *
 * Blocked when money has moved on the merged job (a paid invoice, a paid
 * deposit) or when it has a live invoice, and a few cases that need a person
 * to decide first. A preview lists exactly what moves before anything is saved.
 * All of it lands in one batch: all of it or none of it.
 * ------------------------------------------------------------------------- */

type Actor = { name: string; role: string };
type Row = Record<string, any>;

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const stop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 3).trim()}...` : s);
const preview = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 160);

/** How each moved table reads in the preview. Null: moved, but not worth a line. */
const WHAT: Record<string, [string, string] | null> = {
  "quotes.job_id": ["quote", "quotes"],
  "job_media.job_id": ["photo or file in the job file", "photos and files in the job file"],
  "task_photos.job_id": ["dispatch photo", "dispatch photos"],
  "activity_log.job_id": ["timeline entry and note", "timeline entries and notes"],
  "office_tasks.job_id": ["office task", "office tasks"],
  "job_materials.job_id": ["material", "materials"],
  "purchase_orders.job_id": ["purchase order", "purchase orders"],
  "supplier_invoices.job_id": ["supplier bill", "supplier bills"],
  "job_costs.job_id": ["job cost", "job costs"],
  "job_areas.job_id": ["measured area", "measured areas"],
  "invoices.job_id": ["voided invoice", "voided invoices"],
  "material_selections.job_id": ["material selection", "material selections"],
  "form_submissions.job_id": ["form", "forms"],
  "site_visits.job_id": ["site visit", "site visits"],
  "swms_records.job_id": ["SWMS record", "SWMS records"],
  "swms_flags.job_id": ["SWMS flag", "SWMS flags"],
  "swms_emails.job_id": ["SWMS email", "SWMS emails"],
  "job_swms_templates.job_id": ["SWMS template", "SWMS templates"],
  "callback_costs.job_id": ["callback cost", "callback costs"],
  "voice_quote_captures.job_id": ["voice quote note", "voice quote notes"],
  "voice_actions.job_id": ["voice action", "voice actions"],
  "installer_invoices.job_id": ["installer invoice", "installer invoices"],
  "journey_enrolments.job_id": ["follow up sequence", "follow up sequences"],
  "care_sends.job_id": ["care email", "care emails"],
  "care_members.last_job_id": ["care member", "care members"],
  "lead_submissions.job_id": ["web form lead", "web form leads"],
  "repair_requests.job_id": ["timber repair request", "timber repair requests"],
  "alerts.job_id": ["alert", "alerts"],
  "stock_reservations.job_id": ["stock reservation", "stock reservations"],
  "stock_movements.job_id": ["stock movement", "stock movements"],
  "payment_terms.job_id": ["set of payment terms", "sets of payment terms"],
  "jobs.parent_job_id": ["repair or callback", "repairs and callbacks"],
  "jobs.merged_into_job_id": ["job merged in earlier", "jobs merged in earlier"],
  // Told in their own lines, or rebuilt.
  "messages.job_id": null,
  "cash_events.job_id": null,
};
/** Moved by hand below, never by the plain "point it at the main job" step. */
const SPECIAL = new Set(["job_contacts", "conversations", "variations", "job_tasks"]);

/** Every column in the database that points at jobs(id) or conversations(id), read from the live table layout. */
async function columnsPointingAt(client: Client, target: "jobs" | "conversations") {
  const tables = await client.execute("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_litestream%'");
  const out: Array<{ table: string; column: string }> = [];
  for (const t of tables.rows) {
    const name = String(t.name);
    const fks = await client.execute(`pragma foreign_key_list("${name.replace(/"/g, "")}")`);
    for (const fk of fks.rows) if (String(fk.table) === target) out.push({ table: name, column: String(fk.from) });
  }
  return out;
}

const personOf = (r: Row) => ({
  tags: parseTags(r.tags),
  isPrimary: !!r.is_primary,
  onSiteContact: !!r.on_site_contact,
  canApproveQuote: !!r.can_approve_quote,
  receivesSms: !!r.receives_sms,
  receivesEmail: !!r.receives_email,
  showToCrew: !!r.show_to_crew,
  whenToContact: r.when_to_contact ?? null,
  actedForCompanyId: r.acted_for_company_id ?? null,
});

/** The stored shape mergePerson reads: tags still as the saved JSON text. */
const storedOf = (r: Row) => ({ ...personOf(r), tags: String(r.tags ?? "[]") });

const TICKS: Array<[keyof ReturnType<typeof personOf>, string]> = [
  ["canApproveQuote", "can approve quotes"],
  ["onSiteContact", "on site contact"],
  ["receivesEmail", "gets emails"],
  ["receivesSms", "gets texts"],
  ["showToCrew", "shown to crew"],
];

/** Everything the merge reads, once. */
async function gather(fromJobId: number, intoJobId: number) {
  const client = db.$client as Client;
  const [from] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, fromJobId));
  const [into] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, intoJobId));
  if (!from || !into) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const statuses = await db.select().from(schema.jobStatuses);
  const statusOf = (id: number | null) => statuses.find((s) => s.id === id)?.name ?? null;
  const fromRef = jobText(from);
  const intoRef = jobText(into);

  const people = async (jobId: number) =>
    (
      await client.execute({
        sql: `select jc.*, trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) as person from job_contacts jc join contacts c on c.id = jc.contact_id where jc.job_id = ? order by jc.id`,
        args: [jobId],
      })
    ).rows as Row[];
  const fromPeople = await people(from.id);
  const intoPeople = await people(into.id);
  const [fromMain] = from.contactId
    ? await db.select({ id: schema.contacts.id, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName }).from(schema.contacts).where(eq(schema.contacts.id, from.contactId))
    : [];

  const fromVariations = await db.select().from(schema.variations).where(eq(schema.variations.jobId, from.id)).orderBy(asc(schema.variations.seq));
  const intoVariations = await db.select({ seq: schema.variations.seq }).from(schema.variations).where(eq(schema.variations.jobId, into.id));
  const fromTasks = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.jobId, from.id)).orderBy(asc(schema.jobTasks.seq), asc(schema.jobTasks.id));
  const intoTasks = await db.select({ seq: schema.jobTasks.seq }).from(schema.jobTasks).where(eq(schema.jobTasks.jobId, into.id));

  const fromConvs = await db.select().from(schema.conversations).where(eq(schema.conversations.jobId, from.id)).orderBy(asc(schema.conversations.id));
  const [intoConv] = await db.select().from(schema.conversations).where(eq(schema.conversations.jobId, into.id)).orderBy(asc(schema.conversations.id)).limit(1);
  const convIds = [...fromConvs.map((c) => c.id), ...(intoConv ? [intoConv.id] : [])];
  const convMessages = convIds.length
    ? await db
        .select({
          id: schema.messages.id,
          conversationId: schema.messages.conversationId,
          channel: schema.messages.channel,
          direction: schema.messages.direction,
          body: schema.messages.body,
          createdAt: schema.messages.createdAt,
        })
        .from(schema.messages)
        .where(inArray(schema.messages.conversationId, convIds))
    : [];
  const participants = convIds.length
    ? await db.select().from(schema.conversationParticipants).where(inArray(schema.conversationParticipants.conversationId, convIds))
    : [];

  const liveInvoices = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.jobId, from.id), ne(schema.invoices.status, "void")))
    .orderBy(asc(schema.invoices.seq));
  const [fromReferral] = await db.select().from(schema.jobReferrals).where(eq(schema.jobReferrals.jobId, from.id));
  const [fromRepair] = await db.select({ id: schema.repairRequests.id }).from(schema.repairRequests).where(eq(schema.repairRequests.jobId, from.id));
  const [intoRepair] = await db.select({ id: schema.repairRequests.id }).from(schema.repairRequests).where(eq(schema.repairRequests.jobId, into.id));
  const [fromTerms] = await db.select({ id: schema.paymentTerms.id }).from(schema.paymentTerms).where(eq(schema.paymentTerms.jobId, from.id));
  const [intoTerms] = await db.select({ id: schema.paymentTerms.id }).from(schema.paymentTerms).where(eq(schema.paymentTerms.jobId, into.id));
  const fromSwms = await db.select().from(schema.jobSwmsTemplates).where(eq(schema.jobSwmsTemplates.jobId, from.id));
  const intoSwms = await db.select({ key: schema.jobSwmsTemplates.templateKey }).from(schema.jobSwmsTemplates).where(eq(schema.jobSwmsTemplates.jobId, into.id));
  const openOffice = await db
    .select({ title: schema.officeTasks.title })
    .from(schema.officeTasks)
    .where(and(eq(schema.officeTasks.jobId, from.id), eq(schema.officeTasks.status, "open")))
    .orderBy(asc(schema.officeTasks.id));
  const [site] = from.siteId ? await db.select({ address: schema.sites.address }).from(schema.sites).where(eq(schema.sites.id, from.siteId)) : [];
  const [company] = from.companyId ? await db.select({ name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, from.companyId)) : [];

  // How many rows each column holds for the merged job.
  const columns = await columnsPointingAt(client, "jobs");
  const counts: Array<{ table: string; column: string; n: number }> = [];
  for (const { table, column } of columns) {
    const [r] = (await client.execute({ sql: `select count(*) as n from "${table}" where "${column}" = ?`, args: [from.id] })).rows as Row[];
    const n = Number(r?.n ?? 0);
    if (n) counts.push({ table, column, n });
  }

  return {
    client,
    from,
    into,
    fromRef,
    intoRef,
    fromStatus: statusOf(from.statusId),
    intoStatus: statusOf(into.statusId),
    fromPeople,
    intoPeople,
    fromMain: fromMain ? { id: fromMain.id, name: `${fromMain.firstName} ${fromMain.lastName}`.trim() } : null,
    fromVariations,
    intoMaxVariation: Math.max(0, ...intoVariations.map((v) => v.seq)),
    fromTasks,
    intoMaxTask: Math.max(0, ...intoTasks.map((t) => t.seq ?? 0)),
    fromConvs,
    intoConv: intoConv ?? null,
    convMessages,
    participants,
    liveInvoices,
    fromReferral: fromReferral ?? null,
    bothRepairs: !!fromRepair && !!intoRepair,
    fromTerms: fromTerms ?? null,
    intoTerms: intoTerms ?? null,
    fromSwms,
    intoSwmsKeys: new Set(intoSwms.map((s) => s.key)),
    openOffice,
    fromSite: site?.address ?? null,
    fromCompany: company?.name ?? null,
    columns,
    counts,
  };
}

type Facts = Awaited<ReturnType<typeof gather>>;

/** Why this merge cannot run, in plain words, or null. */
function blockOf(f: Facts): string | null {
  const { from, into, fromRef, intoRef } = f;
  if (from.id === into.id) return "Pick a different job to merge into.";
  if (from.mergedIntoJobId) return `Job ${fromRef} was already merged into another job.`;
  if (into.mergedIntoJobId) return `Job ${intoRef} was merged into another job. Merge into that job instead.`;
  if (from.parentJobId) return `Job ${fromRef} is a repair or callback. Only main jobs can be merged.`;
  if (into.parentJobId) return `Job ${intoRef} is a repair or callback. Merge into its main job instead.`;
  const paid = f.liveInvoices.find((i) => i.amountPaid > 0);
  if (paid) return `Money has moved on ${fromRef}: invoice ${paid.number} has ${money(paid.amountPaid)} paid. A job with money on it is not merged.`;
  if (from.depositPaid) return `Money has moved on ${fromRef}: its deposit is marked paid. A job with money on it is not merged.`;
  const live = f.liveInvoices[0];
  if (live) return `Invoice ${live.number} on ${fromRef} is live and unpaid. Void it first, so the client is not chasing two job numbers, then merge.`;
  if (f.fromReferral) return `Job ${fromRef} has a referral on it. Take it off ${fromRef}, merge, then set it on ${intoRef}, so the quote prices are worked out again.`;
  if (f.bothRepairs) return `Both jobs have a timber repair request. Close one first.`;
  return null;
}

export interface MergePlan {
  /** What moves, in plain lines. */
  moves: string[];
  /** What stays as it is, and why. */
  kept: string[];
}

/** One plan, read by the preview and written by the merge, so the two can never differ. */
function planFor(f: Facts) {
  const { from, into, fromRef, intoRef } = f;
  const moves: string[] = [];
  const kept: string[] = [];
  const intoHasPrimary = f.intoPeople.some((p) => !!p.is_primary);
  const fromConvIds = new Set(f.fromConvs.map((c) => c.id));
  const fromMsgs = f.convMessages.filter((m) => m.conversationId != null && fromConvIds.has(m.conversationId));

  // The conversation.
  if (f.fromConvs.length) {
    const emails = fromMsgs.filter((m) => m.channel === "email");
    const sent = emails.filter((m) => m.direction === "out").length;
    const what = fromMsgs.length === emails.length ? plural(emails.length, "email") : `${plural(fromMsgs.length, "message")} (${plural(emails.length, "email")})`;
    if (f.intoConv) moves.push(`${what} from ${fromRef}'s conversation move into ${intoRef}'s conversation (${f.intoConv.ref}).`);
    else moves.push(`${fromRef}'s conversation (${what}) moves to ${intoRef} and is renamed ${threadRef(into)}.`);
    if (sent) moves.push(`${plural(sent, "email was", "emails were")} sent to the client from ${fromRef}. They stay in ${intoRef}'s history, so a reply to them still finds ${intoRef}.`);
    else if (emails.length) moves.push(`Nothing was sent from ${fromRef}. ${emails.length === 1 ? "The email keeps" : "The emails keep"} their own Message-ID and Gmail thread, so any reply still finds ${intoRef}.`);
  }

  // People.
  const intoBy = new Map(f.intoPeople.map((p) => [Number(p.contact_id), p]));
  for (const r of f.fromPeople) {
    const k = intoBy.get(Number(r.contact_id));
    const name = String(r.person || "Someone");
    if (!k) {
      moves.push(`${name} is added to ${intoRef}${r.is_primary && intoHasPrimary ? ", not as the main contact" : ""}.`);
      continue;
    }
    const before = personOf(k);
    const after = mergePerson(storedOf(k), personOf(r));
    const gained = TICKS.filter(([key]) => !!after[key] && !before[key]).map(([, label]) => label);
    const newTags = after.tags.filter((t) => !before.tags.includes(t));
    const extra = [...gained, ...newTags.map((t) => `tag ${t}`)];
    moves.push(`${name} is on both jobs. Kept once on ${intoRef}${extra.length ? `, and gains: ${extra.join(", ")}` : ", nothing new to add"}.`);
  }
  const listed = new Set([...f.fromPeople, ...f.intoPeople].map((p) => Number(p.contact_id)));
  if (f.fromMain && !listed.has(f.fromMain.id) && f.fromMain.id !== into.contactId) moves.push(`${f.fromMain.name}, the client on ${fromRef}, is added to ${intoRef}.`);

  // Dispatches and variations take the main job's next letters and numbers.
  let seq = f.intoMaxTask;
  for (const t of f.fromTasks) {
    seq += 1;
    moves.push(`Dispatch ${taskRef(fromRef, t.seq)} "${clip(t.title)}" moves and becomes ${taskRef(intoRef, seq)}.`);
  }
  let vseq = f.intoMaxVariation;
  for (const v of f.fromVariations) {
    vseq += 1;
    const seen = !!v.sentAt || v.status !== "draft";
    moves.push(seen ? `Variation ${v.ref} moves. It keeps its ref because the client has seen it.` : `Draft variation ${v.ref} moves and becomes ${variationRef(intoRef, vseq)}.`);
  }

  // Everything else, table by table.
  for (const c of f.counts) {
    if (SPECIAL.has(c.table)) continue;
    const key = `${c.table}.${c.column}`;
    if (key === "payment_terms.job_id" && f.intoTerms) {
      kept.push(`${intoRef}'s payment terms stay. ${fromRef}'s are dropped.`);
      continue;
    }
    let n = c.n;
    if (key === "job_swms_templates.job_id") {
      const dup = f.fromSwms.filter((s) => f.intoSwmsKeys.has(s.templateKey)).length;
      if (dup) kept.push(`${plural(dup, "SWMS template")} already on ${intoRef}, so ${fromRef}'s copy is dropped.`);
      n -= dup;
      if (!n) continue;
    }
    const label = key in WHAT ? WHAT[key] : ([c.table.replace(/_/g, " ") + " row", c.table.replace(/_/g, " ") + " rows"] as [string, string]);
    if (!label) continue;
    let line = `${plural(n, label[0], label[1])} ${n === 1 ? "moves" : "move"}`;
    if (key === "office_tasks.job_id" && f.openOffice.length) line += ` (${f.openOffice.length} open: ${f.openOffice.map((t) => `"${clip(t.title)}"`).join(", ")})`;
    moves.push(stop(line));
  }

  // The main job's own details: blanks are filled, the value is added.
  if (!into.siteId && from.siteId) moves.push(`${intoRef} has no site yet, so it takes ${fromRef}'s${f.fromSite ? `: ${f.fromSite}` : ""}.`);
  if (!into.companyId && from.companyId) moves.push(`${intoRef} has no company yet, so it takes ${fromRef}'s${f.fromCompany ? `: ${f.fromCompany}` : ""}.`);
  if (!(into.accessNotes ?? "").trim() && (from.accessNotes ?? "").trim()) moves.push(`${fromRef}'s access notes are copied onto ${intoRef}.`);
  if ((from.description ?? "").trim() && (from.description ?? "").trim() !== (into.description ?? "").trim()) moves.push(`${fromRef}'s description is added under ${intoRef}'s.`);
  if (!into.planUrl && from.planUrl) moves.push(`${fromRef}'s plan is copied onto ${intoRef}.`);
  if (from.value > 0) moves.push(`${fromRef}'s job value of ${money(from.value)} is added to ${intoRef}'s.`);

  moves.push(`${fromRef} is marked "Merged into ${intoRef}" and hidden from the jobs list. A search for ${fromRef} finds it and opens ${intoRef}.`);
  moves.push(`One line on ${intoRef}'s timeline lists what moved.`);
  if (f.counts.some((c) => c.table === "quotes" || c.table === "purchase_orders" || c.table === "invoices")) kept.push("Quote, PO and invoice numbers stay as they are, so paperwork already sent still matches.");
  if (from.title.trim() && from.title.trim() !== into.title.trim()) kept.push(`${intoRef} keeps its own title. ${fromRef}'s title "${clip(from.title, 90)}" goes on the timeline line.`);
  return { moves, kept, intoHasPrimary };
}

export async function mergePreview(fromJobId: number, intoJobId: number) {
  const f = await gather(fromJobId, intoJobId);
  const block = blockOf(f);
  const plan = planFor(f);
  return {
    from: { id: f.from.id, ref: f.fromRef, title: f.from.title, status: f.fromStatus },
    into: { id: f.into.id, ref: f.intoRef, title: f.into.title, status: f.intoStatus },
    block,
    moves: block ? [] : plan.moves,
    kept: block ? [] : plan.kept,
  };
}

export async function mergeJobs(args: { fromJobId: number; intoJobId: number; actor: Actor }) {
  const { actor } = args;
  if (actor.role !== "admin") throw new ORPCError("FORBIDDEN", { message: "Only an Admin can merge jobs." });
  const f = await gather(args.fromJobId, args.intoJobId);
  const block = blockOf(f);
  if (block) throw bad(block);
  const plan = planFor(f);
  const { from, into, fromRef, intoRef, client } = f;
  const now = Math.floor(Date.now() / 1000);
  const S: InStatement[] = [];

  // 1. People. Someone on both jobs is kept once with the ticks of both; the main job keeps one main contact.
  const intoBy = new Map(f.intoPeople.map((p) => [Number(p.contact_id), p]));
  for (const r of f.fromPeople) {
    const k = intoBy.get(Number(r.contact_id));
    if (!k) {
      S.push({ sql: "update job_contacts set job_id = ?, is_primary = ?, updated_at = ? where id = ?", args: [into.id, r.is_primary && !plan.intoHasPrimary ? 1 : 0, now, r.id] });
      continue;
    }
    const m = mergePerson(storedOf(k), personOf(r));
    const primary = !!k.is_primary || (!!r.is_primary && !plan.intoHasPrimary);
    S.push({
      sql: "update job_contacts set tags = ?, role = ?, is_primary = ?, on_site_contact = ?, can_approve_quote = ?, receives_sms = ?, receives_email = ?, show_to_crew = ?, when_to_contact = ?, acted_for_company_id = ?, updated_at = ? where id = ?",
      args: [tagsJson(m.tags), m.tags[0] ?? k.role ?? "other", primary ? 1 : 0, m.onSiteContact ? 1 : 0, m.canApproveQuote ? 1 : 0, m.receivesSms ? 1 : 0, m.receivesEmail ? 1 : 0, m.showToCrew ? 1 : 0, m.whenToContact, m.actedForCompanyId, now, k.id],
    });
    S.push({ sql: "delete from job_contacts where id = ?", args: [r.id] });
  }
  const listed = new Set([...f.fromPeople, ...f.intoPeople].map((p) => Number(p.contact_id)));
  if (f.fromMain && !listed.has(f.fromMain.id) && f.fromMain.id !== into.contactId) {
    S.push({ sql: "insert into job_contacts (job_id, contact_id, role, tags, created_at, updated_at) values (?, ?, 'other', '[]', ?, ?)", args: [into.id, f.fromMain.id, now, now] });
  }

  // 2. Dispatches and variations move with the main job's next letters and numbers, in the same statement as the job, so no two ever share one.
  let seq = f.intoMaxTask;
  for (const t of f.fromTasks) {
    seq += 1;
    S.push({ sql: "update job_tasks set job_id = ?, seq = ?, updated_at = ? where id = ?", args: [into.id, seq, now, t.id] });
  }
  let vseq = f.intoMaxVariation;
  for (const v of f.fromVariations) {
    vseq += 1;
    const seen = !!v.sentAt || v.status !== "draft";
    S.push({ sql: "update variations set job_id = ?, seq = ?, ref = ?, updated_at = ? where id = ?", args: [into.id, vseq, seen ? v.ref : variationRef(intoRef, vseq), now, v.id] });
  }

  // 3. One-per-job rows the main job already has.
  if (f.fromTerms && f.intoTerms) S.push({ sql: "delete from payment_terms where id = ?", args: [f.fromTerms.id] });
  for (const s of f.fromSwms) if (f.intoSwmsKeys.has(s.templateKey)) S.push({ sql: "delete from job_swms_templates where id = ?", args: [s.id] });

  // 4. The conversation. One thread per job: the merged job's messages join the main job's thread.
  const convCols = (await columnsPointingAt(client, "conversations")).filter((c) => c.table !== "conversation_participants");
  let keepConv = f.intoConv;
  const joining = [...f.fromConvs];
  if (!keepConv && joining.length) {
    const first = joining.shift()!;
    S.push({ sql: "update conversations set job_id = ?, ref = ?, state = 'open', updated_at = ? where id = ?", args: [into.id, threadRef(into), now, first.id] });
    keepConv = first;
  }
  if (keepConv) {
    const keepPeople = f.participants.filter((p) => p.conversationId === keepConv!.id);
    const same = (a: (typeof keepPeople)[number], b: (typeof keepPeople)[number]) =>
      (a.contactId != null && a.contactId === b.contactId) ||
      (a.installerId != null && a.installerId === b.installerId) ||
      (a.supplierId != null && a.supplierId === b.supplierId) ||
      (a.profileId != null && a.profileId === b.profileId) ||
      (!!a.email && !!b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase());
    for (const c of joining) {
      for (const p of f.participants.filter((x) => x.conversationId === c.id)) {
        if (keepPeople.some((k) => same(k, p))) S.push({ sql: "delete from conversation_participants where id = ?", args: [p.id] });
        else {
          S.push({ sql: "update conversation_participants set conversation_id = ?, updated_at = ? where id = ?", args: [keepConv.id, now, p.id] });
          keepPeople.push(p);
        }
      }
      for (const col of convCols) S.push({ sql: `update "${col.table}" set "${col.column}" = ? where "${col.column}" = ?`, args: [keepConv.id, c.id] });
      S.push({ sql: "delete from conversations where id = ?", args: [c.id] });
    }
    const latest = [...f.convMessages].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
    if (latest?.createdAt) {
      S.push({
        sql: "update conversations set last_message_at = ?, last_message_preview = ?, updated_at = ? where id = ?",
        args: [Math.floor(latest.createdAt.getTime() / 1000), preview(latest.body), now, keepConv.id],
      });
    }
  }

  // 5. Everything else that points at the merged job now points at the main job.
  for (const c of f.counts) {
    if (SPECIAL.has(c.table)) continue;
    S.push({ sql: `update "${c.table}" set "${c.column}" = ? where "${c.column}" = ?`, args: [into.id, from.id] });
  }

  // 6. The main job: blanks filled from the merged job, the value added.
  const fill: Record<string, unknown> = {};
  if (!into.siteId && from.siteId) fill.site_id = from.siteId;
  if (!into.companyId && from.companyId) fill.company_id = from.companyId;
  if (!(into.accessNotes ?? "").trim() && (from.accessNotes ?? "").trim()) fill.access_notes = from.accessNotes;
  const fromDesc = (from.description ?? "").trim();
  const intoDesc = (into.description ?? "").trim();
  if (fromDesc && fromDesc !== intoDesc) fill.description = intoDesc ? `${intoDesc}\n\nFrom ${fromRef}: ${fromDesc}` : fromDesc;
  if (!into.planUrl && from.planUrl) Object.assign(fill, { plan_url: from.planUrl, plan_name: from.planName, plan_mime: from.planMime });
  if (from.value > 0) fill.value = Math.round((into.value + from.value) * 100) / 100;
  const cols = Object.keys(fill);
  S.push({ sql: `update jobs set ${[...cols.map((c) => `${c} = ?`), "updated_at = ?"].join(", ")} where id = ?`, args: [...cols.map((c) => fill[c] as any), now, into.id] });

  // 7. The merged job is kept, pointed at the main job and emptied of value.
  S.push({ sql: "update jobs set merged_into_job_id = ?, merged_at = ?, merged_by_name = ?, value = 0, updated_at = ? where id = ?", args: [into.id, now, actor.name, now, from.id] });

  // 8. The timeline: one line on the main job listing what moved, one on the merged job.
  const detail = [`Job ${fromRef} merged into this job by ${actor.name}.`, from.title.trim() ? `${fromRef} was "${from.title.trim()}".` : null, ...plan.moves, ...plan.kept.map((k) => `Kept: ${k}`)]
    .filter(Boolean)
    .join("\n");
  S.push({
    sql: "insert into activity_log (job_id, entity_type, entity_id, action, detail, actor_name, actor_role, created_at) values (?, 'job', ?, 'job_merged', ?, ?, ?, ?)",
    args: [into.id, into.id, detail, actor.name, actor.role, now],
  });
  S.push({
    sql: "insert into activity_log (job_id, entity_type, entity_id, action, detail, actor_name, actor_role, created_at) values (?, 'job', ?, 'merged_into', ?, ?, ?, ?)",
    args: [from.id, from.id, `Merged into ${intoRef} by ${actor.name}. Everything on this job moved there.`, actor.name, actor.role, now],
  });

  await client.batch(S, "write");
  await rebuildForecast().catch((e) => console.error("[job-merge] forecast rebuild failed:", e));
  return { fromRef, intoRef, intoJobId: into.id, moves: plan.moves, kept: plan.kept };
}
