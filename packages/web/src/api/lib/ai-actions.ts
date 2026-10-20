import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * Step 1 (20 Oct): the shared AI log and the "Waiting for you" tray.
 *
 * Every Ops helper writes here when it does something, or wants a person to
 * do something. One table, one list, so Damien can see in one place what the
 * helpers did and what is waiting on him.
 *
 *   status waiting    on the tray until a person acts on it
 *   status done       logged only, or the person has acted
 *   status dismissed  a person said "leave it"
 *
 * Writing a row never sends anything to anyone. A failed write is logged to
 * the console and never stops the work it describes.
 * ------------------------------------------------------------------------- */

export const AI_AGENTS = {
  purchasing: "Purchasing helper",
  invoices: "Invoice matching",
  mail: "Mail reader",
} as const;
export type AiAgent = keyof typeof AI_AGENTS;

export const AI_ACTION_KINDS = {
  po_drafted: { agent: "purchasing", label: "PO drafted" },
  po_skipped: { agent: "purchasing", label: "Materials left off a PO" },
  invoice_labelled: { agent: "invoices", label: "Invoice labelled" },
  request_linked: { agent: "invoices", label: "Invoice request linked to a job" },
  request_sent: { agent: "mail", label: "Invoice request sent" },
} as const satisfies Record<string, { agent: AiAgent; label: string }>;
export type AiActionKind = keyof typeof AI_ACTION_KINDS;

export type AiActionInput = {
  kind: AiActionKind;
  title: string;
  detail?: string;
  waiting?: boolean;
  path?: string | null;
  jobId?: number | null;
  supplierId?: number | null;
  poId?: number | null;
  invoiceId?: number | null;
  requestId?: number | null;
  data?: Record<string, unknown>;
};

/** Log one thing a helper did. Returns the row id, or null if the write failed. */
export async function logAiAction(a: AiActionInput): Promise<number | null> {
  try {
    const [row] = await db
      .insert(schema.aiActions)
      .values({
        agent: AI_ACTION_KINDS[a.kind].agent,
        kind: a.kind,
        status: a.waiting ? "waiting" : "done",
        title: a.title.slice(0, 300),
        detail: (a.detail ?? "").slice(0, 4000),
        path: a.path ?? null,
        jobId: a.jobId ?? null,
        supplierId: a.supplierId ?? null,
        poId: a.poId ?? null,
        invoiceId: a.invoiceId ?? null,
        requestId: a.requestId ?? null,
        data: JSON.stringify(a.data ?? {}),
      })
      .returning({ id: schema.aiActions.id });
    return row?.id ?? null;
  } catch (e) {
    console.error("[ai-actions] could not log:", (e as Error).message ?? e);
    return null;
  }
}

/**
 * Take the tray items for a PO off the tray, because a person has dealt with
 * the PO (sent it, marked it sent, removed the draft or cancelled it).
 */
export async function resolveAiActionsForPo(poId: number, by: string, how: "done" | "dismissed" = "done") {
  try {
    await db
      .update(schema.aiActions)
      .set({ status: how, resolvedAt: new Date(), resolvedBy: by, updatedAt: new Date() })
      .where(and(eq(schema.aiActions.poId, poId), eq(schema.aiActions.status, "waiting")));
  } catch (e) {
    console.error("[ai-actions] could not resolve:", (e as Error).message ?? e);
  }
}

/** A person acted on tray items, or said leave them. Only waiting rows move. */
export async function resolveAiActions(ids: number[], by: string, how: "done" | "dismissed") {
  if (!ids.length) return 0;
  const rows = await db
    .update(schema.aiActions)
    .set({ status: how, resolvedAt: new Date(), resolvedBy: by, updatedAt: new Date() })
    .where(and(inArray(schema.aiActions.id, ids), eq(schema.aiActions.status, "waiting")))
    .returning({ id: schema.aiActions.id });
  return rows.length;
}
