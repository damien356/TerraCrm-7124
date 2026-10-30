/*
 * Client invoice status, as three separate things (Damien, 31 Oct, job 188054):
 * - Email: "Not sent" until the invoice has actually been emailed.
 * - Payment: Owing, Part paid or Paid, from the amounts.
 * - Xero: Not in Xero or In Xero.
 * The stored status "sent" only means open. It is never shown as "sent".
 */

export type InvoiceStateInput = {
  status: string;
  total: number;
  /** Amount received so far. */
  amountPaid: number;
  /** Last successful email, from the activity log. Null or missing: never emailed. */
  emailedAt?: Date | string | null;
  inXero?: boolean;
};

export type InvoiceState = { label: string; colour: string };

const day = (v: Date | string) => {
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Brisbane" });
};

export function paymentState(i: InvoiceStateInput): InvoiceState {
  if (i.status === "void") return { label: "Void", colour: "#9B3B32" };
  if (i.status === "draft") return { label: "Draft", colour: "#7A736D" };
  if (i.status === "paid" || (i.total > 0 && i.amountPaid >= i.total - 0.005)) return { label: "Paid", colour: "#3F7D3A" };
  if (i.amountPaid > 0.005) return { label: "Part paid", colour: "#4A7FA5" };
  return { label: "Owing", colour: "#D08A1E" };
}

export function emailState(i: InvoiceStateInput): InvoiceState {
  return i.emailedAt ? { label: `Emailed ${day(i.emailedAt)}`.trim(), colour: "#3F7D3A" } : { label: "Not sent", colour: "#7A736D" };
}

export function xeroState(i: InvoiceStateInput): InvoiceState {
  return i.inXero ? { label: "In Xero", colour: "#13B5EA" } : { label: "Not in Xero", colour: "#7A736D" };
}

/** One line for lists, for example "Not sent · Owing · Not in Xero". A void invoice is just "Void". */
export function invoiceStatusText(i: InvoiceStateInput): string {
  const pay = paymentState(i);
  if (i.status === "void") return pay.label;
  return [emailState(i).label, pay.label, xeroState(i).label].join(" · ");
}
