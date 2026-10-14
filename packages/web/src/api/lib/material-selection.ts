import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { ensureForJob, subjectWithRef } from "./conversations";
import { sendJobEmail } from "./job-mail";
import { notifyOffice } from "./notify";
import { newToken, selectionUrl } from "./quote-links";
import { jobText } from "./refs";
import { isProductForm, lockState, productItemsFor } from "./selection-colours";
import { addMissingUpgradeRows } from "./underlay-upgrade";

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

/* ---------------------------------------------------------------------------
 * The material selection form (spec section 2). No login, opened by link.
 *
 * Fix list 13 Oct, items 8 and 10: it is one section per product on the
 * accepted quote (lib/selection-colours.ts), and it is never sent by itself.
 * The office sends it from the job page. The old room by room forms (product,
 * colour and notes per room) still open and send back as they were.
 * ------------------------------------------------------------------------- */

export const SENDER_NAME = "Damien from Terra";

type Contact = typeof schema.contacts.$inferSelect;

/** Who approves colour and product on this job: a ticked decision-maker, else the customer. */
export async function decisionMakerFor(jobId: number): Promise<Contact | null> {
  const ticked = await db
    .select({ contact: schema.contacts })
    .from(schema.jobContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
    .where(and(eq(schema.jobContacts.jobId, jobId), eq(schema.jobContacts.canApproveQuote, true)))
    .orderBy(desc(schema.jobContacts.isPrimary), asc(schema.jobContacts.id));
  const withEmail = ticked.find((r) => r.contact.email?.trim());
  if (withEmail) return withEmail.contact;
  if (ticked[0]) return ticked[0].contact;
  const [job] = await db.select({ contactId: schema.jobs.contactId }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job?.contactId) return null;
  const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, job.contactId));
  return c ?? null;
}

/** The job's selection form, if it has one. The newest wins. */
export async function selectionForJob(jobId: number) {
  const [sel] = await db
    .select()
    .from(schema.materialSelections)
    .where(eq(schema.materialSelections.jobId, jobId))
    .orderBy(desc(schema.materialSelections.id))
    .limit(1);
  if (!sel) return null;
  const items = await db
    .select()
    .from(schema.materialSelectionItems)
    .where(eq(schema.materialSelectionItems.selectionId, sel.id))
    .orderBy(asc(schema.materialSelectionItems.sortOrder), asc(schema.materialSelectionItems.id));
  return { ...sel, url: selectionUrl(sel.token), items };
}

/**
 * The job's form, one section per product on the accepted quote. Reuses the
 * newest one when it is already the new kind for the same accepted quote, so
 * a resend is the same link. An old room by room form, or one made from an
 * earlier version of the quote, is replaced by a new one.
 */
export async function createSelection(args: { jobId: number }) {
  // Checked before anything is written, so a job with nothing to choose gets no form.
  const probe = await productItemsFor(args.jobId, 0);
  const existing = await selectionForJob(args.jobId);
  if (existing && isProductForm(existing.items) && existing.quoteId === probe.quoteId) {
    // Item 9: a form made before the upgrade pairs were set gets its offers on a resend.
    if (!(await lockState(args.jobId)).locked && (await addMissingUpgradeRows(existing, existing.items))) return (await selectionForJob(args.jobId))!;
    return existing;
  }

  const who = await decisionMakerFor(args.jobId);
  const [sel] = await db
    .insert(schema.materialSelections)
    .values({
      jobId: args.jobId,
      quoteId: probe.quoteId,
      token: newToken(),
      contactId: who?.id ?? null,
      sentTo: who?.email?.trim() || null,
      status: "waiting",
    })
    .returning();
  if (!sel) throw bad("Selection form not created");
  await db.insert(schema.materialSelectionItems).values(probe.rows.map((r) => ({ ...r, selectionId: sel.id })));
  return (await selectionForJob(args.jobId))!;
}

/**
 * Email the form link to the decision-maker through team@, and log it on the
 * job's thread. Returns why it did not go, rather than throwing, so the
 * Send button can show the reason.
 */
export async function sendSelection(selectionId: number, by: { name: string }): Promise<{ sent: boolean; to: string | null; reason?: string }> {
  const [sel] = await db.select().from(schema.materialSelections).where(eq(schema.materialSelections.id, selectionId));
  if (!sel) return { sent: false, to: null, reason: "Form not found" };
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, sel.jobId));
  if (!job) return { sent: false, to: null, reason: "Job not found" };
  const [contact] = sel.contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, sel.contactId)) : [];
  const to = sel.sentTo?.trim() || contact?.email?.trim() || null;
  if (!to) return { sent: false, to: null, reason: "No email address for the decision-maker" };

  const ref = jobText(job);
  const first = contact?.firstName?.trim() || "there";
  const url = selectionUrl(sel.token);
  const conv = await ensureForJob(job.id);
  const subject = subjectWithRef(`Check your flooring colours, job ${ref}`, conv.ref);
  // Item 9: say there is an underlay upgrade to answer on the form.
  const offers = await db
    .select({ id: schema.materialSelectionItems.id })
    .from(schema.materialSelectionItems)
    .where(and(eq(schema.materialSelectionItems.selectionId, sel.id), isNotNull(schema.materialSelectionItems.offerProductId), eq(schema.materialSelectionItems.answer, "")));
  const text = [
    `Hi ${first},`,
    "",
    "Thanks for accepting your quote with Terra Flooring.",
    "",
    "Before we order, please check the colour of each floor on your quote. If you would like a different colour from the same range, you can change it there. It takes a couple of minutes:",
    url,
    "",
    ...(offers.length ? ["There is also an underlay upgrade offer on the form. Tap Yes or No thanks.", ""] : []),
    "If you are not sure yet, leave us a note on the form and we will call you.",
    "",
    "Kind regards,",
    "Damien",
    "Terra Flooring",
  ].join("\n");

  try {
    await sendJobEmail({
      conv,
      jobId: job.id,
      to,
      subject,
      text,
      fromName: SENDER_NAME,
      label: "Colour form",
      contactId: contact?.id ?? null,
      authorName: by.name,
    });
    await db
      .update(schema.materialSelections)
      .set({ sentAt: new Date(), sentTo: to, updatedAt: new Date() })
      .where(eq(schema.materialSelections.id, sel.id));
    return { sent: true, to };
  } catch (e) {
    const reason = String((e as Error)?.message ?? e).slice(0, 300);
    console.error("[selection] send failed:", reason);
    return { sent: false, to, reason };
  }
}

export type SelectionItemInput = { areaId?: number | null; room: string; product: string; colour: string; notes: string };

/** The client sends the form back. Replaces the rows, marks it submitted and tells the office. */
export async function submitSelection(sel: typeof schema.materialSelections.$inferSelect, name: string, items: SelectionItemInput[]) {
  const clean = items
    .map((i) => ({
      areaId: i.areaId ?? null,
      room: i.room.trim().slice(0, 120),
      product: i.product.trim().slice(0, 200),
      colour: i.colour.trim().slice(0, 120),
      notes: i.notes.trim().slice(0, 1000),
    }))
    .filter((i) => i.room || i.product || i.colour || i.notes);
  if (!clean.length) throw bad("Fill in at least one room.");

  // Only area ids that really belong to this job are kept.
  const areaIds = new Set(
    (await db.select({ id: schema.jobAreas.id }).from(schema.jobAreas).where(eq(schema.jobAreas.jobId, sel.jobId))).map((a) => a.id),
  );
  await db.delete(schema.materialSelectionItems).where(eq(schema.materialSelectionItems.selectionId, sel.id));
  await db.insert(schema.materialSelectionItems).values(
    clean.map((i, n) => ({ ...i, areaId: i.areaId && areaIds.has(i.areaId) ? i.areaId : null, selectionId: sel.id, sortOrder: n })),
  );
  const now = new Date();
  await db
    .update(schema.materialSelections)
    .set({ status: "submitted", submittedAt: now, submittedName: name.trim().slice(0, 120), updatedAt: now })
    .where(eq(schema.materialSelections.id, sel.id));

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, sel.jobId));
  const ref = job ? jobText(job) : String(sel.jobId);
  await db.insert(schema.activityLog).values({
    jobId: sel.jobId,
    entityType: "material_selection",
    entityId: sel.id,
    action: "selection_submitted",
    detail: `${name.trim() || "The client"} sent the material selection, ${clean.length} room(s)`,
    actorName: name.trim() || "Client",
    actorRole: "customer",
  });
  await notifyOffice("selection_done", {
    title: `Flooring chosen for job ${ref}`,
    body: `${name.trim() || "The client"} filled in the material selection. Ready to order.`,
    data: { kind: "job", jobId: sel.jobId },
  });
  return selectionForJob(sel.jobId);
}
