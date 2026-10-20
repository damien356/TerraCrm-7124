import * as React from "react";
import { FileDown } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/card";
import { downloadBase64 } from "../public-shell";
import { moneyExact } from "../../lib/money";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS } from "../../../api/lib/product-categories";

/** Trade sales screens (notes 18.65). Admin only. Shared bits. */

export const TRADE_CATEGORIES = PRODUCT_CATEGORIES.map((c) => ({ name: c, label: PRODUCT_CATEGORY_LABELS[c] ?? c.replace(/_/g, " ") }));

export const errText = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e ?? ""));

export const m2 = (n: number | null | undefined) => moneyExact(n ?? 0);

export const qtyText = (n: number | null | undefined) => {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
};

export const auDate = (d: Date | string | null | undefined) => {
  if (!d) return "";
  const x = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00`) : new Date(d);
  return Number.isNaN(x.getTime()) ? "" : x.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

export const auDateTime = (d: Date | string | null | undefined) => {
  if (!d) return "";
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? "" : x.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};

export const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const STATE: Record<string, { label: string; colour: string }> = {
  draft: { label: "Draft", colour: "#7A736D" },
  outstanding: { label: "Owing", colour: "#C08A24" },
  part_paid: { label: "Part paid", colour: "#4A7FA5" },
  paid: { label: "Paid", colour: "#2E6B4F" },
  credit_balance: { label: "Credit balance", colour: "#B23B2C" },
  cancelled: { label: "Cancelled", colour: "#7A736D" },
};

export function SaleState({ state }: { state: string }) {
  const s = STATE[state] ?? { label: state, colour: "#7A736D" };
  return <Badge colour={s.colour}>{s.label}</Badge>;
}

const OFFSET: Record<string, { label: string; colour: string }> = {
  proposed: { label: "Offset proposed", colour: "#C08A24" },
  approved: { label: "Offset approved", colour: "#4A7FA5" },
  confirmed: { label: "Offset confirmed", colour: "#2E6B4F" },
  cancelled: { label: "Offset cancelled", colour: "#7A736D" },
  reversed: { label: "Offset reversed", colour: "#7A736D" },
};

export function OffsetBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const s = OFFSET[status] ?? { label: status, colour: "#7A736D" };
  return <Badge colour={s.colour}>{s.label}</Badge>;
}

/** Fetches a base64 PDF from the server and saves it. */
export function PdfButton({ label, get }: { label: string; get: () => Promise<{ filename: string; base64: string }> }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const out = await get();
            downloadBase64(out.filename, out.base64);
          } catch (e) {
            setErr(errText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner /> : <FileDown className="size-4" />}
        {label}
      </Button>
      {err ? <span className="text-xs text-destructive">{err}</span> : null}
    </span>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="mt-2 text-sm text-destructive">{errText(error)}</p>;
}

export function Row({ label, value, strong, tone }: { label: React.ReactNode; value: React.ReactNode; strong?: boolean; tone?: "danger" | "success" }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "text-base font-bold" : "text-sm"} ${tone === "danger" ? "text-destructive" : tone === "success" ? "text-[var(--success)]" : ""}`}>
      <dt className={strong ? "" : "text-muted-foreground"}>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}

/** Reads a picked file as base64 for the upload procedures. Max 8 MB. */
export async function fileToUpload(f: File): Promise<{ filename: string; mime: string; base64: string }> {
  if (f.size > 8 * 1024 * 1024) throw new Error("That file is over 8 MB.");
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { filename: f.name, mime: f.type || "application/octet-stream", base64: btoa(bin) };
}
