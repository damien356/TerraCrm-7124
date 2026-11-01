import { desc, eq, inArray, or } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { careApprovalProblem, careSettings, careTemplates, inactiveCodes, planInputFor } from "./care-engine";
import { holidayDue, nextEmail, pastDue } from "./care-plan";
import { CARE_TEMPLATE_MAP } from "./care-templates";
import { guideList, guidesForJob } from "./comms-guides";
import { reviewView } from "./comms-review";
import { CUSTOMER_TYPE_LABELS, ROLE_LABELS, blockFor, commsEvent, commsHistory, homeownerAmbiguity, jobComms, snapshotChange, type CommsRole } from "./comms-people";
import { followupsForJob } from "./quote-followup";

/* ---------------------------------------------------------------------------
 * The "Customer communications" card on a job (Damien, 31 Oct). One read that
 * fills the whole card: the people, quote follow-ups, care guides and series,
 * the review request, and the history. Nothing here changes anything.
 * ------------------------------------------------------------------------- */

const titleOf = (code: string) => CARE_TEMPLATE_MAP.get(code)?.title ?? code;

export async function commsPanel(jobId: number) {
  const ctx = await jobComms(jobId);
  if (!ctx) return null;
  const now = new Date();

  /* People, with what each can get. */
  const people = [];
  for (const p of ctx.people) {
    people.push({
      contactId: p.contactId,
      name: p.name,
      roles: p.roles,
      roleLabel: p.roleLabel,
      mainRole: p.mainRole,
      mainRoleLabel: ROLE_LABELS[p.mainRole],
      email: p.email,
      mobile: p.mobile ?? p.mobileRaw,
      mobileOk: !!p.mobile,
      company: p.company,
      onJob: p.onJob,
      receivesEmail: p.receivesEmail,
      receivesSms: p.receivesSms,
      can: {
        followup: await blockFor(ctx, p, "followup", "email"),
        careGuide: await blockFor(ctx, p, "care_guide", "email"),
        careSeries: await blockFor(ctx, p, "care_series", "email"),
        reviewEmail: await blockFor(ctx, p, "review", "email"),
        reviewSms: await blockFor(ctx, p, "review", "sms"),
      },
    });
  }

  /* Care series: anyone on this job who is a member, or whose last job is this one. */
  const ids = ctx.people.map((p) => p.contactId);
  const members = await db
    .select()
    .from(schema.careMembers)
    .where(ids.length ? or(eq(schema.careMembers.lastJobId, jobId), inArray(schema.careMembers.contactId, ids)) : eq(schema.careMembers.lastJobId, jobId));
  const templates = await careTemplates();
  const inactive = inactiveCodes(templates);
  const cs = await careSettings();
  const care = [];
  for (const m of members) {
    const rows = await db.select().from(schema.careSends).where(eq(schema.careSends.memberId, m.id)).orderBy(desc(schema.careSends.id));
    const input = planInputFor(m, rows, now, inactive);
    const next = m.status === "active" ? (holidayDue(input) ?? nextEmail(input)) : null;
    const late = m.status === "awaiting_approval" ? pastDue(input) : [];
    const p = ctx.people.find((x) => x.contactId === m.contactId);
    const [c] = p ? [] : await db.select().from(schema.contacts).where(eq(schema.contacts.id, m.contactId));
    let changed: string | null = null;
    if (m.status === "active" && m.approvalSnapshot && m.lastJobId === jobId) changed = snapshotChange(ctx, m.approvalSnapshot);
    care.push({
      id: m.id,
      status: m.status,
      reason: m.status === "awaiting_approval" ? m.awaitingReason : m.stopReason,
      who: p
        ? { name: p.name, role: p.roleLabel, email: p.email }
        : { name: c ? `${c.firstName} ${c.lastName}`.trim() : "(gone)", role: "Not on this job", email: (c?.email ?? "").toLowerCase() },
      onThisJob: m.lastJobId === jobId,
      next: next ? { code: next.code, title: titleOf(next.code), at: next.dueAt.getTime() } : null,
      sent: rows.filter((r) => r.status === "sent").map((r) => ({ code: r.code, title: titleOf(r.code), at: (r.sentAt ?? r.createdAt).getTime() })),
      failed: rows.filter((r) => r.status === "failed").length,
      notSentLate: late.map((x) => ({ code: x.code, title: titleOf(x.code), at: x.dueAt.getTime() })),
      approvedAt: m.approvedAt?.getTime() ?? null,
      approvedByName: m.approvedByName,
      approveBlock: m.status === "awaiting_approval" ? await careApprovalProblem(m, { checkSnapshot: false }) : null,
      changed,
    });
  }

  const followups = await followupsForJob(jobId, now);
  const review = await reviewView(jobId, ctx);
  const guides = await guidesForJob(jobId);
  const history = await commsHistory(jobId);

  return {
    job: {
      id: ctx.job.id,
      ref: ctx.jobRef,
      type: ctx.type,
      typeLabel: ctx.typeLabel,
      company: ctx.company ? { id: ctx.company.id, name: ctx.company.name } : null,
      siteAddress: ctx.siteAddress,
      builderRef: ctx.job.builderRef,
      /* The hint is the builder's own work order format, or the site address when they have none. */
      builderRefHint: (ctx.company?.workOrderPrefix ?? "").trim() || (ctx.siteAddress ? `None set for this builder. Use the site address: ${ctx.siteAddress}` : ""),
      directContactOk: ctx.job.directContactOk,
      directContactOkBy: ctx.job.directContactOkBy,
      directContactOkAt: ctx.job.directContactOkAt?.getTime() ?? null,
      isCompanyJob: ctx.type !== "direct",
      isCallback: !!ctx.job.parentJobId,
    },
    billing: ctx.billingCompany,
    people,
    homeownerAmbiguity: homeownerAmbiguity(ctx),
    followups,
    care: { on: cs.on, members: care },
    guides: { list: guideList(), sent: guides },
    review,
    history: history.map((h) => ({ id: h.id, kind: h.kind, event: h.event, detail: h.detail, channel: h.channel, to: h.toAddress, by: h.byName, at: h.createdAt.getTime() })),
    labels: { roles: ROLE_LABELS as Record<CommsRole, string>, types: CUSTOMER_TYPE_LABELS },
  };
}

export async function setBuilderRef(jobId: number, ref: string, byName: string) {
  const v = ref.trim().slice(0, 80);
  await db.update(schema.jobs).set({ builderRef: v, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
  await commsEvent({ jobId, kind: "job", event: "builder_ref", detail: v ? `Builder ref / work order no. set to ${v}.` : "Builder ref / work order no. cleared.", byName });
}

/** The builder has OK'd talking to the homeowner direct. Recorded with who and when. Turning it off sends what was approved for a homeowner back to approval at the next check. */
export async function setDirectContactOk(jobId: number, ok: boolean, byName: string) {
  const now = new Date();
  await db
    .update(schema.jobs)
    .set({ directContactOk: ok, directContactOkBy: ok ? byName : "", directContactOkAt: ok ? now : null, updatedAt: now })
    .where(eq(schema.jobs.id, jobId));
  await commsEvent({ jobId, kind: "people", event: ok ? "direct_contact_ok" : "direct_contact_off", detail: ok ? "Builder has OK'd direct contact with the homeowner." : "Direct contact with the homeowner turned off.", byName });
}
