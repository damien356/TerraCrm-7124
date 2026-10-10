import { ORPCError } from "@orpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { assertBillable } from "./callbacks";
import { depositInvoiceFor, raiseInvoice, type InvoiceRow } from "./client-invoices";
import { depositSplit } from "./deposits";
import { carryQuotePeopleToJob } from "./job-people";
import { moveJobForward } from "./job-stage";
import { createSelection, sendSelection } from "./material-selection";
import { pushToOffice } from "./push";
import { convertQuoteToJob } from "./quote-convert";
import { quoteRefOf } from "./quote-number";
import { jobText } from "./refs";

/* ---------------------------------------------------------------------------
 * The one accept routine (spec section 2.3). Staff pressing Accepted and a
 * client signing online both come through here, so both do the same things:
 *
 *   lock the quote, make the job if there is none, job value = the quote,
 *   job to Won, other versions expire (an earlier accepted one is marked
 *   replaced), deposit invoice IQ{n}-1 at the quote's deposit %, or for a
 *   replacement a variation for the difference when it comes to more, the
 *   material selection form to the decision-maker, and an Order product task.
 * ------------------------------------------------------------------------- */

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

export type AcceptActor = { name: string; role: string };

/**
 * Hold on a later version (Damien 10 Oct). Accepting a quote that is already on
 * a job does not yet rebuild the job's dispatches and materials (item 7 fixes
 * that). Until then a later version cannot be accepted once the job has any
 * dispatches or materials from an earlier one. Returns null when it can go.
 */
export async function laterVersionHold(quote: { id: number; number: number; jobId: number | null }) {
  if (!quote.jobId) return null;
  const [r] = await db.all<{ earlier: number; tasks: number; materials: number }>(sql`
    select
      (select count(*) from quotes where number = ${quote.number} and id != ${quote.id}) as earlier,
      (select count(*) from job_tasks where job_id = ${quote.jobId} and status != 'cancelled') as tasks,
      (select count(*) from job_materials where job_id = ${quote.jobId}) as materials`);
  if (!Number(r?.earlier) || (!Number(r?.tasks) && !Number(r?.materials))) return null;
  const tasks = Number(r?.tasks);
  const materials = Number(r?.materials);
  const what = [tasks ? `${tasks} dispatch${tasks === 1 ? "" : "es"}` : "", materials ? `${materials} material${materials === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(" and ");
  return {
    staff:
      `This version cannot be accepted yet. The job already has ${what} from an earlier version, ` +
      `and Ops cannot swap them over to a new version until the version update is in. ` +
      `Until then, change the job's dispatches and materials by hand and keep the accepted version as it is.`,
    client: "We need to update this quote before it can be accepted. Reply to our email or give us a call and we will sort it for you.",
  };
}

export async function acceptQuote(args: { quoteId: number; actor: AcceptActor; via: "staff" | "online"; note?: string | null }) {
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, args.quoteId));
  if (!quote) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  if (quote.status === "accepted") throw bad("This quote is already accepted.");
  if (quote.status === "expired" || quote.status === "replaced") {
    throw bad("This version has been replaced by a newer one. Accept the current version.");
  }
  if (args.via === "online" && quote.status === "declined") throw bad("This quote was declined. Ask us for a new one.");
  if (args.via === "online" && quote.validUntil && quote.validUntil.getTime() < Date.now() - 86_400_000) {
    throw bad("This quote has passed its valid until date. Reply to our email and we will update it for you.");
  }
  await assertBillable(quote.jobId);
  const hold = await laterVersionHold(quote);
  if (hold) throw bad(args.via === "online" ? hold.client : hold.staff);

  // Lock it, only if nobody else got there first.
  const now = new Date();
  const [locked] = await db
    .update(schema.quotes)
    .set({ status: "accepted", acceptedAt: now, updatedAt: now })
    .where(and(eq(schema.quotes.id, quote.id), eq(schema.quotes.status, quote.status)))
    .returning();
  if (!locked) throw bad("This quote just changed. Refresh and try again.");

  let jobId = locked.jobId;
  let converted = false;
  if (!jobId) {
    const made = await convertQuoteToJob(locked, {}, args.actor);
    jobId = made.job.id;
    converted = true;
  }
  const ref = await quoteRefOf({ ...locked, jobId });

  // An earlier accepted version of the same quote is now replaced.
  const previous = await db
    .select()
    .from(schema.quotes)
    .where(and(eq(schema.quotes.number, quote.number), eq(schema.quotes.status, "accepted"), sql`${schema.quotes.id} != ${quote.id}`));
  const prev = previous.sort((a, b) => b.version - a.version)[0] ?? null;
  if (previous.length) {
    await db
      .update(schema.quotes)
      .set({ status: "replaced", updatedAt: now })
      .where(inArray(schema.quotes.id, previous.map((p) => p.id)));
  }
  // Versions still on the table lose.
  await db
    .update(schema.quotes)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(schema.quotes.number, quote.number),
        inArray(schema.quotes.status, ["draft", "needs_review", "sent"]),
        sql`${schema.quotes.id} != ${quote.id}`,
      ),
    );

  // The job's value is the accepted price. The deposit is set by the first accept only.
  await db
    .update(schema.jobs)
    .set({
      value: locked.total,
      ...(prev ? {} : { depositAmount: depositSplit(locked.total, locked.depositPercent).deposit }),
      updatedAt: now,
    })
    .where(eq(schema.jobs.id, jobId));
  if (!converted) await carryQuotePeopleToJob(locked.id, jobId);

  const prevRef = prev ? await quoteRefOf(prev) : null;
  await db.insert(schema.activityLog).values({
    jobId,
    contactId: locked.contactId,
    entityType: "quote",
    entityId: locked.id,
    action: "accepted",
    detail:
      args.note?.trim() ||
      `Quote ${ref} accepted${args.via === "online" ? ` online by ${args.actor.name}` : ""}, ${money(locked.total)}${prevRef ? `. Replaces ${prevRef}` : ""}`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  await moveJobForward({ jobId, target: "won", why: `quote ${ref} accepted`, actor: args.actor });

  // Money: a deposit on a first accept, a variation for the difference on a replacement.
  let invoice: InvoiceRow | null = null;
  if (prev) {
    const diff = round2(locked.total - prev.total);
    if (diff > 0.005) {
      invoice = await raiseInvoice({
        jobId,
        quoteId: locked.id,
        kind: "variation",
        label: `Variation: quote ${ref} replaces ${prevRef}, ${money(prev.total)} to ${money(locked.total)}`,
        total: diff,
        createdByName: args.actor.name,
        actorRole: args.actor.role,
      });
    }
  } else if (locked.depositPercent > 0 && !(await depositInvoiceFor(locked.id))) {
    const { deposit } = depositSplit(locked.total, locked.depositPercent);
    if (deposit > 0) {
      invoice = await raiseInvoice({
        jobId,
        quoteId: locked.id,
        kind: "deposit",
        label: `Deposit ${locked.depositPercent}% on quote ${ref}`,
        total: deposit,
        createdByName: args.actor.name,
        actorRole: args.actor.role,
      });
    }
  }

  // Material selection and the Order product task, on the first accept.
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  const jobRef = job ? jobText(job) : String(jobId);
  let selection: { id: number; sent: boolean; to: string | null; reason?: string } | null = null;
  if (!prev) {
    const sel = await createSelection({ jobId, quoteId: locked.id });
    const out = await sendSelection(sel.id, { name: args.actor.name });
    selection = { id: sel.id, ...out };
  }

  const taskDetail = [
    prev
      ? `Quote ${ref} (${money(locked.total)}) replaced ${prevRef} (${money(prev.total)}). Check the product order still matches.`
      : `Quote ${ref} accepted, ${money(locked.total)}.`,
    invoice?.kind === "deposit" ? `Order once deposit ${invoice.number} (${money(invoice.total)}) is paid.` : "",
    invoice?.kind === "variation" ? `Variation ${invoice.number} raised for ${money(invoice.total)}.` : "",
    selection && !selection.sent ? `Material selection email did not go: ${selection.reason ?? "unknown"}. Send it from the job page.` : "",
    selection?.sent ? `Material selection sent to ${selection.to}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const [task] = await db
    .insert(schema.officeTasks)
    .values({
      jobId,
      title: prev ? `Check product order, job ${jobRef}` : `Order product, job ${jobRef}`,
      detail: taskDetail,
      createdByName: args.actor.name,
    })
    .returning();

  if (args.via === "online") {
    await pushToOffice({
      title: `Quote ${ref} accepted online`,
      body: `${args.actor.name} accepted ${money(locked.total)}${invoice?.kind === "deposit" ? `. Deposit ${invoice.number} is waiting.` : "."}`,
      data: { kind: "job", jobId },
    });
  }

  const [fresh] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, locked.id));
  return { quote: fresh ?? locked, ref, jobId, converted, replaced: prev ? { id: prev.id, ref: prevRef } : null, invoice, selection, taskId: task?.id ?? null };
}
