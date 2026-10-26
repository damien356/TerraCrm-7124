/* The client invoice carries the quote's works (Damien, 26 Oct): lib/clientInvoicePdf.ts. */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientInvoicePdfInput, InvoiceWorks } from "../src/api/lib/clientInvoicePdf";

// The renderer is pure, but its file also reads the database. Point that at nothing before it loads.
process.env.DATABASE_URL ??= "file::memory:";
// Nothing is sent and nobody signs in; these modules only need a value to load.
process.env.RESEND_API_KEY ??= "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";
let render: (i: ClientInvoicePdfInput) => Promise<Buffer>;
beforeAll(async () => {
  render = (await import("../src/api/lib/clientInvoicePdf")).renderClientInvoicePdf;
});

const dir = mkdtempSync(join(tmpdir(), "inv-writeup-"));
/** The PDF's text, page by page, read back with pdftotext. */
async function pagesOf(pdf: Buffer, name: string): Promise<string[]> {
  const file = join(dir, `${name}.pdf`);
  writeFileSync(file, pdf);
  const p = Bun.spawnSync(["pdftotext", "-layout", file, "-"]);
  if (p.exitCode !== 0) throw new Error(`pdftotext failed: ${p.stderr.toString()}`);
  return p.stdout.toString().split("\f").filter((s) => s.trim());
}

const base: ClientInvoicePdfInput = {
  number: "IQ990001-2",
  date: "26/10/2026",
  dueDate: "30/11/2026",
  to: { name: "Test Client", company: null, address: "1 Test St", email: "test@example.invalid" },
  siteAddress: "1 Test St, Nerang QLD 4211",
  jobRef: "990001",
  description: "Final invoice, quote Q990001",
  subtotal: 750,
  gst: 75,
  total: 825,
  paid: 0,
  owing: 825,
  payUrl: null,
};

const works: InvoiceWorks = {
  quoteRef: "Q990001",
  bundles: [
    { title: "Flooring supply", wording: "Supply and install hybrid plank to the living room.\nSecond paragraph of wording.", total: 1000 },
    { title: "Preparation", wording: "Grind and level the slab.", total: 500 },
  ],
  subtotal: 1500,
  gst: 150,
  total: 1650,
};

const summary: NonNullable<ClientInvoicePdfInput["summary"]> = [
  { kind: "quote", label: "Quote Q990001", amount: 1650 },
  { kind: "previous", label: "IQ990001-1, Deposit 50% on quote Q990001", amount: 825 },
  { kind: "this", label: "This invoice IQ990001-2", amount: 825 },
  { kind: "remaining", label: "Remaining to invoice after this invoice", amount: 0 },
];

describe("client invoice PDF", () => {
  test("an invoice with no quote keeps the one line layout", async () => {
    const pages = await pagesOf(await render(base), "plain");
    expect(pages.length).toBe(1);
    expect(pages[0]).toContain("DESCRIPTION");
    expect(pages[0]).toContain("Final invoice, quote Q990001");
    expect(pages[0]).not.toContain("WORKS AS QUOTED");
    expect(pages[0]).not.toContain("BILLING SUMMARY");
    expect(pages[0]).toContain("Page 1 of 1");
  });

  test("an invoice on a quote carries the quote's sections and wording, and how the billing adds up", async () => {
    const [page, ...rest] = await pagesOf(await render({ ...base, works, summary }), "sections");
    expect(rest.length).toBe(0);
    expect(page).toContain("WORKS AS QUOTED, QUOTE Q990001");
    expect(page).toContain("Flooring supply");
    expect(page).toContain("Supply and install hybrid plank to the living room.");
    expect(page).toContain("Second paragraph of wording.");
    expect(page).toContain("Grind and level the slab.");
    expect(page).toContain("Quote total (inc GST)");
    expect(page).toContain("$1,650.00");
    expect(page).toContain("BILLING SUMMARY FOR THIS JOB");
    expect(page).toContain("Previously invoiced");
    expect(page).toContain("invoices issued, not payments received");
    expect(page).toContain("Remaining to invoice after this invoice");
    expect(page).not.toContain("-$825.00");
    expect(page).toContain("THIS INVOICE");
    expect(page).toContain("Amount due on this invoice");
    expect(page).toContain("PAYMENT BY BANK TRANSFER");
  });

  test("an itemised quote shows its rows", async () => {
    const items = [
      { description: "Hybrid plank 9mm", qty: 42.5, unit: "m2", rate: 55, total: 2337.5 },
      { description: "Install hybrid", qty: 42.5, unit: "m2", rate: 30, total: 1275 },
    ];
    const [page] = await pagesOf(await render({ ...base, works: { ...works, items } }), "items");
    expect(page).toContain("QTY");
    expect(page).toContain("Hybrid plank 9mm");
    expect(page).toContain("$2,337.50");
    expect(page).toContain("All prices ex GST.");
    expect(page).not.toContain("Grind and level the slab.");
  });

  test("long works run onto more pages and everything after them still prints", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Area ${i + 1}`, wording: "Supply and install carpet with underlay.\nRemove and dispose of the old floor.", total: 100 }));
    const pages = await pagesOf(await render({ ...base, works: { ...works, bundles: many }, summary, payUrl: "https://example.invalid/pay/1-x" }), "long");
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[1]).toContain("Invoice IQ990001-2 (continued)");
    expect(pages[0]).toContain(`Page 1 of ${pages.length}`);
    const all = pages.join("\n");
    for (let i = 1; i <= 30; i++) expect(all).toContain(`Area ${i}\n`.trim());
    const last = pages[pages.length - 1]!;
    // The amount due travels with the payment boxes, never left a page behind them.
    expect(last).toContain("THIS INVOICE");
    expect(last).toContain("Amount due on this invoice");
    expect(last).toContain("PAYMENT BY BANK TRANSFER");
    expect(last).toContain("PAY BY CARD");
    expect(last).toContain("Thank you for your business.");
  });
});
