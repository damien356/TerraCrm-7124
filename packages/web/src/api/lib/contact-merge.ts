import { eq, sql } from "drizzle-orm";
import type { Client, InStatement } from "@libsql/client";
import { db } from "../database";
import * as schema from "../database/schema";
import { mergePerson } from "./job-people";
import { parseTags, tagsJson } from "./person-tags";

/**
 * DUPLICATE PEOPLE.
 *
 * ServiceM8 left the same person on several cards (Marcos was one). The review
 * list groups cards that share a mobile, an email or a full name, and Damien
 * merges one pair at a time: every job, quote, site, message and company link
 * moves onto the card he keeps, blank details are filled from the other card,
 * and the other card is archived (active off), never deleted.
 */

export const phoneKey = (raw: string | null | undefined) => {
  const d = (raw ?? "").replace(/\D/g, "");
  const core = d.startsWith("61") ? d.slice(2) : d.startsWith("0") ? d.slice(1) : d;
  return core.length >= 8 ? core : null;
};
export const emailKey = (raw: string | null | undefined) => {
  const e = (raw ?? "").trim().toLowerCase();
  return e.includes("@") ? e : null;
};
export const nameKey = (first: string | null | undefined, last: string | null | undefined) => {
  const f = (first ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const l = (last ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return f && l ? `${f} ${l}` : null;
};

type Card = typeof schema.contacts.$inferSelect;

/** Active cards that share a mobile, email or name with the details given. */
export async function findMatches(args: {
  mobile?: string | null;
  phone?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  excludeId?: number | null;
}) {
  const pk = [phoneKey(args.mobile), phoneKey(args.phone)].filter((k): k is string => !!k);
  const ek = emailKey(args.email);
  const nk = nameKey(args.firstName, args.lastName);
  if (pk.length === 0 && !ek && !nk) return [];
  const all = await db.select().from(schema.contacts).where(eq(schema.contacts.active, true));
  const out: Array<{ contact: Card; reasons: string[] }> = [];
  for (const c of all) {
    if (args.excludeId && c.id === args.excludeId) continue;
    const reasons: string[] = [];
    const theirs = [phoneKey(c.mobile), phoneKey(c.phone)].filter(Boolean);
    if (pk.some((k) => theirs.includes(k))) reasons.push("mobile");
    if (ek && emailKey(c.email) === ek) reasons.push("email");
    if (nk && nameKey(c.firstName, c.lastName) === nk) reasons.push("name");
    if (reasons.length) out.push({ contact: c, reasons });
  }
  // A shared mobile or email is a much stronger sign than a shared name.
  const score = (r: string[]) => (r.includes("mobile") ? 4 : 0) + (r.includes("email") ? 2 : 0) + (r.includes("name") ? 1 : 0);
  return out.sort((a, b) => score(b.reasons) - score(a.reasons)).slice(0, 5);
}

/** Groups of active cards that look like the same person. */
export async function duplicateGroups() {
  const all = await db.select().from(schema.contacts).where(eq(schema.contacts.active, true));
  const counts = await db.all<{ id: number; jobs: number; quotes: number; sites: number }>(sql`
    select c.id,
      (select count(*) from jobs j where j.contact_id = c.id or j.bill_to_contact_id = c.id) +
      (select count(*) from job_contacts jc where jc.contact_id = c.id) as jobs,
      (select count(*) from quotes q where q.contact_id = c.id or q.supervisor_contact_id = c.id) as quotes,
      (select count(*) from sites s where s.contact_id = c.id) as sites
    from contacts c where c.active = 1`);
  const usage = new Map(counts.map((r) => [r.id, r]));
  const companies = await db.all<{ contact_id: number; name: string }>(sql`
    select cc.contact_id, co.name from company_contacts cc join companies co on co.id = cc.company_id`);
  const coBy = new Map<number, string[]>();
  for (const r of companies) coBy.set(r.contact_id, [...(coBy.get(r.contact_id) ?? []), r.name]);

  // Union-find over shared keys so one person on three cards is one group.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const join = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const reasons = new Map<number, Set<string>>();
  const byKey = new Map<string, number[]>();
  for (const c of all) {
    const keys = [
      ...[phoneKey(c.mobile), phoneKey(c.phone)].filter(Boolean).map((k) => `mobile:${k}`),
      emailKey(c.email) ? `email:${emailKey(c.email)}` : null,
      nameKey(c.firstName, c.lastName) ? `name:${nameKey(c.firstName, c.lastName)}` : null,
    ].filter((k): k is string => !!k);
    for (const k of new Set(keys)) byKey.set(k, [...(byKey.get(k) ?? []), c.id]);
  }
  for (const [k, ids] of byKey) {
    if (ids.length < 2) continue;
    for (const id of ids.slice(1)) join(ids[0]!, id);
    for (const id of ids) {
      const s = reasons.get(id) ?? new Set<string>();
      s.add(k.split(":")[0]!);
      reasons.set(id, s);
    }
  }
  const groups = new Map<number, Card[]>();
  for (const c of all) {
    if (!reasons.has(c.id)) continue;
    const r = find(c.id);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const why = new Set<string>();
      for (const c of g) for (const r of reasons.get(c.id) ?? []) why.add(r);
      return {
        key: g.map((c) => c.id).sort((a, b) => a - b).join("-"),
        reasons: [...why].sort(),
        people: g
          .map((c) => ({
            id: c.id,
            firstName: c.firstName,
            lastName: c.lastName,
            mobile: c.mobile,
            phone: c.phone,
            email: c.email,
            createdAt: c.createdAt,
            externalRef: c.externalRef,
            companies: coBy.get(c.id) ?? [],
            jobs: Number(usage.get(c.id)?.jobs ?? 0),
            quotes: Number(usage.get(c.id)?.quotes ?? 0),
            sites: Number(usage.get(c.id)?.sites ?? 0),
          }))
          // The busiest card first: it is usually the one to keep.
          .sort((a, b) => b.jobs + b.quotes + b.sites - (a.jobs + a.quotes + a.sites) || a.id - b.id),
      };
    })
    .sort((a, b) => (b.reasons.includes("mobile") ? 1 : 0) - (a.reasons.includes("mobile") ? 1 : 0) || b.people.length - a.people.length);
}

/** Every column in the database that points at contacts(id), read from the live table layout. */
async function contactColumns(client: Client) {
  const tables = await client.execute("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_litestream%'");
  const out: Array<{ table: string; column: string }> = [];
  for (const t of tables.rows) {
    const name = String(t.name);
    const fks = await client.execute(`pragma foreign_key_list("${name.replace(/"/g, "")}")`);
    for (const fk of fks.rows) if (String(fk.table) === "contacts") out.push({ table: name, column: String(fk.from) });
  }
  return out;
}

/** Merges `dropId` into `keepId`. All statements run as one batch: all of it lands or none of it. */
export async function mergeContacts(keepId: number, dropId: number, actor: { name: string; role: string }) {
  if (keepId === dropId) throw new Error("Pick two different cards");
  const [keep] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, keepId));
  const [drop] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, dropId));
  if (!keep || !drop) throw new Error("Card not found");
  if (!drop.active) throw new Error("That card is already archived");

  const client = db.$client as Client;
  const stmts: InStatement[] = [];
  const moved: Record<string, number> = {};
  const now = Math.floor(Date.now() / 1000);

  // job_contacts and quote_contacts: one row per person, so a clash merges tags and ticks.
  for (const { table, parent } of [
    { table: "job_contacts", parent: "job_id" },
    { table: "quote_contacts", parent: "quote_id" },
  ]) {
    const rows = (await client.execute({ sql: `select * from ${table} where contact_id in (?, ?)`, args: [keepId, dropId] })).rows as any[];
    const keepBy = new Map(rows.filter((r) => Number(r.contact_id) === keepId).map((r) => [Number(r[parent]), r]));
    for (const r of rows.filter((x) => Number(x.contact_id) === dropId)) {
      const k = keepBy.get(Number(r[parent]));
      if (!k) {
        stmts.push({ sql: `update ${table} set contact_id = ?, updated_at = ? where id = ?`, args: [keepId, now, r.id] });
      } else {
        const m = mergePerson(
          {
            tags: k.tags,
            isPrimary: !!k.is_primary,
            onSiteContact: !!k.on_site_contact,
            canApproveQuote: !!k.can_approve_quote,
            receivesSms: !!k.receives_sms,
            receivesEmail: !!k.receives_email,
            showToCrew: !!k.show_to_crew,
            whenToContact: k.when_to_contact ?? null,
            actedForCompanyId: k.acted_for_company_id ?? null,
          },
          {
            tags: parseTags(r.tags),
            isPrimary: !!r.is_primary,
            onSiteContact: !!r.on_site_contact,
            canApproveQuote: !!r.can_approve_quote,
            receivesSms: !!r.receives_sms,
            receivesEmail: !!r.receives_email,
            showToCrew: !!r.show_to_crew,
            whenToContact: r.when_to_contact ?? null,
            actedForCompanyId: r.acted_for_company_id ?? null,
          },
        );
        const common = [tagsJson(m.tags), m.onSiteContact ? 1 : 0, m.canApproveQuote ? 1 : 0, m.receivesSms ? 1 : 0, m.receivesEmail ? 1 : 0, m.showToCrew ? 1 : 0, m.whenToContact, m.actedForCompanyId, now];
        if (table === "job_contacts") {
          stmts.push({
            sql: `update job_contacts set tags = ?, on_site_contact = ?, can_approve_quote = ?, receives_sms = ?, receives_email = ?, show_to_crew = ?, when_to_contact = ?, acted_for_company_id = ?, updated_at = ?, is_primary = ?, role = ? where id = ?`,
            args: [...common, m.isPrimary ? 1 : 0, m.tags[0] ?? "other", k.id],
          });
        } else {
          stmts.push({
            sql: `update quote_contacts set tags = ?, on_site_contact = ?, can_approve_quote = ?, receives_sms = ?, receives_email = ?, show_to_crew = ?, when_to_contact = ?, acted_for_company_id = ?, updated_at = ? where id = ?`,
            args: [...common, k.id],
          });
        }
        stmts.push({ sql: `delete from ${table} where id = ?`, args: [r.id] });
      }
      moved[table] = (moved[table] ?? 0) + 1;
    }
  }

  // company_contacts is unique on (company, contact, role): a clash keeps the existing link.
  const links = (await client.execute({ sql: "select * from company_contacts where contact_id in (?, ?)", args: [keepId, dropId] })).rows as any[];
  const keepLinks = new Set(links.filter((l) => Number(l.contact_id) === keepId).map((l) => `${l.company_id}:${l.role}`));
  for (const l of links.filter((x) => Number(x.contact_id) === dropId)) {
    if (keepLinks.has(`${l.company_id}:${l.role}`)) stmts.push({ sql: "delete from company_contacts where id = ?", args: [l.id] });
    else stmts.push({ sql: "update company_contacts set contact_id = ? where id = ?", args: [keepId, l.id] });
    moved.company_contacts = (moved.company_contacts ?? 0) + 1;
  }

  // Every other column pointing at contacts simply moves across.
  const special = new Set(["job_contacts", "quote_contacts", "company_contacts"]);
  for (const { table, column } of await contactColumns(client)) {
    if (special.has(table)) continue;
    const [n] = (await client.execute({ sql: `select count(*) as n from "${table}" where "${column}" = ?`, args: [dropId] })).rows as any[];
    if (!Number(n?.n)) continue;
    stmts.push({ sql: `update "${table}" set "${column}" = ? where "${column}" = ?`, args: [keepId, dropId] });
    moved[`${table}.${column}`] = Number(n.n);
  }

  // Blank details on the kept card are filled from the other one.
  const fill: Record<string, unknown> = {};
  for (const [col, key] of [
    ["mobile", "mobile"],
    ["phone", "phone"],
    ["email", "email"],
  ] as const) {
    if (!String(keep[key] ?? "").trim() && String(drop[key] ?? "").trim()) fill[col] = drop[key];
  }
  // A do-not-market block outranks everything, so it survives the merge.
  if (drop.doNotMarket && !keep.doNotMarket) {
    fill.do_not_market = 1;
    fill.do_not_market_reason = drop.doNotMarketReason || `Carried from merged card #${drop.id}`;
  }
  const notes = [keep.notes?.trim(), drop.notes?.trim() ? `From merged card #${drop.id}: ${drop.notes.trim()}` : null].filter(Boolean).join("\n\n");
  if (notes !== (keep.notes ?? "")) fill.notes = notes || null;
  const fillCols = Object.keys(fill);
  if (fillCols.length) {
    stmts.push({
      sql: `update contacts set ${fillCols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? where id = ?`,
      args: [...fillCols.map((c) => fill[c] as any), now, keepId],
    });
  }
  const dropName = `${drop.firstName} ${drop.lastName}`.trim();
  const keepName = `${keep.firstName} ${keep.lastName}`.trim();
  stmts.push({
    sql: "update contacts set active = 0, notes = ?, updated_at = ? where id = ?",
    args: [[`Merged into #${keep.id} ${keepName}.`, drop.notes?.trim()].filter(Boolean).join("\n\n"), now, dropId],
  });
  stmts.push({
    sql: "insert into activity_log (contact_id, entity_type, entity_id, action, detail, actor_name, actor_role, created_at) values (?, 'contact', ?, 'merged', ?, ?, ?, ?)",
    args: [keepId, keepId, `Card #${drop.id} ${dropName} merged into this card (${drop.mobile || drop.email || "no mobile or email"})`, actor.name, actor.role, now],
  });

  await client.batch(stmts, "write");
  return { ok: true, keepId, dropId, moved, filled: fillCols };
}
