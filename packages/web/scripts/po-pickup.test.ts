/**
 * PO pick up from supplier and saved supplier depots (Damien's brief, 9 Nov 2026).
 *
 *   bun test scripts/po-pickup.test.ts      (from packages/web)
 *
 * Runs the real purchasing procedures, pricing, PDF, email text and crew
 * materials on a throwaway SQLite file built from the schema. Sign in is
 * faked as an Admin, the email sender and storage are stubs, and every
 * network call is blocked. No PO, email or installer message leaves the
 * machine.
 *
 * Brief section 5, one describe block per row:
 *   1  Pickup with no address (location to be confirmed)
 *   2  One-off address, for this PO only
 *   3  Saved depot reused on a later PO
 *   4  More than one depot per supplier
 *   5  Switching suppliers
 *   6  Duplicate depot prevention
 *   7  Editing a saved depot: this PO only, or also the saved one
 *   8  Delivery to pickup charge review
 *   9  Save and reopen
 *   10 PDF and email wording
 *   11 Existing Warehouse and Site behaviour
 *   12 Installer collection details, no prices
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "po-pickup-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.RESEND_API_KEY ??= "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";

const realFetch = globalThis.fetch;
const blocked: string[] = [];
const mails: { to: string; subject: string; text: string; pdf: Buffer }[] = [];
const ADMIN = { id: "t-admin", name: "Test Admin", email: "admin@example.invalid" };

const JOB = 4400;
const SUP = 50; // Pickup Supplies, with depots
const SUP_B = 51; // Other Supplies
const SITE = "14 Smith St, Paddington QLD 4064";
const WAREHOUSE = "2/22 Lawrence Dr, Nerang QLD 4211";
const NERANG = "8 Hilldon Ct, Nerang QLD 4211";
const YATALA = "45 Business St, Yatala QLD 4207";
const FEE = { delivery: 1, handling: 2, baling: 3, fuel: 4, deliveryB: 5 };
const MAT = { carpet: 1, glue: 2, other: 3, trims: 4 };

let m: {
  db: typeof import("../src/api/database").db;
  call: typeof import("@orpc/server").call;
  purchasing: typeof import("../src/api/routes/purchasing").purchasing;
  poEmailText: typeof import("../src/api/routes/purchasing").poEmailText;
  pickup: typeof import("../src/api/lib/pickup");
  crew: typeof import("../src/api/lib/crew-materials");
};
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in po-pickup tests: ${String(input)}`);
  }) as unknown as typeof fetch;
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);

  const realS3 = await import("../src/api/lib/s3");
  mock.module("../src/api/lib/s3", () => ({
    ...realS3,
    putObject: async () => {},
    signGet: async (key: string) => `https://store.invalid/${encodeURIComponent(key)}?sig=1`,
  }));
  const realMail = await import("../src/api/lib/agent-mail");
  mock.module("../src/api/lib/agent-mail", () => ({
    ...realMail,
    sendAsTeam: async (mail: { to: string; subject: string; text: string; attachments: { content: Buffer }[] }) => {
      mails.push({ to: mail.to, subject: mail.subject, text: mail.text, pdf: mail.attachments[0]!.content });
      return { ok: true, id: `stub-${mails.length}` };
    },
  }));
  const realNotify = await import("../src/api/lib/notify");
  mock.module("../src/api/lib/notify", () => ({ ...realNotify, notifyOffice: async () => {} }));
  const realPush = await import("../src/api/lib/push");
  mock.module("../src/api/lib/push", () => ({ ...realPush, sendPush: async () => 0, pushToInstaller: async () => 0, pushToOffice: async () => 0 }));
  mock.module("../src/api/auth", () => ({
    NO_LOGIN: "no login",
    auth: { api: { getSession: async () => ({ user: ADMIN, session: {} }) } },
  }));

  const routes = await import("../src/api/routes/purchasing");
  m = {
    db: (await import("../src/api/database")).db,
    call: (await import("@orpc/server")).call,
    purchasing: routes.purchasing,
    poEmailText: routes.poEmailText,
    pickup: await import("../src/api/lib/pickup"),
    crew: await import("../src/api/lib/crew-materials"),
  };
  await seed();
}, 60_000);

afterAll(() => {
  client?.close();
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const q = async (sql: string, args: (string | number | null)[] = []) => (await client.execute({ sql, args })).rows as any[];
const run = <O = any>(proc: any, input: unknown) => m.call(proc, input, { context: { headers: new Headers() } }) as Promise<O>;
async function failure(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected it to be refused");
}

async function seed() {
  const { db } = m;
  await db.insert(schema.profiles).values({ userId: ADMIN.id, name: "Test Admin", email: ADMIN.email, role: "admin", isMainAdmin: true } as any);
  await db.insert(schema.suppliers).values({ id: SUP, name: "Pickup Supplies", code: "pickup", email: "orders@pickup.invalid", deliversTo: "both", deliversDirect: true } as any);
  await db.insert(schema.suppliers).values({ id: SUP_B, name: "Other Supplies", code: "other", email: "orders@other.invalid", deliversTo: "both", deliversDirect: true } as any);
  const rule = (id: number, supplierId: number, name: string, kind: string, basis: string, amount: number | null, percent: number | null, appliesTo: string) =>
    db.insert(schema.supplierFeeRules).values({ id, supplierId, name, kind, basis, amount, percent, appliesTo, autoApply: true, active: true } as any);
  await rule(FEE.delivery, SUP, "Delivery charge", "delivery", "order", 50, null, "both");
  await rule(FEE.handling, SUP, "Handling", "handling", "order", 15, null, "both");
  await rule(FEE.baling, SUP, "Baling (warehouse orders)", "baling", "order", 10, null, "warehouse");
  await rule(FEE.fuel, SUP, "Fuel surcharge", "fuel", "percent_of_order", null, 2, "both");
  await rule(FEE.deliveryB, SUP_B, "Delivery", "delivery", "order", 40, null, "both");
  const [site] = await db.insert(schema.sites).values({ address: "14 Smith St", suburb: "Paddington", state: "QLD", postcode: "4064" } as any).returning();
  await db.insert(schema.jobs).values({ id: JOB, number: 188500, title: "Pickup test job", siteId: site!.id } as any);
  await db.insert(schema.installers).values({ id: 31, name: "Test Installer", active: true } as any);
  await db.insert(schema.jobTasks).values({ id: 91, jobId: JOB, title: "Carpet", status: "assigned", assignedInstallerId: 31, scheduledDate: "2026-11-20", labourCost: 500 } as any);
  for (const [id, description, qty, unit] of [
    [MAT.carpet, "Test carpet, Grey", 40, "m2"],
    [MAT.glue, "Test adhesive 15L", 2, "each"],
    [MAT.other, "Test underlay", 40, "m2"],
    [MAT.trims, "Test trims", 6, "each"],
  ] as const) {
    await db.insert(schema.jobMaterials).values({ id, jobId: JOB, description, qty, unit, status: "to_order" } as any);
  }
}

type Choice = { mode: "depot" | "new" | "tbc"; depotId?: number | null; name?: string; address?: string; save?: boolean; updateSaved?: boolean } | null;
const goods = (mat = MAT.carpet, qty = 40, cost = 30) => ({ kind: "goods" as const, jobMaterialId: mat, productId: null, description: null, qty, unit: "m2", unitCostExGst: cost });
const poIn = (o: { supplierId?: number; deliverTo?: "warehouse" | "site" | "pickup"; pickup?: Choice; lines?: any[]; notes?: string; chargesConfirmed?: boolean; feeIds?: number[] } = {}) => ({
  jobId: JOB,
  supplierId: o.supplierId ?? SUP,
  deliverTo: o.deliverTo ?? "pickup",
  deliveryAddress: "",
  pickup: o.pickup === undefined ? null : o.pickup,
  chargesConfirmed: o.chargesConfirmed ?? false,
  notes: o.notes ?? "",
  lines: o.lines ?? [goods()],
  feeIds: o.feeIds ?? [],
});
const create = (o: Parameters<typeof poIn>[0] = {}) => run<any>(m.purchasing.create, poIn(o));
const update = (id: number, o: Parameters<typeof poIn>[0] = {}) => run<any>(m.purchasing.update, { ...poIn(o), id });
const remove = (id: number) => run(m.purchasing.removeDraft, { id });
const depots = (supplierId = SUP) => run<{ id: number; name: string; address: string }[]>(m.purchasing.depots, { supplierId });
const depotRows = () => q("select * from supplier_depots order by id");
const poRow = async (id: number) => (await q("select * from purchase_orders where id = ?", [id]))[0];
const lineNames = async (id: number) => (await q("select description, kind, total_ex_gst from purchase_order_lines where po_id = ? and kind != 'goods' order by sort_order", [id])).map((r) => r.description as string);

async function pdfText(id: number) {
  const { base64 } = await run<{ base64: string }>(m.purchasing.pdf, { id });
  const f = join(dir, `po-${id}.pdf`);
  writeFileSync(f, Buffer.from(base64, "base64"));
  const p = Bun.spawnSync(["pdftotext", "-layout", f, "-"]);
  return p.stdout.toString();
}
/** The Supplier / Collection block of the PDF, under the letterhead. */
const block = (pdf: string) => pdf.slice(pdf.indexOf("Supplier "), pdf.indexOf("Description"));
async function sendText(id: number) {
  await run(m.purchasing.send, { id, saveEmail: false });
  return mails[mails.length - 1]!;
}

/* ================================== 1 ================================== */

describe("1. Pickup with no address", () => {
  let id = 0;
  test("saved as pickup with the location to be confirmed, nothing guessed and no depot saved", async () => {
    const po = await create({ lines: [goods(MAT.trims, 6, 12)], pickup: { mode: "tbc" } });
    id = po.id;
    const row = await poRow(id);
    expect(row.deliver_to).toBe("pickup");
    expect(row.delivery_address).toBe("");
    expect(row.pickup_name).toBe("");
    expect(row.pickup_address).toBe("");
    expect(row.pickup_depot_id).toBeNull();
    expect(await depotRows()).toHaveLength(0);
  });

  test("no choice sent at all is still to be confirmed, never the site", async () => {
    const po = await create({ pickup: null });
    const row = await poRow(po.id);
    expect(row.pickup_address).toBe("");
    expect(row.delivery_address).toBe("");
    await remove(po.id);
  });

  test("a new place with nothing typed is refused with a plain message; saving an empty place for next time too", async () => {
    const e1 = await failure(create({ pickup: { mode: "new", name: "", address: "" } }));
    expect(e1.message).toContain("Type the pickup address, or choose Pickup - location to be confirmed");
    const e2 = await failure(create({ pickup: { mode: "new", name: "Nerang", address: "", save: true } }));
    expect(e2.message).toContain("before saving it for next time");
    expect(await depotRows()).toHaveLength(0);
  });

  test("the PDF and the email say DEPOT/ADDRESS TO BE CONFIRMED, and nothing about delivery, the site or the warehouse", async () => {
    const pdf = await pdfText(id);
    // Two lines in the PDF's address column: "PICKUP FROM SUPPLIER -" then "DEPOT/ADDRESS TO BE CONFIRMED".
    expect(pdf).toMatch(/PICKUP FROM SUPPLIER -\n\s+DEPOT\/ADDRESS TO BE CONFIRMED/);
    expect(pdf).toContain("Collection");
    expect(pdf).not.toContain("Deliver to");
    expect(pdf).not.toContain("Freight to");
    expect(pdf).not.toContain("Smith St");
    // Terra's letterhead carries its own address. The collection block never does.
    expect(block(pdf)).not.toContain("Lawrence");
    const mail = await sendText(id);
    expect(mail.text).toContain("PICKUP FROM SUPPLIER - DEPOT/ADDRESS TO BE CONFIRMED");
    expect(mail.text).not.toContain("Deliver to");
    expect(mail.text).not.toContain("Smith St");
    expect(mail.text).not.toContain("Lawrence");
    expect((await poRow(id)).status).toBe("sent");
  });
});

/* ================================== 2 ================================== */

describe("2. One-off address", () => {
  test("Use for this PO only: on the PO, never saved", async () => {
    const po = await create({ lines: [goods(MAT.glue, 2, 80)], pickup: { mode: "new", name: "Brendale branch", address: "9 Kremzow Rd, Brendale QLD 4500", save: false } });
    const row = await poRow(po.id);
    expect(row.pickup_name).toBe("Brendale branch");
    expect(row.pickup_address).toBe("9 Kremzow Rd, Brendale QLD 4500");
    expect(row.pickup_depot_id).toBeNull();
    expect(po.depotSaved).toBeNull();
    expect(await depotRows()).toHaveLength(0);
    await remove(po.id);
  });

  test("a branch name with no address yet stays on the PO only, printed with the address to be confirmed", async () => {
    const po = await create({ lines: [goods(MAT.glue, 2, 80)], pickup: { mode: "new", name: "Brendale branch", address: "" } });
    expect(await depotRows()).toHaveLength(0);
    const pdf = await pdfText(po.id);
    expect(pdf).toContain("PICKUP FROM SUPPLIER");
    expect(pdf).toContain("Brendale branch");
    expect(pdf).toContain("Address to be confirmed");
    await remove(po.id);
  });
});

/* ================================== 3 ================================== */

let nerangId = 0;
let firstNerangPo = 0;
describe("3. Saved depot reused on a later PO", () => {
  test("Save for next time keeps it for this supplier, and says so in the supplier's history", async () => {
    const po = await create({ lines: [goods(MAT.glue, 2, 80)], pickup: { mode: "new", name: "Nerang depot", address: NERANG, save: true } });
    firstNerangPo = po.id;
    expect(po.depotSaved).toBe("created");
    const rows = await depotRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].supplier_id).toBe(SUP);
    expect(rows[0].name).toBe("Nerang depot");
    expect(rows[0].address).toBe(NERANG);
    nerangId = rows[0].id;
    expect((await poRow(po.id)).pickup_depot_id).toBe(nerangId);
    const log = await q("select * from activity_log where action = 'depot_saved'");
    expect(log).toHaveLength(1);
    expect(log[0].entity_type).toBe("supplier");
    expect(log[0].entity_id).toBe(SUP);
  });

  test("the next PO offers it and uses it without typing the address again", async () => {
    const list = await depots();
    expect(list.map((d) => d.name)).toEqual(["Nerang depot"]);
    const po = await create({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "depot", depotId: nerangId } });
    const row = await poRow(po.id);
    expect(row.pickup_depot_id).toBe(nerangId);
    expect(row.pickup_name).toBe("Nerang depot");
    expect(row.pickup_address).toBe(NERANG);
    expect(await depotRows()).toHaveLength(1);
    await remove(po.id);
  });
});

/* ================================== 4 ================================== */

let yatalaId = 0;
describe("4. More than one depot per supplier", () => {
  test("a second depot is saved next to the first; the other supplier has none", async () => {
    const po = await create({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "new", name: "Yatala DC", address: YATALA, save: true } });
    expect(po.depotSaved).toBe("created");
    const list = await depots();
    expect(list.map((d) => d.name).sort()).toEqual(["Nerang depot", "Yatala DC"]);
    yatalaId = list.find((d) => d.name === "Yatala DC")!.id;
    expect(await depots(SUP_B)).toHaveLength(0);
    await remove(po.id);
  });
});

/* ================================== 5 ================================== */

describe("5. Switching suppliers", () => {
  test("another supplier's depot is refused, and nothing is saved or changed", async () => {
    const e = await failure(create({ supplierId: SUP_B, pickup: { mode: "depot", depotId: nerangId } }));
    expect(e.message).toContain("belongs to another supplier");
    expect(await depotRows()).toHaveLength(2);
  });

  test("a draft moved to another supplier with a fresh choice drops the old depot", async () => {
    const po = await create({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "depot", depotId: yatalaId } });
    const moved = await update(po.id, { supplierId: SUP_B, lines: [goods(MAT.other, 40, 6)], pickup: { mode: "tbc" } });
    const row = await poRow(moved.id);
    expect(row.supplier_id).toBe(SUP_B);
    expect(row.pickup_depot_id).toBeNull();
    expect(row.pickup_address).toBe("");
    await remove(po.id);
  });
});

/* ================================== 6 ================================== */

describe("6. Duplicate depot prevention", () => {
  test("the same address typed another way is matched", async () => {
    expect(m.pickup.addressKey("8 Hilldon Court, NERANG Queensland 4211")).toBe(m.pickup.addressKey(NERANG));
    expect(m.pickup.addressKey("2 / 22 Lawrence Drive Nerang 4211")).toBe(m.pickup.addressKey(WAREHOUSE));
    expect(m.pickup.addressKey("10 Hilldon Ct, Nerang QLD 4211")).not.toBe(m.pickup.addressKey(NERANG));
    const match = await run<any>(m.purchasing.depotMatch, { supplierId: SUP, address: "8 Hilldon Court, Nerang Qld 4211" });
    expect(match?.id).toBe(nerangId);
    expect(await run(m.purchasing.depotMatch, { supplierId: SUP_B, address: NERANG })).toBeNull();
  });

  test("Save for next time on a saved address reuses the saved depot, no second copy", async () => {
    const po = await create({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "new", name: "Nerang", address: "8 Hilldon Court, Nerang Qld 4211", save: true } });
    expect(po.depotSaved).toBe("reused");
    expect((await poRow(po.id)).pickup_depot_id).toBe(nerangId);
    expect(await depotRows()).toHaveLength(2);
    expect(await q("select * from activity_log where action = 'depot_saved'")).toHaveLength(2);
    await remove(po.id);
  });

  test("the same address for another supplier is its own depot", async () => {
    const po = await create({ supplierId: SUP_B, lines: [goods(MAT.other, 40, 6)], pickup: { mode: "new", name: "Shared yard", address: NERANG, save: true } });
    expect(po.depotSaved).toBe("created");
    expect(await depots(SUP_B)).toHaveLength(1);
    await remove(po.id);
  });

  test("changing a saved depot onto another saved depot's address is refused", async () => {
    const e = await failure(create({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "depot", depotId: yatalaId, name: "Yatala DC", address: NERANG, updateSaved: true } }));
    expect(e.message).toContain("already saved");
    expect((await depotRows()).find((d) => d.id === yatalaId).address).toBe(YATALA);
  });
});

/* ================================== 7 ================================== */

describe("7. Editing a saved depot", () => {
  test("This PO only: the PO gets the new address, the saved depot does not change", async () => {
    const po = await create({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "depot", depotId: yatalaId, name: "Yatala DC", address: "47 Business St, Yatala QLD 4207" } });
    expect((await poRow(po.id)).pickup_address).toBe("47 Business St, Yatala QLD 4207");
    expect((await depotRows()).find((d) => d.id === yatalaId).address).toBe(YATALA);
    expect(po.depotSaved).toBeNull();
    await remove(po.id);
  });

  test("Also update the saved location: the depot changes, a PO already sent keeps its own copy", async () => {
    const sent = await create({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "depot", depotId: nerangId } });
    await sendText(sent.id);
    const po = await create({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "depot", depotId: nerangId, name: "Nerang depot", address: "10 Hilldon Ct, Nerang QLD 4211", updateSaved: true } });
    expect(po.depotSaved).toBe("updated");
    expect((await depotRows()).find((d) => d.id === nerangId).address).toBe("10 Hilldon Ct, Nerang QLD 4211");
    expect((await poRow(sent.id)).pickup_address).toBe(NERANG);
    expect((await poRow(firstNerangPo)).pickup_address).toBe(NERANG);
    expect(await q("select * from activity_log where action = 'depot_updated'")).toHaveLength(1);
    // The sent PO's PDF still prints the address it went with.
    expect(await pdfText(sent.id)).toContain("8 Hilldon Ct");
    await remove(po.id);
  });

  test("a PO already sent cannot be edited at all", async () => {
    const [sent] = await q("select id from purchase_orders where status = 'sent' and pickup_depot_id = ?", [nerangId]);
    const e = await failure(update(sent.id, { lines: [goods(MAT.other, 40, 6)], pickup: { mode: "tbc" } }));
    expect(e.message).toContain("has gone to the supplier");
  });
});

/* ================================== 8 ================================== */

describe("8. Delivery to pickup charge review", () => {
  let id = 0;
  test("a warehouse draft has delivery, handling, warehouse baling and fuel", async () => {
    const po = await create({ deliverTo: "warehouse", lines: [goods(MAT.other, 40, 6)] });
    id = po.id;
    expect((await lineNames(id)).sort()).toEqual(["Baling (warehouse orders)", "Delivery charge", "Fuel surcharge", "Handling"]);
    expect((await poRow(id)).freight_ex_gst).toBe(50);
  });

  test("the pickup price drops the delivery charge only, keeps handling, and flags what is unclear", async () => {
    const pv = await run<any>(m.purchasing.preview, poIn({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "tbc" } }));
    const names = pv.lines.filter((l: any) => l.kind !== "goods").map((l: any) => l.description);
    expect(names).toContain("Handling");
    expect(names).toContain("Fuel surcharge");
    expect(names).not.toContain("Delivery charge");
    expect(names).not.toContain("Baling (warehouse orders)");
    expect(pv.freightExGst).toBe(0);
    expect(pv.notes.join(" ")).toContain("Not charged on a pickup: Delivery charge");
    expect(pv.review.join(" ")).toContain("Baling (warehouse orders) is set for warehouse orders only");
    expect(pv.review.join(" ")).toContain("Fuel surcharge stays on this pickup");
  });

  test("switching the draft is held until the changes are confirmed, and nothing is saved meanwhile", async () => {
    const e = await failure(update(id, { lines: [goods(MAT.other, 40, 6)], pickup: { mode: "tbc" } }));
    expect(e.code).toBe("CONFLICT");
    expect(e.data.chargeChanges).toEqual(expect.arrayContaining(["removed Delivery charge $50.00", "removed Baling (warehouse orders) $10.00"]));
    expect(e.data.chargeChanges.join(" ")).not.toContain("Handling");
    expect((await poRow(id)).deliver_to).toBe("warehouse");
    expect((await lineNames(id))).toContain("Delivery charge");
  });

  test("confirmed: saved as a pickup with the new charges; a counter charge can still be ticked on", async () => {
    await update(id, { lines: [goods(MAT.other, 40, 6)], pickup: { mode: "tbc" }, chargesConfirmed: true });
    const row = await poRow(id);
    expect(row.deliver_to).toBe("pickup");
    expect(row.freight_ex_gst).toBe(0);
    expect(row.delivery_address).toBe("");
    expect((await lineNames(id)).sort()).toEqual(["Fuel surcharge", "Handling"]);
    await update(id, { lines: [goods(MAT.other, 40, 6)], pickup: { mode: "tbc" }, feeIds: [FEE.baling] });
    expect((await lineNames(id)).sort()).toEqual(["Baling (warehouse orders)", "Fuel surcharge", "Handling"]);
    // A delivery charge can't be ticked onto a pickup.
    await update(id, { lines: [goods(MAT.other, 40, 6)], pickup: { mode: "tbc" }, feeIds: [FEE.delivery] });
    expect(await lineNames(id)).not.toContain("Delivery charge");
  });

  test("a hand-typed freight line stays, and is flagged to check", async () => {
    const pv = await run<any>(
      m.purchasing.preview,
      poIn({ lines: [goods(MAT.other, 40, 6), { kind: "freight", jobMaterialId: null, productId: null, description: "Freight", qty: 1, unit: "each", unitCostExGst: 25 }], pickup: { mode: "tbc" } }),
    );
    expect(pv.freightExGst).toBe(25);
    expect(pv.review.join(" ")).toContain("A freight line is typed on this pickup");
  });

  test("back to warehouse also asks first, then puts the delivery charge back", async () => {
    const e = await failure(update(id, { deliverTo: "warehouse", lines: [goods(MAT.other, 40, 6)] }));
    expect(e.code).toBe("CONFLICT");
    await update(id, { deliverTo: "warehouse", lines: [goods(MAT.other, 40, 6)], chargesConfirmed: true });
    const row = await poRow(id);
    expect(row.deliver_to).toBe("warehouse");
    expect(row.delivery_address).toBe(WAREHOUSE);
    expect(row.pickup_address).toBe("");
    expect(await lineNames(id)).toContain("Delivery charge");
    await remove(id);
  });
});

/* ================================== 9 ================================== */

describe("9. Save and reopen", () => {
  test("the job's PO list hands back the pickup exactly as saved", async () => {
    const po = await create({ lines: [goods(MAT.other, 40, 6)], pickup: { mode: "depot", depotId: yatalaId, name: "Yatala DC", address: "Gate 2, 45 Business St, Yatala QLD 4207" }, notes: "Ask for Sam at the trade counter." });
    const data = await run<any>(m.purchasing.forJob, { jobId: JOB });
    const back = data.pos.find((p: any) => p.id === po.id);
    expect(back.deliverTo).toBe("pickup");
    expect(back.pickupDepotId).toBe(yatalaId);
    expect(back.pickupName).toBe("Yatala DC");
    expect(back.pickupAddress).toBe("Gate 2, 45 Business St, Yatala QLD 4207");
    expect(back.deliveryAddress).toBe("");
    expect(back.notes).toBe("Ask for Sam at the trade counter.");
    // Saved again unchanged (same deliverTo): no charge question, no change to the saved depot.
    await update(po.id, { lines: [goods(MAT.other, 40, 6)], pickup: { mode: "depot", depotId: yatalaId, name: back.pickupName, address: back.pickupAddress }, notes: back.notes });
    expect((await depotRows()).find((d) => d.id === yatalaId).address).toBe(YATALA);
    await remove(po.id);
  });
});

/* ================================== 10 ================================= */

describe("10. PDF and email wording", () => {
  test("a saved depot prints PICKUP FROM SUPPLIER, the depot and the address, and collection notes", async () => {
    const po = await create({ lines: [goods(MAT.carpet, 40, 30)], pickup: { mode: "depot", depotId: yatalaId }, notes: "Collecting Friday 7am, Ute rego 123ABC." });
    const pdf = await pdfText(po.id);
    expect(pdf).toContain("Collection");
    expect(pdf).toContain("PICKUP FROM SUPPLIER");
    expect(pdf).toContain("Yatala DC");
    expect(pdf).toContain("45 Business St, Yatala QLD 4207");
    expect(pdf).toContain("Collecting Friday 7am");
    expect(pdf).not.toContain("Deliver to");
    expect(pdf).not.toContain("Freight to");
    expect(pdf).not.toContain("Smith St");
    expect(block(pdf)).not.toContain("Lawrence");
    const mail = await sendText(po.id);
    expect(mail.text).toContain("PICKUP FROM SUPPLIER\nYatala DC\n45 Business St, Yatala QLD 4207");
    expect(mail.text).not.toContain("Deliver to");
    expect(mail.text).not.toContain("Smith St");
    expect(mail.text).not.toContain("Lawrence");
  });
});

/* ================================== 11 ================================= */

describe("11. Existing Warehouse and Site behaviour", () => {
  test("warehouse: the warehouse address, its freight wording and the delivery charge, as before", async () => {
    const po = await create({ deliverTo: "warehouse", lines: [goods(MAT.glue, 2, 80)] });
    const row = await poRow(po.id);
    expect(row.delivery_address).toBe(WAREHOUSE);
    expect(row.pickup_address).toBe("");
    expect(await lineNames(po.id)).toContain("Delivery charge");
    const pdf = await pdfText(po.id);
    expect(pdf).toContain("Deliver to");
    expect(pdf).toContain("Lawrence Dr");
    expect(pdf).toContain("Freight to our warehouse");
    expect(pdf).not.toContain("PICKUP");
    await remove(po.id);
  });

  test("site: the job's site address, its own freight wording, no pickup", async () => {
    const po = await create({ deliverTo: "site", lines: [goods(MAT.glue, 2, 80)], pickup: { mode: "depot", depotId: yatalaId } });
    const row = await poRow(po.id);
    expect(row.delivery_address).toBe(SITE);
    expect(row.pickup_depot_id).toBeNull();
    expect(row.pickup_address).toBe("");
    const pdf = await pdfText(po.id);
    expect(pdf).toContain("Deliver to site");
    expect(pdf).toContain("Freight to site");
    expect(pdf).not.toContain("PICKUP");
    await remove(po.id);
  });

  test("the delivery email text is word for word what it was", () => {
    expect(m.poEmailText("Pickup Supplies", "PO188500-9", 188500, "warehouse", WAREHOUSE).text).toContain(`Deliver to: our warehouse, ${WAREHOUSE}`);
    expect(m.poEmailText("Pickup Supplies", "PO188500-9", 188500, "site", SITE).text).toContain(`Deliver to: site, ${SITE}`);
  });
});

/* ================================== 12 ================================= */

describe("12. Installer collection details, no prices", () => {
  test("the crew see where to pick up and the PO number, never a price or cost", async () => {
    const list = await m.crew.crewMaterials(JOB, null);
    const carpet = list.find((x: any) => x.name === "Test carpet, Grey" || String(x.name ?? x.description ?? "").includes("Test carpet"));
    expect(carpet).toBeTruthy();
    expect(carpet!.where).toBe("to_pickup");
    expect(carpet!.whereLabel).toContain("Pick up from supplier, PO PO188500-");
    expect(carpet!.whereLabel).toContain("Yatala DC, 45 Business St, Yatala QLD 4207");
    expect(JSON.stringify(list)).not.toMatch(/\$|30\.00|1,?200|totalExGst|unitCost/);
  });

  test("a pickup still to be confirmed says so; a sent PO keeps the place it was sent with", async () => {
    const list = await m.crew.crewMaterials(JOB, null);
    const by = (word: string) => list.find((x: any) => JSON.stringify(x).includes(word)) as any;
    expect(by("Test trims").whereLabel).toContain("Depot/address to be confirmed");
    expect(by("Test underlay").whereLabel).toContain("Nerang depot, 8 Hilldon Ct, Nerang QLD 4211");
    expect(by("Test adhesive").where).not.toBe("to_pickup");
  });
});

/* ========================== 13 wrong product guard ========================== */

// Wrong product PO (Damien, 11 Nov, job 188065), through the real routes as the PO screen calls them.
describe("13. Wrong product guard on the PO routes (188065)", () => {
  const JOB2 = 4401;
  const AGREED = 701;
  const OTHER = 702;
  let poId = 0;
  test("set up: a job whose accepted quote has one product; a material for another product", async () => {
    const { db } = m;
    await db.insert(schema.jobs).values({ id: JOB2, number: 188501, title: "Wrong product test job" } as any);
    await db.insert(schema.products).values({ id: AGREED, supplierId: SUP, brand: "WPR", range: "Eternity", colour: "Snow", category: "hybrid", unit: "m2", costPrice: 40, variantKey: "wpr-1" } as any);
    await db.insert(schema.products).values({ id: OTHER, supplierId: SUP, brand: "WPR", range: "Arlo", colour: "White", category: "hybrid", unit: "m2", costPrice: 38, variantKey: "wpr-2" } as any);
    const [qt] = await db.insert(schema.quotes).values({ number: 188501, version: 1, jobId: JOB2, status: "accepted", acceptedAt: new Date(), subtotal: 100, gst: 10, total: 110 } as any).returning();
    await db.insert(schema.quoteItems).values({ quoteId: qt!.id, productId: AGREED, kind: "supply", description: "WPR Eternity in Snow", qty: 40, unit: "m2", unitPrice: 60 } as any);
    await db.insert(schema.jobMaterials).values({ id: 20, jobId: JOB2, productId: OTHER, description: "WPR Arlo in White", qty: 40, unit: "m2", status: "to_order" } as any);
    await db.insert(schema.jobMaterials).values({ id: 21, jobId: JOB2, productId: AGREED, description: "WPR Eternity in Snow", qty: 40, unit: "m2", status: "to_order" } as any);
  });

  test("a draft with the wrong product can be saved, and says so; the agreed one does not", async () => {
    const wrong = await run<any>(m.purchasing.create, { ...poIn({ deliverTo: "warehouse", lines: [{ ...goods(20, 40, 38), productId: OTHER }] }), jobId: JOB2 });
    poId = wrong.id;
    expect(wrong.productMismatch).toEqual(["WPR Arlo in White is not on the accepted quote or an approved change. The client agreed to WPR Eternity in Snow."]);
    const right = await run<any>(m.purchasing.create, { ...poIn({ deliverTo: "warehouse", lines: [{ ...goods(21, 20, 40), productId: AGREED }] }), jobId: JOB2 });
    expect(right.productMismatch).toEqual([]);
  });

  test("the PO list shows the warning on the PO and on the material, not on the agreed ones", async () => {
    const f = await run<any>(m.purchasing.forJob, { jobId: JOB2 });
    const wrong = f.pos.find((p: any) => p.id === poId);
    expect(wrong.productMismatch.length).toBe(1);
    expect(f.pos.filter((p: any) => p.id !== poId).every((p: any) => p.productMismatch.length === 0)).toBe(true);
    // A draft does not order anything, so the wrong material still says so too. The agreed one never does.
    expect(f.materials.find((x: any) => x.id === 20).productMismatch).toContain("WPR Arlo in White is not on the accepted quote");
    expect(f.materials.find((x: any) => x.id === 21).productMismatch).toBeNull();
  });

  test("Send through the route is refused with Product mismatch and the substitute data the screen reads", async () => {
    const before = mails.length;
    const e = await failure(run(m.purchasing.send, { id: poId, saveEmail: false }));
    expect(e.message).toStartWith("Product mismatch. WPR Arlo in White is not on the accepted quote");
    expect(e.data.poSubstitute.length).toBe(1);
    const e2 = await failure(run(m.purchasing.markSent, { id: poId, how: "phoned", substituteOverride: { reason: "no" } }));
    expect(e2.message).toBe("Say why this substitute is OK before it is marked sent.");
    expect(mails.length).toBe(before);
    expect((await poRow(poId)).status).toBe("draft");
  });

  test("Remove draft is written to the job's history", async () => {
    await remove(poId);
    const rows = await q("select action, detail, actor_name from activity_log where job_id = ? and action = 'po_draft_removed'", [JOB2]);
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toContain("removed, never sent");
    expect(rows[0].actor_name).toBe("Test Admin");
    // The material goes back to still to order, and now shows the warning.
    const f = await run<any>(m.purchasing.forJob, { jobId: JOB2 });
    const mat = f.materials.find((x: any) => x.id === 20);
    expect(mat.productMismatch).toContain("WPR Arlo in White is not on the accepted quote");
  });

  test("a job with no accepted quote (job 4400 above) is never checked", async () => {
    const f = await run<any>(m.purchasing.forJob, { jobId: JOB });
    expect(f.pos.every((p: any) => p.productMismatch.length === 0)).toBe(true);
  });
});

/* ================================= after ================================= */

describe("Nothing left the machine", () => {
  test("no network call, only the stub mailer, and only to the test suppliers", () => {
    expect(blocked).toEqual([]);
    expect(mails.length).toBeGreaterThan(0);
    for (const x of mails) expect(x.to).toMatch(/@(pickup|other)\.invalid$/);
  });
});
