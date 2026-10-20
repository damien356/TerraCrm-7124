import { z } from "zod";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { jobNumberSql } from "../lib/job-ref";
import { AI_ACTION_KINDS, AI_AGENTS, resolveAiActions, type AiActionKind, type AiAgent } from "../lib/ai-actions";

/* ---------------------------------------------------------------------------
 * Step 1 (20 Oct): the AI log and the "Waiting for you" tray. Admin only,
 * because the rows carry supplier costs. Nothing here sends anything.
 * ------------------------------------------------------------------------- */

const select = {
  id: schema.aiActions.id,
  agent: schema.aiActions.agent,
  kind: schema.aiActions.kind,
  status: schema.aiActions.status,
  title: schema.aiActions.title,
  detail: schema.aiActions.detail,
  path: schema.aiActions.path,
  jobId: schema.aiActions.jobId,
  jobNumber: jobNumberSql,
  supplierId: schema.aiActions.supplierId,
  poId: schema.aiActions.poId,
  invoiceId: schema.aiActions.invoiceId,
  requestId: schema.aiActions.requestId,
  resolvedAt: schema.aiActions.resolvedAt,
  resolvedBy: schema.aiActions.resolvedBy,
  createdAt: schema.aiActions.createdAt,
};

type Row = { agent: string; kind: string };
const labelled = <T extends Row>(r: T) => ({
  ...r,
  agentLabel: AI_AGENTS[r.agent as AiAgent] ?? r.agent,
  kindLabel: AI_ACTION_KINDS[r.kind as AiActionKind]?.label ?? r.kind,
});

export const aiActions = {
  /** What is waiting on a person, oldest first so nothing sinks. */
  tray: adminOnly.handler(async () => {
    const rows = await db
      .select(select)
      .from(schema.aiActions)
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.aiActions.jobId))
      .where(eq(schema.aiActions.status, "waiting"))
      .orderBy(schema.aiActions.createdAt, schema.aiActions.id)
      .limit(200);
    return { total: rows.length, items: rows.map(labelled) };
  }),

  /** How many are waiting, for the badge on the nav. */
  count: adminOnly.handler(async () => {
    const [r] = await db.select({ n: sql<number>`count(*)` }).from(schema.aiActions).where(eq(schema.aiActions.status, "waiting"));
    return { waiting: Number(r?.n ?? 0) };
  }),

  /** Everything the helpers did, newest first, 50 at a time. */
  log: adminOnly
    .input(z.object({ agent: z.enum(["purchasing", "invoices", "mail"]).nullable().default(null), before: z.number().int().nullable().default(null) }).default({ agent: null, before: null }))
    .handler(async ({ input }) => {
      const rows = await db
        .select(select)
        .from(schema.aiActions)
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.aiActions.jobId))
        .where(and(input.agent ? eq(schema.aiActions.agent, input.agent) : undefined, input.before ? lt(schema.aiActions.id, input.before) : undefined))
        .orderBy(desc(schema.aiActions.id))
        .limit(51);
      const more = rows.length > 50;
      return { items: rows.slice(0, 50).map(labelled), nextBefore: more ? rows[49]!.id : null };
    }),

  /** Done (the person dealt with it) or dismissed (leave it). Only waiting rows move. */
  resolve: adminOnly
    .input(z.object({ ids: z.array(z.number().int()).min(1).max(200), how: z.enum(["done", "dismissed"]) }))
    .handler(async ({ input, context }) => {
      const moved = await resolveAiActions(input.ids, context.actor.name, input.how);
      return { moved };
    }),
};
