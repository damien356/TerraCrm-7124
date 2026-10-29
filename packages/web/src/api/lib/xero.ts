import { and, asc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db, inDemo } from "../database";
import * as schema from "../database/schema";
import { readState, seal, sealConfigured, signState, unseal } from "./secret-box";

/* ---------------------------------------------------------------------------
 * Xero, the connection (Damien, 28 Oct).
 *
 * What Ops may do in Xero, fixed here in code and not in a setting:
 *   - create a client invoice (ACCREC) for an IQ invoice, numbered as Ops
 *     numbers it, and create the customer contact that invoice needs
 *   - read invoices, contacts, accounts, payments, bank and aged reports
 * Never: supplier bills (Hubdoc enters those), payments, voids, deletes, or
 * changes to a contact that already exists. Anything else needs Damien's okay
 * and a change here.
 *
 * Its own Xero app ("Terra Ops"), apart from Terra Stock's. Apps made after
 * 2 Mar 2026 must ask for granular scopes, so the broad accounting.transactions
 * is never asked for. Xero hands back a new refresh token on every refresh,
 * and the old one stops working, so a refresh runs one at a time and the new
 * token is saved before it is used.
 * ------------------------------------------------------------------------- */

/** Write: invoices (and credit notes, never used), and the contact an invoice needs. Read: the rest. */
export const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.invoices",
  "accounting.contacts",
  "accounting.settings.read",
  "accounting.payments.read",
  "accounting.banktransactions.read",
  "accounting.reports.banksummary.read",
  "accounting.reports.aged.read",
] as const;

/** Without these Ops can not push an invoice, so a sign-in missing one is refused. */
const MUST_HAVE = ["offline_access", "accounting.invoices", "accounting.contacts", "accounting.settings.read"];

const loginBase = () => (process.env.XERO_LOGIN_BASE ?? "https://login.xero.com").replace(/\/+$/, "");
const identityBase = () => (process.env.XERO_IDENTITY_BASE ?? "https://identity.xero.com").replace(/\/+$/, "");
const apiBase = () => (process.env.XERO_API_BASE ?? "https://api.xero.com").replace(/\/+$/, "");

export const xeroConfigured = () => Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET) && sealConfigured();

/** Xero only accepts redirect addresses registered on the app, so this is fixed to the live site. */
export function xeroRedirectUri() {
  const base = (process.env.XERO_OAUTH_BASE ?? process.env.MAIL_OAUTH_BASE ?? "https://ops.terraflooring.com.au").replace(/\/+$/, "");
  return `${base}/api/xero/oauth/callback`;
}

export const isDemoCompany = (name: string | null | undefined) => /^demo company/i.test((name ?? "").trim());

export class XeroNotConnected extends Error {}
export class XeroError extends Error {
  constructor(
    message: string,
    public status = 0,
    public detail: string[] = [],
  ) {
    super(message);
  }
}

export type XeroTenant = { tenantId: string; tenantName: string; tenantType: string; connectionId: string; authEventId?: string };

/* --------------------------------- the log -------------------------------- */

export async function logXero(
  kind: "connect" | "disconnect" | "push" | "link" | "pull" | "error" | "settings",
  ok: boolean,
  detail: string,
  extra: { invoiceId?: number | null; xeroId?: string | null; byName?: string } = {},
) {
  try {
    await db.insert(schema.xeroSyncLog).values({
      kind,
      ok,
      detail: detail.slice(0, 2000),
      invoiceId: extra.invoiceId ?? null,
      xeroId: extra.xeroId ?? null,
      byName: extra.byName ?? "System",
    });
  } catch (e) {
    console.error("[xero] could not write the sync log", e);
  }
}

/* ------------------------------ the one row ------------------------------- */

export async function xeroRow() {
  const [row] = await db.select().from(schema.xeroConnection).orderBy(asc(schema.xeroConnection.id)).limit(1);
  return row ?? null;
}

async function saveRow(values: Partial<typeof schema.xeroConnection.$inferInsert>) {
  const row = await xeroRow();
  if (row) {
    await db
      .update(schema.xeroConnection)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.xeroConnection.id, row.id));
  } else {
    await db.insert(schema.xeroConnection).values({ ...values });
  }
}

export function tenantsOf(row: { tenantsJson: string } | null): XeroTenant[] {
  if (!row) return [];
  try {
    const t = JSON.parse(row.tenantsJson) as XeroTenant[];
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

/* --------------------------------- sign in -------------------------------- */

type OAuthState = { p: number | null; e: number; n: string };

export function xeroConnectUrl(profileId: number | null) {
  if (inDemo()) throw new Error("Xero can't be connected in the demo.");
  const state = signState({ p: profileId, e: Date.now() + 10 * 60_000, n: Math.random().toString(36).slice(2) } satisfies OAuthState);
  const q = new URLSearchParams({
    response_type: "code",
    client_id: process.env.XERO_CLIENT_ID ?? "",
    redirect_uri: xeroRedirectUri(),
    scope: XERO_SCOPES.join(" "),
    state,
  });
  return `${loginBase()}/identity/connect/authorize?${q}`;
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string };

async function tokenCall(body: Record<string, string>): Promise<TokenResponse> {
  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID ?? ""}:${process.env.XERO_CLIENT_SECRET ?? ""}`).toString("base64");
  const res = await fetch(`${identityBase()}/connect/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = new XeroError(String(json.error_description ?? json.error ?? `Xero said ${res.status}`), res.status);
    (err as XeroError & { code?: string }).code = String(json.error ?? "");
    throw err;
  }
  return json as TokenResponse;
}

async function revoke(refreshToken: string) {
  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID ?? ""}:${process.env.XERO_CLIENT_SECRET ?? ""}`).toString("base64");
  await fetch(`${identityBase()}/connect/revocation`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshToken }),
  }).catch(() => {});
}

/** The claims inside Xero's access token. Read only for the scope list and the sign-in's event id, never trusted for access. */
function claimsOf(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function grantedScopes(tok: TokenResponse): string[] {
  if (tok.scope) return tok.scope.split(/\s+/).filter(Boolean);
  const s = claimsOf(tok.access_token).scope;
  return Array.isArray(s) ? s.map(String) : typeof s === "string" ? s.split(/\s+/) : [];
}

async function listConnections(accessToken: string): Promise<XeroTenant[]> {
  const res = await fetch(`${apiBase()}/connections`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  const json = (await res.json().catch(() => [])) as Array<Record<string, string>>;
  if (!res.ok) throw new XeroError(`Xero would not list the organisations (${res.status}).`, res.status);
  return (Array.isArray(json) ? json : [])
    .filter((c) => (c.tenantType ?? "ORGANISATION") === "ORGANISATION")
    .map((c) => ({ tenantId: c.tenantId, tenantName: c.tenantName ?? "", tenantType: c.tenantType ?? "ORGANISATION", connectionId: c.id, authEventId: c.authEventId }));
}

/**
 * The OAuth return. Checks before anything is stored: the state is ours and
 * fresh, Xero granted what an invoice push needs, and nothing beyond what was
 * asked for. Then reads which organisations were connected. With one, it is
 * picked. With more, Settings asks which.
 */
export async function finishXeroConnect(code: string, state: string) {
  if (inDemo()) throw new Error("Xero can't be connected in the demo.");
  const s = readState<OAuthState>(state);
  if (!s || s.e < Date.now()) throw new Error("That sign-in link has expired. Start again from Settings.");

  const tok = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: xeroRedirectUri() });
  const granted = grantedScopes(tok);
  const asked = new Set<string>(XERO_SCOPES);
  const extra = granted.filter((g) => !asked.has(g));
  const missing = MUST_HAVE.filter((m) => !granted.includes(m));
  if (extra.length || missing.length) {
    if (tok.refresh_token) await revoke(tok.refresh_token);
    throw new Error(
      extra.length
        ? `Xero granted more than Ops asked for (${extra.join(", ")}). Nothing was saved.`
        : `Xero did not grant ${missing.join(", ")}. Nothing was saved. Connect again and allow every item.`,
    );
  }
  if (!tok.refresh_token) throw new Error("Xero did not hand back a lasting sign-in. Try connecting again.");

  const all = await listConnections(tok.access_token);
  if (!all.length) {
    await revoke(tok.refresh_token);
    throw new Error("No Xero organisation was picked. Connect again and choose Terra Flooring.");
  }
  const event = String(claimsOf(tok.access_token).authentication_event_id ?? "");
  const justNow = event ? all.filter((t) => t.authEventId === event) : [];
  const prev = await xeroRow();
  const keep = prev?.tenantId && all.some((t) => t.tenantId === prev.tenantId) ? prev.tenantId : null;
  // One organisation, or one just ticked: that one. Otherwise the one already in use, or none until picked.
  const pick = all.length === 1 ? all[0] : justNow.length === 1 ? justNow[0] : (all.find((t) => t.tenantId === keep) ?? null);

  await saveRow({
    refreshTokenSealed: seal(tok.refresh_token),
    scopes: granted.join(" "),
    tenantsJson: JSON.stringify(all),
    tenantId: pick?.tenantId ?? null,
    tenantName: pick?.tenantName ?? "",
    tenantType: pick?.tenantType ?? "",
    xeroConnectionId: pick?.connectionId ?? null,
    connectedByProfileId: s.p,
    connectedAt: new Date(),
    lastError: null,
  });
  cache = { token: tok.access_token, exp: Date.now() + ((tok.expires_in ?? 1800) - 120) * 1000 };
  await logXero("connect", true, pick ? `Connected to ${pick.tenantName}.` : `Connected. ${all.length} organisations, waiting for one to be picked.`);
  if (pick) await releaseOtherTenants(pick.tenantId, "System");
  return { tenantName: pick?.tenantName ?? null, choose: !pick, demo: isDemoCompany(pick?.tenantName) };
}

/**
 * Invoices sent to one organisation mean nothing in another. When the
 * organisation changes (say from the Demo Company to Terra Flooring), Ops lets
 * go of links to any other, so those invoices can be sent again. Nothing in
 * Xero is touched. Going back is safe: a push finds the number already there
 * and links to it instead of making a second one.
 */
async function releaseOtherTenants(tenantId: string, byName: string) {
  const other = and(isNotNull(schema.invoices.xeroInvoiceId), or(isNull(schema.invoices.xeroTenantId), ne(schema.invoices.xeroTenantId, tenantId)));
  const gone = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(other);
  if (!gone.length) return 0;
  await db
    .update(schema.invoices)
    .set({
      xeroInvoiceId: null,
      xeroTenantId: null,
      xeroStatus: null,
      xeroAmountPaid: null,
      xeroAmountDue: null,
      xeroPushedAt: null,
      xeroPushedByName: null,
      xeroSyncedAt: null,
      xeroIssue: null,
      updatedAt: new Date(),
    })
    .where(other);
  await logXero("settings", true, `${gone.length} invoice${gone.length === 1 ? "" : "s"} sent to the other organisation can now be sent to this one.`, { byName });
  return gone.length;
}

/** Pick which of the connected organisations invoices go to. */
export async function chooseTenant(tenantId: string, byName: string) {
  const row = await xeroRow();
  const t = tenantsOf(row).find((x) => x.tenantId === tenantId);
  if (!row?.refreshTokenSealed || !t) throw new Error("That organisation is not connected. Connect to Xero again and tick it.");
  if (row.tenantId === t.tenantId) return t;
  // Contacts matched in one organisation mean nothing in another.
  await saveRow({ tenantId: t.tenantId, tenantName: t.tenantName, tenantType: t.tenantType, xeroConnectionId: t.connectionId, lastError: null });
  await logXero("settings", true, `Invoices now go to ${t.tenantName}.`, { byName });
  await releaseOtherTenants(t.tenantId, byName);
  return t;
}

export async function xeroDisconnect(byName: string) {
  const row = await xeroRow();
  if (!row) return;
  if (row.refreshTokenSealed) {
    try {
      const token = await accessToken();
      for (const t of tenantsOf(row)) {
        await fetch(`${apiBase()}/connections/${encodeURIComponent(t.connectionId)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
      }
    } catch {
      /* already gone at Xero's end, still clear ours */
    }
    try {
      await revoke(unseal((await xeroRow())?.refreshTokenSealed ?? row.refreshTokenSealed));
    } catch {
      /* same */
    }
  }
  cache = null;
  await saveRow({ refreshTokenSealed: null, scopes: "", tenantsJson: "[]", tenantId: null, tenantName: "", tenantType: "", xeroConnectionId: null, lastError: null });
  await logXero("disconnect", true, `Disconnected from ${row.tenantName || "Xero"}. Invoices already in Xero stay there.`, { byName });
}

/* ------------------------------ access tokens ----------------------------- */

let cache: { token: string; exp: number } | null = null;
let refreshing: Promise<string> | null = null;

/** For tests: forget the cached access token. */
export function forgetXeroToken() {
  cache = null;
}

async function accessToken(): Promise<string> {
  if (inDemo()) throw new XeroNotConnected("Xero is not connected in the demo");
  if (cache && cache.exp > Date.now()) return cache.token;
  // One refresh at a time: Xero swaps the refresh token each time and the old one stops working.
  refreshing ??= (async () => {
    try {
      const row = await xeroRow();
      if (!row?.refreshTokenSealed) throw new XeroNotConnected("Xero is not connected");
      try {
        const tok = await tokenCall({ grant_type: "refresh_token", refresh_token: unseal(row.refreshTokenSealed) });
        if (tok.refresh_token) {
          await db
            .update(schema.xeroConnection)
            .set({ refreshTokenSealed: seal(tok.refresh_token), updatedAt: new Date() })
            .where(eq(schema.xeroConnection.id, row.id));
        }
        cache = { token: tok.access_token, exp: Date.now() + ((tok.expires_in ?? 1800) - 120) * 1000 };
        return tok.access_token;
      } catch (e) {
        if ((e as { code?: string }).code === "invalid_grant") {
          await db
            .update(schema.xeroConnection)
            .set({ refreshTokenSealed: null, lastError: "Xero access was removed or has expired. Connect to Xero again.", updatedAt: new Date() })
            .where(eq(schema.xeroConnection.id, row.id));
          await logXero("error", false, "Xero refused the saved sign-in. It needs connecting again.");
          throw new XeroNotConnected("Xero needs connecting again");
        }
        throw e;
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Is Ops connected with an organisation picked? */
export async function xeroReady() {
  if (inDemo() || !xeroConfigured()) return null;
  const row = await xeroRow();
  if (!row?.refreshTokenSealed || !row.tenantId) return null;
  return row;
}

/* ---------------------------------- calls --------------------------------- */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Xero's validation messages, however deep it put them. */
function xeroMessages(json: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.ValidationErrors)) for (const e of o.ValidationErrors) if (e && typeof (e as { Message?: string }).Message === "string") out.push((e as { Message: string }).Message);
    for (const k of ["Elements", "Invoices", "Contacts"]) if (o[k]) walk(o[k]);
  };
  walk(json);
  return [...new Set(out)];
}

/**
 * One Accounting API call for the picked organisation. 401 refreshes once.
 * 429 waits as long as Xero asks, up to 30 seconds, twice. Writes carry an
 * Idempotency-Key so a retry never makes a second invoice.
 */
export async function xeroApi<T = Record<string, unknown>>(
  path: string,
  init: {
    method?: "GET" | "PUT" | "POST";
    body?: unknown;
    idempotencyKey?: string;
    query?: Record<string, string>;
    /**
     * A 403 here means this one read is not allowed (for example a missing
     * scope), not that the organisation was disconnected. The connection is
     * left alone and only this call fails.
     */
    narrow403?: boolean;
  } = {},
): Promise<T> {
  const row = await xeroReady();
  if (!row?.tenantId) throw new XeroNotConnected("Xero is not connected, or no organisation is picked.");
  const method = init.method ?? "GET";
  if (method !== "GET" && !/^(Invoices|Contacts)$/.test(path)) throw new Error(`Ops does not write ${path} to Xero.`);
  const q = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const url = `${apiBase()}/api.xro/2.0/${path}${q}`;
  let tries = 0;
  let refreshed = false;
  for (;;) {
    tries++;
    const token = await accessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "xero-tenant-id": row.tenantId,
      accept: "application/json",
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey.slice(0, 128);
    const res = await fetch(url, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      cache = null;
      continue;
    }
    if (res.status === 429 && tries <= 2) {
      const after = Number(res.headers.get("retry-after") ?? "5");
      if (Number.isFinite(after) && after <= 30) {
        await wait(Math.max(1, after) * 1000);
        continue;
      }
      throw new XeroError(`Xero is limiting calls just now (${res.headers.get("x-rate-limit-problem") ?? "rate limit"}). Try again later.`, 429);
    }
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (res.status === 403 && init.narrow403) {
      throw new XeroError(`Xero did not allow Ops to read ${path.split("/")[0]}. Check the Xero connection scopes.`, 403);
    }
    if (res.status === 403) {
      await saveRow({ lastError: "Xero refused access to the organisation. It may have been disconnected in Xero. Connect again." });
      throw new XeroError("Xero refused access to the organisation. Connect to Xero again.", 403);
    }
    if (!res.ok) {
      const msgs = xeroMessages(json);
      const top = (json as { Message?: string; Detail?: string }).Message ?? (json as { Detail?: string }).Detail;
      throw new XeroError(msgs[0] ?? top ?? `Xero said ${res.status}`, res.status, msgs);
    }
    return json as T;
  }
}

/** Xero's dates come as "/Date(1730073600000+0000)/" or ISO. */
export function xeroDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(v);
  if (m) return new Date(Number(m[1]));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
