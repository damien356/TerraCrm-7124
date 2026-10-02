import { createHash } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { readSupplierPdf } from "../agent/supplier-docs";
import { putObject } from "./s3";
import { getMessage, header, listMessageIds, MailboxNotConnected, mailboxFor, pdfBytes, pdfParts } from "./gmail";
import { isTerraOwn, recordInvoice, recordStatement } from "./invoice-match";
import { sendAsTeam } from "./agent-mail";

/* ---------------------------------------------------------------------------
 * The email agent. Every 15 minutes it reads new mail with a PDF in billing@,
 * damien@ and team@, pulls out invoices and statements, and matches them.
 *
 * It only ever reads. It never marks anything read, moves it or labels it,
 * because the scope it holds cannot. The only thing it sends is a "please
 * send invoice X to billing@" request, from team@, and only once someone has
 * okayed it (or auto-send has been switched on in Settings).
 *
 * Same gate as the reminders: the dev server shares the live database, so the
 * agent only runs in the published server.
 *   MAIL_AGENT=off   never run
 *   MAIL_AGENT=on    run regardless of the entry script
 * ------------------------------------------------------------------------- */

const EVERY_MS = 15 * 60_000;
const FIRST_LOOK_DAYS = 60;
const OVERLAP_S = 2 * 86_400;
const PER_RUN = 40;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

export const AUTO_SEND_KEY = "invoice_requests_auto";

function queryFor(address: string, since: number) {
  const base = `has:attachment filename:pdf -in:sent -in:drafts after:${since}`;
  // billing@ is nothing but supplier paperwork. The other two get everything, so narrow them.
  return address.startsWith("billing@") ? base : `${base} (invoice OR statement OR "tax invoice" OR credit OR remittance)`;
}

export type MailboxRun = { address: string; looked: number; read: number; invoices: number; statements: number; errors: number; note: string };

export async function checkMailbox(address: string, limit = PER_RUN): Promise<MailboxRun> {
  const run: MailboxRun = { address, looked: 0, read: 0, invoices: 0, statements: 0, errors: 0, note: "" };
  const [acct] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.address, address));
  if (!acct?.refreshTokenSealed || !mailboxFor(address)) return { ...run, note: "not connected" };

  const startedAt = Math.floor(Date.now() / 1000);
  const since = acct.syncedThrough ? acct.syncedThrough - OVERLAP_S : startedAt - FIRST_LOOK_DAYS * 86_400;
  let ids: string[];
  try {
    ids = (await listMessageIds(address, queryFor(address, since), 500)).reverse(); // oldest first
  } catch (e) {
    // A lost sign-in has already stored its own plain-English reason. Keep it.
    const keep = e instanceof MailboxNotConnected;
    await db
      .update(schema.mailAccounts)
      .set({ ...(keep ? {} : { lastError: String((e as Error).message ?? e) }), lastCheckedAt: new Date() })
      .where(eq(schema.mailAccounts.id, acct.id));
    return { ...run, errors: 1, note: String((e as Error).message ?? e) };
  }

  const seen = await db
    .select({ gmailId: schema.mailMessages.gmailId, status: schema.mailMessages.status, attempts: schema.mailMessages.attempts, id: schema.mailMessages.id })
    .from(schema.mailMessages)
    .where(eq(schema.mailMessages.accountId, acct.id));
  const seenMap = new Map(seen.map((s) => [s.gmailId, s]));

  let capped = false;
  for (const id of ids) {
    const prior = seenMap.get(id);
    if (prior && (prior.status !== "error" || prior.attempts >= 3)) continue;
    if (run.looked >= limit) {
      capped = true;
      break;
    }
    run.looked++;
    try {
      const r = await readOne(acct.id, address, id, prior?.id ?? null);
      run.read++;
      run.invoices += r.invoices;
      run.statements += r.statements;
    } catch (e) {
      if (e instanceof MailboxNotConnected) throw e;
      run.errors++;
      const msg = String((e as Error).message ?? e).slice(0, 500);
      // readOne writes the row (and counts the try) before it reads, so this usually just marks it.
      // The insert is for a failure before that, like Gmail not returning the message.
      await db
        .insert(schema.mailMessages)
        .values({ accountId: acct.id, gmailId: id, status: "error", note: msg, attempts: 1 })
        .onConflictDoUpdate({
          target: [schema.mailMessages.accountId, schema.mailMessages.gmailId],
          // Same count whether or not readOne got far enough to bump it.
          set: { status: "error", note: msg, attempts: (prior?.attempts ?? 0) + 1, updatedAt: new Date() },
        });
    }
  }

  await db
    .update(schema.mailAccounts)
    .set({ lastCheckedAt: new Date(), lastError: null, ...(capped ? {} : { syncedThrough: startedAt }), updatedAt: new Date() })
    .where(eq(schema.mailAccounts.id, acct.id));
  run.note = capped ? "more to read, carrying on next round" : "up to date";
  return run;
}

async function readOne(accountId: number, address: string, gmailId: string, priorId: number | null) {
  const msg = await getMessage(address, gmailId);
  const from = header(msg, "From");
  const subject = header(msg, "Subject");
  const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)) : null;
  const pdfs = pdfParts(msg).slice(0, 6);

  const base = { accountId, gmailId, threadId: msg.threadId ?? null, fromAddress: from.slice(0, 300), subject: subject.slice(0, 300), receivedAt };
  // Every try is counted here, so a message that keeps failing is left alone after 3.
  const [row] = priorId
    ? await db
        .update(schema.mailMessages)
        .set({ ...base, status: "done", note: "reading", attempts: sql`${schema.mailMessages.attempts} + 1`, updatedAt: new Date() })
        .where(eq(schema.mailMessages.id, priorId))
        .returning()
    : await db.insert(schema.mailMessages).values({ ...base, status: "done", note: "reading", attempts: 1 }).returning();
  const mailMessageId = row!.id;

  const found: string[] = [];
  let invoices = 0;
  let statements = 0;
  for (const part of pdfs) {
    if ((part.body?.size ?? 0) > MAX_PDF_BYTES) {
      found.push(`${part.filename} too big to read`);
      continue;
    }
    const bytes = await pdfBytes(address, msg, part);
    const r = await ingestPdf(bytes, { filename: part.filename || "document.pdf", from, subject, mailMessageId });
    invoices += r.invoices;
    statements += r.statements;
    found.push(...r.found);
  }
  await db
    .update(schema.mailMessages)
    .set({ status: pdfs.length ? "done" : "skipped", note: (found.join("; ") || "no PDF").slice(0, 900), updatedAt: new Date() })
    .where(eq(schema.mailMessages.id, mailMessageId));
  return { invoices, statements };
}

/**
 * One PDF, from email or uploaded by hand: store it, read it, record what is
 * in it. The same PDF is only ever read once (it often lands in two mailboxes).
 */
export async function ingestPdf(bytes: Buffer, ctx: { filename: string; from: string; subject: string; mailMessageId: number | null }) {
  const found: string[] = [];
  let invoices = 0;
  let statements = 0;
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const pdfKey = `supplier-docs/${sha}.pdf`;
  const pdfName = ctx.filename.slice(0, 120);

  const [inv] = await db.select({ id: schema.supplierInvoices.id }).from(schema.supplierInvoices).where(eq(schema.supplierInvoices.pdfKey, pdfKey)).limit(1);
  const [st] = await db.select({ id: schema.supplierStatements.id }).from(schema.supplierStatements).where(eq(schema.supplierStatements.pdfKey, pdfKey)).limit(1);
  if (inv || st) return { invoices, statements, found: [`${pdfName} already read`] };

  const docs = await readSupplierPdf(bytes, { filename: pdfName, from: ctx.from, subject: ctx.subject });
  const useful = docs.filter((d) => ["invoice", "credit", "statement"].includes(d.docType) && !isTerraOwn(d.supplierName));
  if (!useful.length) return { invoices, statements, found: [`${pdfName}: ${docs.map((d) => d.docType).join(", ") || "nothing"}`] };

  if (process.env.MAIL_AGENT_STORE_PDFS !== "off") await putObject(pdfKey, bytes, "application/pdf", pdfName);
  const meta = { fromAddress: ctx.from, mailMessageId: ctx.mailMessageId, pdfKey, pdfName };
  for (const d of useful) {
    if (d.docType === "statement") {
      const r = await recordStatement(d, meta);
      statements++;
      found.push(`statement from ${d.supplierName ?? "?"}${r.requested ? `, ${r.requested} missing` : ""}`);
    } else {
      const r = await recordInvoice(d, meta);
      if ("id" in r) invoices++;
      found.push("duplicate" in r ? `${d.docType} ${d.invoiceNumber} already in Ops` : "skipped" in r ? `${d.docType} skipped: ${r.skipped}` : `${d.docType} ${d.invoiceNumber}`);
    }
  }
  return { invoices, statements, found };
}

/* ------------------------------ invoice requests --------------------------- */

export async function sendInvoiceRequest(id: number) {
  const [r] = await db.select().from(schema.invoiceRequests).where(eq(schema.invoiceRequests.id, id));
  if (!r) throw new Error("Request not found");
  if (r.status === "sent" || r.status === "received") return r;
  if (!r.toAddress) throw new Error("No email on file for this supplier. Add one on the Suppliers page.");
  try {
    const out = await sendAsTeam({ to: r.toAddress, subject: r.subject, text: r.body });
    const [u] = await db
      .update(schema.invoiceRequests)
      .set({ status: "sent", sentAt: new Date(), gmailMessageId: out.id, error: null, updatedAt: new Date() })
      .where(eq(schema.invoiceRequests.id, id))
      .returning();
    return u!;
  } catch (e) {
    await db.update(schema.invoiceRequests).set({ error: String((e as Error).message ?? e).slice(0, 300), updatedAt: new Date() }).where(eq(schema.invoiceRequests.id, id));
    throw e;
  }
}

async function autoSendOn() {
  const [s] = await db.select().from(schema.settings).where(eq(schema.settings.key, AUTO_SEND_KEY));
  return s?.value === "on";
}

/* ---------------------------------- loop ---------------------------------- */

let running = false;

export async function runMailAgent(limit = PER_RUN) {
  if (running) return { skipped: "already running" as const };
  running = true;
  try {
    const accts = await db
      .select({ address: schema.mailAccounts.address })
      .from(schema.mailAccounts)
      .where(isNotNull(schema.mailAccounts.refreshTokenSealed));
    const runs: MailboxRun[] = [];
    for (const a of accts) {
      try {
        runs.push(await checkMailbox(a.address, limit));
      } catch (e) {
        runs.push({ address: a.address, looked: 0, read: 0, invoices: 0, statements: 0, errors: 1, note: String((e as Error).message ?? e) });
      }
    }
    let sent = 0;
    if (await autoSendOn()) {
      const waiting = await db
        .select({ id: schema.invoiceRequests.id })
        .from(schema.invoiceRequests)
        .where(and(eq(schema.invoiceRequests.status, "waiting_ok"), isNotNull(schema.invoiceRequests.toAddress)));
      for (const w of waiting) {
        try {
          await sendInvoiceRequest(w.id);
          sent++;
        } catch {
          /* error stored on the row, shown in Ops */
        }
      }
    }
    return { runs, sent };
  } finally {
    running = false;
  }
}

function isPublishedServer() {
  const argv = (process as unknown as { argv?: string[] }).argv ?? [];
  return (argv[1] ?? "").endsWith("__server.ts");
}

let booted = false;
export function bootMailAgent() {
  if (booted) return;
  booted = true;
  const mode = process.env.MAIL_AGENT;
  if (mode === "off") return void console.log("[mail-agent] disabled by MAIL_AGENT=off");
  if (mode !== "on" && !isPublishedServer()) return void console.log("[mail-agent] idle, not the published server");
  console.log("[mail-agent] checking mailboxes every 15 minutes");
  setInterval(() => void runMailAgent().catch((e) => console.error("[mail-agent]", e)), EVERY_MS);
  setTimeout(() => void runMailAgent().catch((e) => console.error("[mail-agent]", e)), 60_000);
}
