import React from "react";
import { Document, Page, Text, View, Image, StyleSheet, renderToBuffer } from "@react-pdf/renderer";

/**
 * The installer's own invoice to Terra, rendered in their business name.
 * Built with React.createElement, not JSX — this file lives under the API
 * project's tsconfig, which has no "jsx" compiler option, and adding one
 * would open JSX up across every server file rather than just this one.
 */

export interface InvoiceLineItem {
  description: string;
  unit: string;
  qty: number;
  rate: number | null;
  total: number | null;
}

export interface InvoicePdfInput {
  invoiceNumber: number;
  invoiceDate: string;
  tradingName: string;
  installerName: string;
  abn: string | null;
  gstRegistered: boolean;
  businessAddress: string | null;
  invoiceEmail: string | null;
  mobile: string | null;
  logoDataUri: string | null;
  bankAccountName: string | null;
  bankBsb: string | null;
  bankAccountNumber: string | null;
  jobNumber: number;
  siteAddress: string | null;
  taskTitle: string;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  gstAmount: number;
  total: number;
}

const TERRA_BILL_TO = {
  name: "Arclan Pty Ltd t/a Terra Flooring",
  abn: "82 651 012 001",
  address: "2/22 Lawrence Dr, Nerang QLD 4211",
} as const;

const money = (n: number) => `$${n.toFixed(2)}`;

const s = StyleSheet.create({
  page: { padding: 36, fontSize: 10, color: "#1f1d1b", fontFamily: "Helvetica" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  logo: { width: 90, height: 90, objectFit: "contain" },
  businessName: { fontSize: 16, fontWeight: 700, marginBottom: 4 },
  small: { fontSize: 9, color: "#4a4540", marginBottom: 2 },
  invoiceTitle: { fontSize: 20, fontWeight: 700, marginBottom: 4, textAlign: "right" },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  block: { width: "48%" },
  blockLabel: { fontSize: 8, color: "#8a847c", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  blockText: { fontSize: 10, marginBottom: 2 },
  table: { marginTop: 8, borderTop: "1px solid #ddd8d2" },
  tHeadRow: { flexDirection: "row", paddingVertical: 6, borderBottom: "1px solid #1f1d1b" },
  tRow: { flexDirection: "row", paddingVertical: 6, borderBottom: "1px solid #ebe7e2" },
  colDesc: { width: "40%" },
  colUnit: { width: "12%", textAlign: "right" },
  colQty: { width: "12%", textAlign: "right" },
  colRate: { width: "18%", textAlign: "right" },
  colTotal: { width: "18%", textAlign: "right" },
  th: { fontSize: 8, color: "#8a847c", textTransform: "uppercase", letterSpacing: 0.5 },
  totalsBlock: { marginTop: 16, alignItems: "flex-end" },
  totalsRow: { flexDirection: "row", width: 220, justifyContent: "space-between", paddingVertical: 3 },
  totalsLabel: { fontSize: 10 },
  totalsFinalRow: {
    flexDirection: "row",
    width: 220,
    justifyContent: "space-between",
    paddingVertical: 6,
    borderTop: "1px solid #1f1d1b",
    marginTop: 4,
  },
  totalsFinalLabel: { fontSize: 12, fontWeight: 700 },
  totalsFinalValue: { fontSize: 12, fontWeight: 700 },
  bankBox: { marginTop: 30, padding: 12, backgroundColor: "#f5f4f2", borderRadius: 4 },
  bankLabel: { fontSize: 8, color: "#8a847c", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  bankLine: { fontSize: 10, marginBottom: 2 },
  footer: { marginTop: 30, fontSize: 8, color: "#8a847c", textAlign: "center" },
});

function el<P>(type: any, props: P | null, ...children: any[]) {
  return React.createElement(type, props as any, ...children);
}

export function buildInvoiceDocument(input: InvoicePdfInput) {
  const gstLabel = input.gstRegistered ? "Tax Invoice" : "Invoice";

  const headerLeft = el(
    View,
    null,
    input.logoDataUri ? el(Image, { src: input.logoDataUri, style: s.logo }) : null,
    el(Text, { style: s.businessName }, input.tradingName || input.installerName),
    input.installerName && input.installerName !== input.tradingName
      ? el(Text, { style: s.small }, input.installerName)
      : null,
    input.abn ? el(Text, { style: s.small }, `ABN ${input.abn}`) : null,
    input.businessAddress ? el(Text, { style: s.small }, input.businessAddress) : null,
    input.invoiceEmail ? el(Text, { style: s.small }, input.invoiceEmail) : null,
    input.mobile ? el(Text, { style: s.small }, input.mobile) : null,
  );

  const headerRight = el(
    View,
    { style: { alignItems: "flex-end" } },
    el(Text, { style: s.invoiceTitle }, gstLabel),
    el(Text, { style: s.small }, `Invoice # ${input.invoiceNumber}`),
    el(Text, { style: s.small }, `Date ${input.invoiceDate}`),
  );

  const billTo = el(
    View,
    { style: s.block },
    el(Text, { style: s.blockLabel }, "Bill to"),
    el(Text, { style: s.blockText }, TERRA_BILL_TO.name),
    el(Text, { style: s.blockText }, `ABN ${TERRA_BILL_TO.abn}`),
    el(Text, { style: s.blockText }, TERRA_BILL_TO.address),
  );

  const jobBlock = el(
    View,
    { style: s.block },
    el(Text, { style: s.blockLabel }, "Job"),
    el(Text, { style: s.blockText }, `Job #${input.jobNumber}`),
    el(Text, { style: s.blockText }, input.taskTitle),
    input.siteAddress ? el(Text, { style: s.blockText }, input.siteAddress) : null,
  );

  const tableHead = el(
    View,
    { style: s.tHeadRow },
    el(Text, { style: [s.th, s.colDesc] }, "Description"),
    el(Text, { style: [s.th, s.colUnit] }, "Unit"),
    el(Text, { style: [s.th, s.colQty] }, "Qty"),
    el(Text, { style: [s.th, s.colRate] }, "Rate"),
    el(Text, { style: [s.th, s.colTotal] }, "Total"),
  );

  const tableRows = input.lineItems.map((line, i) =>
    el(
      View,
      { key: String(i), style: s.tRow },
      el(Text, { style: s.colDesc }, line.description),
      el(Text, { style: s.colUnit }, line.unit),
      el(Text, { style: s.colQty }, String(line.qty)),
      el(Text, { style: s.colRate }, line.rate != null ? money(line.rate) : "-"),
      el(Text, { style: s.colTotal }, line.total != null ? money(line.total) : "-"),
    ),
  );

  const totals = el(
    View,
    { style: s.totalsBlock },
    el(
      View,
      { style: s.totalsRow },
      el(Text, { style: s.totalsLabel }, "Subtotal"),
      el(Text, { style: s.totalsLabel }, money(input.subtotal)),
    ),
    input.gstRegistered
      ? el(
          View,
          { style: s.totalsRow },
          el(Text, { style: s.totalsLabel }, "GST (10%)"),
          el(Text, { style: s.totalsLabel }, money(input.gstAmount)),
        )
      : null,
    el(
      View,
      { style: s.totalsFinalRow },
      el(Text, { style: s.totalsFinalLabel }, "Total due"),
      el(Text, { style: s.totalsFinalValue }, money(input.total)),
    ),
  );

  const bank =
    input.bankBsb && input.bankAccountNumber
      ? el(
          View,
          { style: s.bankBox },
          el(Text, { style: s.bankLabel }, "Payment details"),
          el(Text, { style: s.bankLine }, `Account name: ${input.bankAccountName ?? ""}`),
          el(Text, { style: s.bankLine }, `BSB: ${input.bankBsb}`),
          el(Text, { style: s.bankLine }, `Account number: ${input.bankAccountNumber}`),
        )
      : null;

  const footer = el(Text, { style: s.footer }, "Generated by Terra Ops on behalf of the contractor named above.");

  return el(
    Document,
    null,
    el(
      Page,
      { size: "A4", style: s.page },
      el(View, { style: s.headerRow }, headerLeft, headerRight),
      el(View, { style: s.metaRow }, billTo, jobBlock),
      el(View, { style: s.table }, tableHead, ...tableRows),
      totals,
      bank,
      footer,
    ),
  );
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  return renderToBuffer(buildInvoiceDocument(input) as any);
}
