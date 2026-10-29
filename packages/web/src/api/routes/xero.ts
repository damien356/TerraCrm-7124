import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import {
  chooseTenant,
  isDemoCompany,
  logXero,
  tenantsOf,
  askedScopes, testPaymentsScope,
  xeroApi,
  xeroConfigured,
  xeroConnectUrl,
  xeroDisconnect,
  xeroReady,
  xeroRedirectUri,
  xeroRow,
} from "../lib/xero";
import {
  PUSHABLE_STATUSES,
  pushBlocker,
  pushInvoiceToXero,
  syncFromXero,
  XERO_ACCOUNT_KEY,
  XERO_AUTO_KEY,
  XERO_CONTRA_KEY,
  XERO_MATERIALS_KEY,
  XERO_STATUS_KEY,
  asSalesCategory,
  SALES_CATEGORY_LABEL,
  salesAccountFor,
  xeroSettings,
} from "../lib/xero-invoices";
import { contraAccountProblem } from "../lib/contras";

/**
 * Settings, Xero. Connect the Terra Ops Xero app, pick the organisation, and
 * choose how invoices go across. No route ever returns a token.
 */

const ACCOUNT_NAME_KEY = "xero_sales_account_name";
const MATERIALS_NAME_KEY = "xero_materials_account_name";
const CONTRA_NAME_KEY = "xero_contra_account_name";
const NAME_KEYS = [ACCOUNT_NAME_KEY, MATERIALS_NAME_KEY, CONTRA_NAME_KEY];

type XAccount = { Code?: string; Name?: string; Type?: string; Status?: string };

/** One active income account in the connected organisation, as "200 Sales". Read only: Ops never creates or changes an account. */
async function incomeAccount(code: string, what: string) {
  const r = await xeroApi<{ Accounts?: XAccount[] }>("Accounts", { query: { where: `Code=="${code}"` } });
  const a = (r.Accounts ?? []).find((x) => x.Code === code && x.Status !== "ARCHIVED");
  if (!a) throw new Error(`Xero has no active account ${code} for ${what}. Check the code in Xero's chart of accounts.`);
  if (!["REVENUE", "SALES", "OTHERINCOME"].includes(a.Type ?? "")) throw new Error(`Account ${code} (${a.Name}) is not an income account in Xero, so it can not take ${what}.`);
  return `${a.Code} ${a.Name}`;
}

async function accountName(code: string) {
  const r = await xeroApi<{ Accounts?: XAccount[] }>("Accounts", { query: { where: `Code=="${code}"` } });
  const a = (r.Accounts ?? []).find((x) => x.Code === code);
  return a ? `${a.Code} ${a.Name}` : null;
}

async function putSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

async function profileId(userId: string) {
  const [p] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.userId, userId));
  return p?.id ?? null;
}

const fail = (e: unknown) => new ORPCError("BAD_REQUEST", { message: String((e as Error)?.message ?? e).slice(0, 400) });

export const xero = {
  status: adminOnly.handler(async () => {
    const row = await xeroRow();
    const s = await xeroSettings();
    const names = new Map((await db.select().from(schema.settings).where(inArray(schema.settings.key, NAME_KEYS))).map((r) => [r.key, r.value]));
    const connected = Boolean(row?.refreshTokenSealed);
    const invs = await db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        status: schema.invoices.status,
        total: schema.invoices.total,
        jobId: schema.invoices.jobId,
        xeroInvoiceId: schema.invoices.xeroInvoiceId,
        xeroIssue: schema.invoices.xeroIssue,
        salesCategory: schema.invoices.salesCategory,
      })
      .from(schema.invoices);
    const pushable = new Set<string>(PUSHABLE_STATUSES);
    const notYet = invs.filter((i) => !i.xeroInvoiceId && pushable.has(i.status));
    const log = await db.select().from(schema.xeroSyncLog).orderBy(desc(schema.xeroSyncLog.id)).limit(20);
    return {
      configured: xeroConfigured(),
      redirectUri: xeroRedirectUri(),
      scopes: askedScopes(),
      /** A Demo Company test copy (XERO_TEST_PAYMENTS_SCOPE=on). Never on live. */
      demoOnly: testPaymentsScope(),
      connected,
      tenant: connected && row?.tenantId ? { id: row.tenantId, name: row.tenantName, demo: isDemoCompany(row.tenantName) } : null,
      tenants: connected ? tenantsOf(row).map((t) => ({ id: t.tenantId, name: t.tenantName, demo: isDemoCompany(t.tenantName) })) : [],
      connectedAt: connected ? (row?.connectedAt ?? null) : null,
      lastSyncAt: row?.lastSyncAt ?? null,
      // Kept after Xero drops the sign-in, so Settings can say why.
      lastError: row?.lastError ?? null,
      settings: {
        ...s,
        accountName: names.get(ACCOUNT_NAME_KEY) ?? null,
        materialsAccountName: names.get(MATERIALS_NAME_KEY) ?? null,
        contraAccountName: names.get(CONTRA_NAME_KEY) ?? null,
        /** Both sales accounts were found in the connected organisation at the last save. False: Save checks them. */
        checked: names.has(ACCOUNT_NAME_KEY) && names.has(MATERIALS_NAME_KEY),
      },
      counts: {
        inXero: invs.filter((i) => i.xeroInvoiceId).length,
        notYet: notYet.length,
        issues: invs.filter((i) => i.xeroIssue).length,
      },
      notYet: notYet.slice(0, 50).map((i) => {
        const category = asSalesCategory(i.salesCategory);
        // Task H: the list shows where each one will land before it is sent.
        return { id: i.id, number: i.number, status: i.status, total: i.total, jobId: i.jobId, salesCategory: category, categoryLabel: SALES_CATEGORY_LABEL[category], salesAccount: salesAccountFor(category, s) };
      }),
      issues: invs.filter((i) => i.xeroIssue).map((i) => ({ id: i.id, number: i.number, jobId: i.jobId, issue: i.xeroIssue })),
      log: log.map((l) => ({ id: l.id, kind: l.kind, ok: l.ok, detail: l.detail, byName: l.byName, invoiceId: l.invoiceId, at: l.createdAt })),
    };
  }),

  /** The Xero sign-in link. Pick Terra Flooring on Xero's screen, not the Demo Company. */
  connect: adminOnly.handler(async ({ context }) => {
    if (!xeroConfigured()) throw new ORPCError("PRECONDITION_FAILED", { message: "Xero isn't set up yet. The Client ID and secret need adding first." });
    return { url: xeroConnectUrl(await profileId(context.actor.userId)) };
  }),

  chooseTenant: adminOnly.input(z.object({ tenantId: z.string().min(1) })).handler(async ({ input, context }) => {
    try {
      const t = await chooseTenant(input.tenantId, context.actor.name || "Admin");
      return { ok: true, name: t.tenantName };
    } catch (e) {
      throw fail(e);
    }
  }),

  disconnect: adminOnly.handler(async ({ context }) => {
    await xeroDisconnect(context.actor.name || "Admin");
    return { ok: true };
  }),

  /**
   * The two sales accounts (customer 200, installer materials 204), the
   * contra clearing account (810), Draft or Awaiting payment, and whether the
   * first email sends it to Xero. Every account is checked against the
   * connected organisation on every save. Read only: nothing is created or
   * changed in Xero.
   */
  saveSettings: adminOnly
    .input(
      z.object({
        accountCode: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9.-]+$/, "Account codes are letters and numbers only."),
        /** Task H: installer materials sales. Left out: unchanged. */
        materialsAccount: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9.-]+$/, "Account codes are letters and numbers only.").optional(),
        pushStatus: z.enum(["DRAFT", "AUTHORISED"]),
        autoPush: z.boolean(),
        /** Task G: the contra clearing account. Empty: none. */
        contraAccount: z
          .string()
          .trim()
          .max(10)
          .regex(/^[A-Za-z0-9.-]*$/, "Account codes are letters and numbers only.")
          .optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const before = await xeroSettings();
      const contra = input.contraAccount === undefined ? before.contraAccount : input.contraAccount;
      const materials = input.materialsAccount ?? before.materialsAccount;
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      if (same(materials, input.accountCode)) throw fail(new Error("Installer materials need their own account, not the customer sales account."));
      if (contra && (same(contra, input.accountCode) || same(contra, materials))) throw fail(new Error("The contra account can not be a sales account."));
      const found: Record<string, string | null> = { [ACCOUNT_NAME_KEY]: null, [MATERIALS_NAME_KEY]: null, [CONTRA_NAME_KEY]: null };
      // Checked on every save, not only when it changes: a code saved before Xero was connected was never checked.
      if (await xeroReady()) {
        try {
          found[ACCOUNT_NAME_KEY] = await incomeAccount(input.accountCode, "customer sales");
          found[MATERIALS_NAME_KEY] = await incomeAccount(materials, "installer materials sales");
          if (contra) {
            const problem = await contraAccountProblem(contra);
            if (problem) throw new Error(problem);
            found[CONTRA_NAME_KEY] = await accountName(contra);
          }
        } catch (e) {
          throw fail(e);
        }
      }
      await putSetting(XERO_ACCOUNT_KEY, input.accountCode);
      await putSetting(XERO_MATERIALS_KEY, materials);
      await putSetting(XERO_STATUS_KEY, input.pushStatus);
      await putSetting(XERO_AUTO_KEY, input.autoPush ? "1" : "0");
      await putSetting(XERO_CONTRA_KEY, contra);
      for (const [key, name] of Object.entries(found)) {
        if (name) await putSetting(key, name);
        else await db.delete(schema.settings).where(eq(schema.settings.key, key));
      }
      await logXero(
        "settings",
        true,
        `Customer sales account ${input.accountCode}, installer materials account ${materials}, new invoices go in as ${input.pushStatus === "DRAFT" ? "drafts" : "awaiting payment"}, ${input.autoPush ? "sent to Xero at the first email" : "sent to Xero by hand"}, ${contra ? `contras read from account ${contra}` : "no contra account"}.${found[ACCOUNT_NAME_KEY] ? " Checked in Xero." : " Not checked, Xero is not connected."}`,
        { byName: context.actor.name || "Admin" },
      );
      return { ok: true, accountName: found[ACCOUNT_NAME_KEY], materialsAccountName: found[MATERIALS_NAME_KEY], contraAccountName: found[CONTRA_NAME_KEY] };
    }),

  /** Send one invoice to Xero now. Admin or Office. */
  push: staffOnly.input(z.object({ invoiceId: z.number().int() })).handler(async ({ input, context }) => {
    const r = await pushInvoiceToXero(input.invoiceId, context.actor.name || "Office", context.actor.role);
    if (!r.ok) throw new ORPCError("BAD_REQUEST", { message: r.reason });
    return r;
  }),

  /** Can this invoice go to Xero, and if not, why. For the button on the job page. */
  canPush: staffOnly.input(z.object({ invoiceId: z.number().int() })).handler(async ({ input }) => {
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId));
    if (!inv) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
    const ready = Boolean(await xeroReady());
    return { ready, blocker: ready ? pushBlocker(inv) : "Xero is not connected." };
  }),

  /** Read Xero now instead of waiting for the 30 minute round. */
  checkNow: adminOnly.handler(async ({ context }) => {
    try {
      const r = await syncFromXero(context.actor.name || "Admin");
      if (r.skipped) return { busy: true, checked: 0, recorded: 0, flagged: 0, errors: [] as string[] };
      return { busy: false, checked: r.checked, recorded: r.recorded, flagged: r.flagged, errors: r.errors };
    } catch (e) {
      throw fail(e);
    }
  }),

  /** Is Xero ready for the job page buttons. Any staff member can ask. */
  ready: staffOnly.handler(async () => {
    const row = await xeroReady();
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.invoices)
      .where(and(isNull(schema.invoices.xeroInvoiceId), inArray(schema.invoices.status, [...PUSHABLE_STATUSES])));
    return { ready: Boolean(row), tenantName: row?.tenantName ?? null, demo: isDemoCompany(row?.tenantName), notInXero: n };
  }),
};
