import { jobRef } from "../lib/job-ref";
import { taskRef } from "../lib/refs";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly, installerOnly } from "../middleware/auth";
import { ownTaskOrThrow } from "./field";
import { getObject, invoicePdfKey, putObject, signGet } from "../lib/s3";
import { renderInvoicePdf, type InvoiceLineItem } from "../lib/invoicePdf";
import { sendEmail } from "../lib/email";
import { abnView } from "../lib/abn-check";

/**
 * The installer's own invoice to Terra for a completed task. Installers can
 * never edit their own agreed rates or add arbitrary line items. The only
 * numbers that make it onto an invoice are the task's frozen pay breakdown
 * (`job_tasks.labour_breakdown`) plus any variation the OFFICE has already
 * approved. Once submitted, the row is locked to the installer.
 */

const BILLING_EMAIL = "billing@terraflooring.com.au";

/** Notes 18.64: neutral on purpose. He never sees the check itself. */
const ABN_BLOCK = "Ask Terra office to check your ABN before you invoice.";

async function taskInvoiceContext(taskId: number, installerId: number) {
  const task = await ownTaskOrThrow(taskId, installerId);
  if (task.status !== "complete") {
    throw new ORPCError("BAD_REQUEST", { message: "This task isn't marked complete yet." });
  }

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, task.jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const [site] = job.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, job.siteId)) : [null];

  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, installerId));
  if (!installer) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });

  const approvedVariations = await db
    .select()
    .from(schema.installerVariationRequests)
    .where(
      and(
        eq(schema.installerVariationRequests.taskId, taskId),
        eq(schema.installerVariationRequests.installerId, installerId),
        eq(schema.installerVariationRequests.status, "approved"),
      ),
    );

  const lineItems: InvoiceLineItem[] = [];
  /*
   * Hourly work: the lines are his approved, payable hours not billed before,
   * one line per day and rate band at the rate each day was approved at.
   * Recorded time not yet approved blocks the invoice rather than being left off.
   */
  const hourly = task.payType === "hourly" ? await hourlyInvoiceLines(task.id, installerId) : null;
  if (hourly) lineItems.push(...hourly.lines);
  if (!hourly && task.labourBreakdown) {
    try {
      const parsed = JSON.parse(task.labourBreakdown) as Array<{
        name: string;
        unit: string;
        qty: number;
        rate: number | null;
        total: number | null;
      }>;
      for (const l of parsed) {
        lineItems.push({ description: l.name, unit: l.unit, qty: l.qty, rate: l.rate, total: l.total });
      }
    } catch {
      // leave lineItems as whatever was already pushed
    }
  }
  const usableVariations = approvedVariations.filter((v) => !v.invoiceId);
  for (const v of usableVariations) {
    lineItems.push({ description: `Approved extra: ${v.description}`, unit: "each", qty: 1, rate: v.amount, total: v.amount });
  }

  const subtotal = Math.round(lineItems.reduce((sum, l) => sum + (l.total ?? 0), 0) * 100) / 100;
  // Hourly: GST only when every billed day was approved under GST-registered terms.
  const gstRegistered = hourly ? hourly.gstRegistered : installer.gstRegistered;
  const gstAmount = gstRegistered ? Math.round(subtotal * 0.1 * 100) / 100 : 0;
  const total = Math.round((subtotal + gstAmount) * 100) / 100;

  return {
    task,
    job,
    site,
    installer: { ...installer, gstRegistered },
    usableVariations,
    lineItems,
    subtotal,
    gstAmount,
    total,
    hourlySessionIds: hourly?.sessionIds ?? [],
    hourlyBlock: hourly?.block ?? null,
  };
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function sayDate(ymd: string) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

async function hourlyInvoiceLines(taskId: number, installerId: number) {
  const rows = await db
    .select()
    .from(schema.workSessions)
    .where(and(eq(schema.workSessions.taskId, taskId), eq(schema.workSessions.installerId, installerId)))
    .orderBy(asc(schema.workSessions.startedAt));
  const live = rows.filter((r) => r.status !== "rejected");
  const waiting = live.filter((r) => r.status === "open" || r.status === "recorded").length;
  const billable = live.filter((r) => r.status === "approved" && r.payable === true && r.invoiceId == null);
  const lines: InvoiceLineItem[] = [];
  for (const s of billable) {
    let pay: Array<{ label: string; minutes: number; rate: number; total: number }> = [];
    try {
      pay = s.payLines ? JSON.parse(s.payLines) : [];
    } catch {
      pay = [];
    }
    for (const l of pay) {
      if (l.minutes <= 0) continue;
      lines.push({ description: `${sayDate(s.workDate)}: ${l.label}`, unit: "hour", qty: Math.round((l.minutes / 60) * 100) / 100, rate: l.rate, total: l.total });
    }
  }
  return {
    lines,
    sessionIds: billable.map((s) => s.id),
    gstRegistered: billable.length > 0 && billable.every((s) => s.gstRegistered === true),
    block: waiting
      ? `${waiting} time ${waiting === 1 ? "entry is" : "entries are"} still waiting for Terra office to approve. Invoice once they are approved.`
      : billable.length === 0
        ? "There is no approved time on this job to invoice yet."
        : null,
  };
}

export const installerInvoices = {
  /** Read-only preview shown before CREATE MY INVOICE. */
  preview: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    const { task, job, site, installer, lineItems, subtotal, gstAmount, total, hourlyBlock } = await taskInvoiceContext(
      input.taskId,
      context.installerId,
    );

    const [existing] = await db
      .select()
      .from(schema.installerInvoices)
      .where(and(eq(schema.installerInvoices.taskId, input.taskId), eq(schema.installerInvoices.installerId, context.installerId)));

    const logoUrl = installer.logoUrl ? await signGet(installer.logoUrl) : null;
    const abn = abnView(installer);

    return {
      alreadySubmitted: !!existing,
      existingStatus: existing?.status ?? null,
      existingInvoiceId: existing?.id ?? null,
      /** Submitted is not the same as received. The screen says which of the two. */
      emailedToTerra: existing ? !!existing.emailedToTerraAt : false,
      emailError: existing?.emailError ?? null,
      canSubmit:
        !existing &&
        installer.nextInvoiceNumber != null &&
        abn.passes &&
        !hourlyBlock &&
        Boolean(installer.bankBsb && installer.bankAccountNumber && installer.bankAccountName),
      blockedReason: existing
        ? null
        : hourlyBlock
          ? hourlyBlock
          : installer.nextInvoiceNumber == null
          ? "Terra office hasn't set up your invoice numbering yet. Ask them to enable invoicing before you submit."
          : !abn.passes
            ? ABN_BLOCK
            : !installer.bankBsb || !installer.bankAccountNumber || !installer.bankAccountName
              ? "Add your bank details on the Me tab (Bank details) before submitting an invoice."
              : null,
      job: { number: jobRef(job), ref: taskRef(jobRef(job), task.seq), siteAddress: site?.address ?? null, taskTitle: task.title },
      profile: {
        // Notes 18.64: the name his bill goes out in, legal name t/a his business name.
        tradingName: abn.billName,
        installerName: installer.name,
        abn: installer.abn,
        gstRegistered: installer.gstRegistered,
        businessAddress: installer.businessAddress,
        invoiceEmail: installer.invoiceEmail,
        mobile: installer.mobile,
        logoUrl,
        bankAccountName: installer.bankAccountName,
        bankBsb: installer.bankBsb,
        bankAccountNumber: installer.bankAccountNumber,
        nextInvoiceNumber: installer.nextInvoiceNumber,
      },
      lineItems,
      subtotal,
      gstAmount,
      total,
    };
  }),

  /**
   * SUBMIT INVOICE. Confirms, generates the PDF, saves it, emails a copy to
   * accounts and the installer, and locks the invoice. Idempotent per
   * (taskId, installerId) thanks to the unique index, so a repeat call returns
   * the invoice that already exists rather than creating a second one.
   */
  submit: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    const [existing] = await db
      .select()
      .from(schema.installerInvoices)
      .where(and(eq(schema.installerInvoices.taskId, input.taskId), eq(schema.installerInvoices.installerId, context.installerId)));
    if (existing) return existing;

    const { task, job, site, installer, usableVariations, lineItems, subtotal, gstAmount, total, hourlySessionIds, hourlyBlock } =
      await taskInvoiceContext(input.taskId, context.installerId);
    if (hourlyBlock) throw new ORPCError("BAD_REQUEST", { message: hourlyBlock });

    if (installer.nextInvoiceNumber == null) {
      throw new ORPCError("BAD_REQUEST", { message: "Terra office hasn't set up your invoice numbering yet." });
    }
    const abn = abnView(installer);
    if (!abn.passes) throw new ORPCError("BAD_REQUEST", { message: ABN_BLOCK });
    if (!installer.bankBsb || !installer.bankAccountNumber || !installer.bankAccountName) {
      throw new ORPCError("BAD_REQUEST", { message: "Add your bank details on the Me tab (Bank details) before submitting an invoice." });
    }

    const invoiceNumber = installer.nextInvoiceNumber;
    const now = new Date();

    let logoDataUri: string | null = null;
    if (installer.logoUrl) {
      try {
        const url = await signGet(installer.logoUrl);
        const res = await fetch(url);
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers.get("content-type") ?? "image/png";
        logoDataUri = `data:${mime};base64,${buf.toString("base64")}`;
      } catch {
        logoDataUri = null;
      }
    }

    const pdfBuffer = await renderInvoicePdf({
      invoiceNumber,
      invoiceDate: now.toISOString().slice(0, 10),
      tradingName: abn.businessName ?? "",
      installerName: installer.name,
      legalName: abn.legalName,
      abn: installer.abn,
      gstRegistered: installer.gstRegistered,
      businessAddress: installer.businessAddress,
      invoiceEmail: installer.invoiceEmail,
      mobile: installer.mobile,
      logoDataUri,
      bankAccountName: installer.bankAccountName,
      bankBsb: installer.bankBsb,
      bankAccountNumber: installer.bankAccountNumber,
      jobNumber: jobRef(job),
      siteAddress: site?.address ?? null,
      taskTitle: task.title,
      lineItems,
      subtotal,
      gstAmount,
      total,
    });

    const pdfKey = invoicePdfKey(context.installerId, input.taskId);
    // Written as an attachment with a real filename so the Download PDF button
    // saves "invoice-1001.pdf" instead of opening the storage key in a tab.
    await putObject(pdfKey, pdfBuffer, "application/pdf", `invoice-${invoiceNumber}.pdf`);

    const [row] = await db
      .insert(schema.installerInvoices)
      .values({
        taskId: input.taskId,
        jobId: job.id,
        installerId: context.installerId,
        invoiceNumber,
        status: "submitted",
        tradingName: abn.businessName ?? "",
        installerName: installer.name,
        legalName: abn.legalName,
        abn: installer.abn,
        gstRegistered: installer.gstRegistered,
        businessAddress: installer.businessAddress,
        invoiceEmail: installer.invoiceEmail,
        mobile: installer.mobile,
        logoUrl: installer.logoUrl,
        bankAccountName: installer.bankAccountName,
        bankBsb: installer.bankBsb,
        bankAccountNumber: installer.bankAccountNumber,
        jobNumber: job.number,
        siteAddress: site?.address ?? null,
        taskTitle: task.title,
        lineItems: JSON.stringify(lineItems),
        subtotal,
        gstAmount,
        total,
        pdfKey,
        confirmedAt: now,
        submittedAt: now,
      })
      .returning();

    await db
      .update(schema.installers)
      .set({ nextInvoiceNumber: invoiceNumber + 1, updatedAt: now })
      .where(eq(schema.installers.id, context.installerId));

    if (hourlySessionIds.length > 0) {
      // Billed once: this time can never land on a second invoice.
      await db
        .update(schema.workSessions)
        .set({ invoiceId: row!.id, updatedAt: now })
        .where(inArray(schema.workSessions.id, hourlySessionIds));
    }

    if (usableVariations.length > 0) {
      await db
        .update(schema.installerVariationRequests)
        .set({ invoiceId: row!.id, updatedAt: now })
        .where(inArray(schema.installerVariationRequests.id, usableVariations.map((v) => v.id)));
    }

    const attachments = [{ filename: `invoice-${invoiceNumber}.pdf`, content: pdfBuffer.toString("base64") }];
    const subject = `Invoice #${invoiceNumber} from ${abn.billName}, Job #${jobRef(job)}`;
    const bodyHtml = `<p>Invoice #${invoiceNumber} for job ${jobRef(job)}, task ${taskRef(jobRef(job), task.seq)} "${task.title}".</p><p>Total: $${total.toFixed(2)}${installer.gstRegistered ? " inc GST" : ""}.</p>`;
    const bodyText = `Invoice #${invoiceNumber} for job ${jobRef(job)}, task ${taskRef(jobRef(job), task.seq)} "${task.title}". Total: $${total.toFixed(2)}${installer.gstRegistered ? " inc GST" : ""}.`;

    /*
     * Submitting and DELIVERING are two different things. The row and the PDF
     * are saved above, so a failed send must never throw away a submitted
     * invoice. It must not be reported as sent either: record what actually
     * left the building so the app can say so and offer to send it again.
     */
    const toTerra = await sendEmail({ to: BILLING_EMAIL, subject, html: bodyHtml, text: bodyText, attachments });
    const toInstaller = installer.invoiceEmail
      ? await sendEmail({ to: installer.invoiceEmail, subject, html: bodyHtml, text: bodyText, attachments })
      : null;

    const delivery = {
      emailedToTerraAt: toTerra.ok ? now : null,
      emailedToInstallerAt: toInstaller?.ok ? now : null,
      emailError: toTerra.ok ? null : toTerra.reason,
    };
    const [saved] = await db
      .update(schema.installerInvoices)
      .set(delivery)
      .where(eq(schema.installerInvoices.id, row!.id))
      .returning();

    return saved ?? { ...row!, ...delivery };
  }),

  /** My past invoices and where each one sits in the payment lifecycle. */
  myInvoices: installerOnly.handler(async ({ context }) => {
    return db
      .select()
      .from(schema.installerInvoices)
      .where(eq(schema.installerInvoices.installerId, context.installerId))
      .orderBy(desc(schema.installerInvoices.submittedAt));
  }),

  /** A downloadable link for one of my own invoices. */
  downloadUrl: installerOnly.input(z.object({ invoiceId: z.number() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(schema.installerInvoices)
      .where(and(eq(schema.installerInvoices.id, input.invoiceId), eq(schema.installerInvoices.installerId, context.installerId)));
    if (!row || !row.pdfKey) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
    return { url: await signGet(row.pdfKey) };
  }),

  /**
   * Send a submitted invoice to Terra again. The invoice already exists and is
   * locked, so this only re-attaches the stored PDF: nothing is recalculated
   * and no numbers can change. It exists because a send can fail on its own
   * after a successful submit, and the installer needs a way out of that
   * without re-doing the job card.
   */
  resendToTerra: installerOnly.input(z.object({ invoiceId: z.number() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(schema.installerInvoices)
      .where(and(eq(schema.installerInvoices.id, input.invoiceId), eq(schema.installerInvoices.installerId, context.installerId)));
    if (!row || !row.pdfKey) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });

    const pdfBuffer = await getObject(row.pdfKey);
    const [jobRow] = row.jobId ? await db.select({ number: schema.jobs.number, displayNumber: schema.jobs.displayNumber }).from(schema.jobs).where(eq(schema.jobs.id, row.jobId)) : [];
    const jobNo = jobRow ? jobRef(jobRow) : String(row.jobNumber);
    const attachments = [{ filename: `invoice-${row.invoiceNumber}.pdf`, content: pdfBuffer.toString("base64") }];
    const subject = `Invoice #${row.invoiceNumber} from ${billNameOf(row)}, Job #${jobNo}`;
    const bodyHtml = `<p>Invoice #${row.invoiceNumber} for job #${jobNo}, task "${row.taskTitle}".</p><p>Total: ${row.total.toFixed(2)}${row.gstRegistered ? " inc GST" : ""}.</p>`;
    const bodyText = `Invoice #${row.invoiceNumber} for job #${jobNo}, task "${row.taskTitle}". Total: ${row.total.toFixed(2)}${row.gstRegistered ? " inc GST" : ""}.`;

    const now = new Date();
    const toTerra = await sendEmail({ to: BILLING_EMAIL, subject, html: bodyHtml, text: bodyText, attachments });
    const [saved] = await db
      .update(schema.installerInvoices)
      .set({
        emailedToTerraAt: toTerra.ok ? now : row.emailedToTerraAt,
        emailError: toTerra.ok ? null : toTerra.reason,
        updatedAt: now,
      })
      .where(eq(schema.installerInvoices.id, row.id))
      .returning();
    if (!toTerra.ok) throw new ORPCError("BAD_GATEWAY", { message: toTerra.reason });
    return saved;
  }),

  /** REQUEST VARIATION / EXTRA. Goes to Terra for approval, never self-approved. */
  requestVariation: installerOnly
    .input(z.object({ taskId: z.number(), description: z.string().min(1), amount: z.number().positive() }))
    .handler(async ({ input, context }) => {
      await ownTaskOrThrow(input.taskId, context.installerId);
      const [row] = await db
        .insert(schema.installerVariationRequests)
        .values({
          taskId: input.taskId,
          installerId: context.installerId,
          description: input.description,
          amount: input.amount,
          status: "pending",
        })
        .returning();
      return row;
    }),

  /** My variation requests on a task, so I can see what's pending/approved. */
  myVariations: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    await ownTaskOrThrow(input.taskId, context.installerId);
    return db
      .select()
      .from(schema.installerVariationRequests)
      .where(
        and(
          eq(schema.installerVariationRequests.taskId, input.taskId),
          eq(schema.installerVariationRequests.installerId, context.installerId),
        ),
      )
      .orderBy(desc(schema.installerVariationRequests.requestedAt));
  }),

  /* --------------------------- office/admin --------------------------- */

  /** Every subcontractor invoice, filterable for the accounts screen. */
  adminList: staffOnly
    .input(
      z.object({
        installerId: z.number().optional(),
        jobId: z.number().optional(),
        status: z.enum(["submitted", "approved", "scheduled_for_payment", "paid"]).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }).default({}),
    )
    .handler(async ({ input, context }) => {
      const where = [] as any[];
      if (input.installerId) where.push(eq(schema.installerInvoices.installerId, input.installerId));
      if (input.jobId) where.push(eq(schema.installerInvoices.jobId, input.jobId));
      if (input.status) where.push(eq(schema.installerInvoices.status, input.status));
      if (input.from) where.push(gte(schema.installerInvoices.submittedAt, new Date(input.from)));
      if (input.to) where.push(lte(schema.installerInvoices.submittedAt, new Date(input.to)));
      const rows = await db
        .select()
        .from(schema.installerInvoices)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(schema.installerInvoices.submittedAt));
      // Office sees the invoices. Bank details stay with Admin.
      if (context.actor.role === "admin") return rows;
      return rows.map((r) => ({ ...r, bankAccountName: null, bankBsb: null, bankAccountNumber: null }));
    }),

  /** A signed link to any invoice PDF, for accounts. Office gets it too (Damien, 7 Oct), bank details and all. */
  adminDownloadUrl: staffOnly.input(z.object({ invoiceId: z.number() })).handler(async ({ input }) => {
    const [row] = await db.select().from(schema.installerInvoices).where(eq(schema.installerInvoices.id, input.invoiceId));
    if (!row || !row.pdfKey) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
    return { url: await signGet(row.pdfKey) };
  }),

  /** Move an invoice through Approved → Scheduled for Payment → Paid. */
  adminSetStatus: staffOnly
    .input(
      z.object({
        invoiceId: z.number(),
        status: z.enum(["submitted", "approved", "scheduled_for_payment", "paid"]),
        adminNotes: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const now = new Date();
      const stamps: Record<string, Date> = {};
      if (input.status === "approved") stamps.approvedAt = now;
      if (input.status === "scheduled_for_payment") stamps.scheduledAt = now;
      if (input.status === "paid") stamps.paidAt = now;
      const [row] = await db
        .update(schema.installerInvoices)
        .set({ status: input.status, adminNotes: input.adminNotes ?? undefined, ...stamps, updatedAt: now })
        .where(eq(schema.installerInvoices.id, input.invoiceId))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
      return row;
    }),

  /** Pending variation requests waiting on the office. */
  adminListVariations: staffOnly
    .input(z.object({ status: z.enum(["pending", "approved", "rejected"]).optional() }).default({}))
    .handler(async ({ input }) => {
      return db
        .select()
        .from(schema.installerVariationRequests)
        .where(input.status ? eq(schema.installerVariationRequests.status, input.status) : undefined)
        .orderBy(desc(schema.installerVariationRequests.requestedAt));
    }),

  /** Approve or reject an installer's requested extra. Only approved amounts ever become invoiceable. */
  adminDecideVariation: staffOnly
    .input(
      z.object({
        id: z.number(),
        approve: z.boolean(),
        adminNotes: z.string().nullable().optional(),
        decidedByName: z.string().min(1),
        amount: z.number().positive().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const now = new Date();
      const [row] = await db
        .update(schema.installerVariationRequests)
        .set({
          status: input.approve ? "approved" : "rejected",
          decidedAt: now,
          decidedByName: input.decidedByName,
          adminNotes: input.adminNotes ?? undefined,
          ...(input.amount != null ? { amount: input.amount } : {}),
          updatedAt: now,
        })
        .where(eq(schema.installerVariationRequests.id, input.id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Variation request not found" });
      return row;
    }),
};

/** The name a stored bill went out in. Bills from before notes 18.64 have no legal name. */
export function billNameOf(row: { legalName: string | null; tradingName: string; installerName: string }) {
  if (!row.legalName) return row.tradingName || row.installerName;
  return row.tradingName ? `${row.legalName} t/a ${row.tradingName}` : row.legalName;
}
