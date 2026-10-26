/* Price list import (lib/price-sheet.ts). Import fixes 26 Oct, items 1 to 6. */
import { describe, expect, test } from "bun:test";
import type { Product } from "../src/api/database/schema";
import { SHEET_COLUMNS, planImport } from "../src/api/lib/price-sheet";

const SUP = { id: 7, name: "MJS" };

const base = {
  supplierId: SUP.id,
  supplier: SUP.name,
  sku: "",
  brand: "MJS",
  range: "",
  colour: "",
  category: "accessory",
  unit: "each",
  soldAs: null,
  packM2Printed: null,
  widthM: null,
  rollLengthM: null,
  widthMm: null,
  lengthMm: null,
  unitsPerPack: null,
  unitM2: null,
  costPrice: null,
  sellPrice: null,
  cutCostPrice: null,
  rollPrice: null,
  defaultWastagePct: null,
  leadTimeDays: null,
  heldInWarehouse: false,
  active: true,
  notes: "",
  pieceLengthM: null,
  thicknessMm: null,
  wearLayerMm: null,
};
const prod = (p: Record<string, unknown>) => ({ ...base, ...p }) as unknown as Product;

const sheet = (rows: Partial<Record<(typeof SHEET_COLUMNS)[number], string>>[]) => [
  [...SHEET_COLUMNS],
  ...rows.map((r) => SHEET_COLUMNS.map((c) => r[c] ?? "")),
];

const mb = prod({ id: 1, sku: "MB250", range: "Moisture Block", colour: "Blue", category: "hard_floor_underlay", unit: "roll", widthM: 1.1, rollLengthM: 50, costPrice: 70.43, sellPrice: 135.6 });
const sb = prod({ id: 2, sku: "SB250", range: "Sound Block", colour: "Orange", category: "hard_floor_underlay", unit: "roll", widthM: 1, rollLengthM: 50, costPrice: 109.1, sellPrice: 210 });
const trim = prod({ id: 3, sku: "XSMA", range: "XS Multi Angle", colour: "Silver", unit: "each", soldAs: "box", packM2Printed: 1, unitsPerPack: 1, pieceLengthM: 3.4, costPrice: 13, sellPrice: 25 });
const all = [mb, sb, trim];

describe("unit change on an existing product (items 1, 2, 3)", () => {
  const plan = planImport(
    sheet([
      { terra_id: "1", sku: "MB250", supplier: "MJS", unit: "m2", format: "Broadloom", stocked: "Y", cost: "1.4" },
      { terra_id: "2", sku: "SB250", supplier: "MJS", unit: "m2", format: "Broadloom", stocked: "Y", cost: "2.18" },
    ]),
    all,
    [SUP],
  );
  test("both rows update, no errors", () => {
    expect(plan.errors).toEqual([]);
    expect(plan.updates.map((u) => u.productId)).toEqual([1, 2]);
  });
  test("roll price kept from the old per-roll cost", () => {
    expect(plan.updates[1].after.rollPrice).toBe(109.1);
    expect(plan.updates[1].after.unit).toBe("m2");
    expect(plan.updates[1].after.soldAs).toBe("broadloom");
  });
  test("cost compared like for like, not 98% down", () => {
    const w = plan.updates[1].warnings.join(" ");
    expect(w).not.toContain("down 98%");
    expect(w).toContain("Unit changed from roll to m²");
    expect(w).toContain("the same like for like");
  });
});

describe("terra_id problems give the full reason (items 1, 6)", () => {
  test("terra_id copied from the row above names both products", () => {
    const plan = planImport(sheet([{ terra_id: "1", sku: "SB250", supplier: "MJS", cost: "2" }]), all, [SUP]);
    expect(plan.errors[0].message).toContain("terra_id 1 is MB250");
    expect(plan.errors[0].message).toContain("id 2");
  });
  test("deleted terra_id matches on SKU", () => {
    const plan = planImport(sheet([{ terra_id: "99", sku: "SB250", supplier: "MJS", cost: "120" }]), all, [SUP]);
    expect(plan.errors).toEqual([]);
    expect(plan.updates[0].productId).toBe(2);
    expect(plan.updates[0].warnings[0]).toContain("not in the price list any more");
  });
  test("deleted terra_id with no SKU match is added new", () => {
    const row = { terra_id: "99", sku: "NEW1", supplier: "MJS", brand: "MJS", range: "New", colour: "Red", category: "carpet underlay", unit: "m2", sold_as: "Broadloom", format: "Broadloom", roll_width_m: "1.8", cost: "3" };
    const plan = planImport(sheet([row]), all, [SUP]);
    expect(plan.errors).toEqual([]);
    expect(plan.creates.length).toBe(1);
  });
});

describe("trims sold in lengths (item 4)", () => {
  test("unit length is saved per lm with the length kept, box size dropped", () => {
    const plan = planImport(sheet([{ terra_id: "3", supplier: "MJS", category: "trims", unit: "length", format: "Length", cost: "13", sell: "25" }]), all, [SUP]);
    expect(plan.errors).toEqual([]);
    const a = plan.updates[0].after;
    expect(a.category).toBe("trim");
    expect(a.unit).toBe("lm");
    expect(a.soldAs).toBeNull();
    expect(a.costPrice).toBeCloseTo(13 / 3.4, 3);
    expect(a.sellPrice).toBeCloseTo(25 / 3.4, 3);
    expect(a.packM2Printed).toBeNull();
    expect(plan.updates[0].warnings.join(" ")).not.toMatch(/Cost (up|down)/);
  });
  test("unit length with no trim_length_m is an error that says so", () => {
    const row = { supplier: "MJS", brand: "MJS", range: "Nosing", colour: "Black", category: "stair nosing", unit: "length", cost: "30" };
    const plan = planImport(sheet([row]), all, [SUP]);
    expect(plan.errors[0].message).toContain("trim_length_m");
  });
  test("new scotia per length needs no format column", () => {
    const row = { supplier: "MJS", brand: "MJS", range: "Scotia", colour: "Oak", category: "scotia", unit: "length", trim_length_m: "2.4", cost: "6", sell: "12" };
    const plan = planImport(sheet([row]), all, [SUP]);
    expect(plan.errors).toEqual([]);
    expect(plan.creates[0].values.category).toBe("scotia");
    expect(plan.creates[0].values.pieceLengthM).toBe(2.4);
    expect(plan.creates[0].values.costPrice).toBeCloseTo(2.5, 4);
  });
});

describe("box size warning only on boxed floors (item 5)", () => {
  test("an accessory sold by the box gets no box_m2 warning", () => {
    const row = { supplier: "MJS", brand: "MJS", range: "Glue", colour: "X", category: "accessory", unit: "each", sold_as: "Box", format: "Box", cost: "20" };
    const plan = planImport(sheet([row]), all, [SUP]);
    expect(plan.errors).toEqual([]);
    expect(plan.creates[0].warnings.join(" ")).not.toContain("box_m2");
  });
  test("a hybrid sold by the box with no size still warns", () => {
    const row = { supplier: "MJS", brand: "MJS", range: "Hybrid", colour: "Oak", category: "hybrid", unit: "m2", sold_as: "Box", format: "Box", cost: "30" };
    const plan = planImport(sheet([row]), all, [SUP]);
    expect(plan.creates[0].warnings.join(" ")).toContain("box_m2");
  });
});
