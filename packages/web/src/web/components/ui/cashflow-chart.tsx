import * as React from "react";
import { moneyShort, money, shortDate } from "../../lib/money";

/**
 * The cashflow chart: money in and money out as paired bars, the projected
 * closing balance as a line over the top.
 *
 * Hand-drawn SVG rather than a chart library because the confidence split is
 * the whole point. Committed money is solid, expected money is lighter, and
 * pipeline is hatched, so you can see at a glance how much of the shape of the
 * month is actually signed for.
 */

export interface ChartBucket {
  label: string;
  start: string;
  end: string;
  inCommitted: number;
  inExpected: number;
  inPipeline: number;
  outCommitted: number;
  outExpected: number;
  outPipeline: number;
  net: number;
  closing: number;
}

const H = 240;
const PAD = { top: 16, right: 56, bottom: 34, left: 56 };

export function CashflowChart({
  buckets,
  includePipeline,
  showBalance = true,
}: {
  buckets: ChartBucket[];
  includePipeline: boolean;
  showBalance?: boolean;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  if (buckets.length === 0) return null;

  const inOf = (b: ChartBucket) => b.inCommitted + b.inExpected + (includePipeline ? b.inPipeline : 0);
  const outOf = (b: ChartBucket) => b.outCommitted + b.outExpected + (includePipeline ? b.outPipeline : 0);

  const maxBar = Math.max(1, ...buckets.map((b) => Math.max(inOf(b), outOf(b))));
  const balances = buckets.map((b) => b.closing);
  const balMin = Math.min(0, ...balances);
  const balMax = Math.max(1, ...balances);

  const W = 100; // viewBox width in percent-ish units, scaled by the container
  const plotH = H - PAD.top - PAD.bottom;
  const colW = W / buckets.length;
  const barW = Math.min(colW * 0.32, 4.2);

  const yBar = (v: number) => PAD.top + plotH - (v / maxBar) * plotH;
  const yBal = (v: number) => PAD.top + plotH - ((v - balMin) / (balMax - balMin || 1)) * plotH;

  const linePoints = buckets
    .map((b, i) => `${(i + 0.5) * colW},${yBal(b.closing)}`)
    .join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[260px] w-full"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <pattern id="hatch" width="1.4" height="1.4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="1.4" stroke="currentColor" strokeWidth="0.5" className="text-white/25" />
          </pattern>
        </defs>

        {/* horizontal grid */}
        {gridLines.map((g) => (
          <line
            key={g}
            x1={0}
            x2={W}
            y1={PAD.top + plotH * g}
            y2={PAD.top + plotH * g}
            className="stroke-border"
            strokeWidth="0.15"
          />
        ))}

        {buckets.map((b, i) => {
          const x = i * colW;
          const inV = inOf(b);
          const outV = outOf(b);
          const stack = (vals: number[], left: boolean) => {
            let acc = 0;
            return vals.map((v, k) => {
              const y0 = yBar(acc + v);
              const h = Math.max(0, yBar(acc) - y0);
              acc += v;
              return { y: y0, h, k, left };
            });
          };
          const inSegs = stack(
            [b.inCommitted, b.inExpected, ...(includePipeline ? [b.inPipeline] : [])],
            true,
          );
          const outSegs = stack(
            [b.outCommitted, b.outExpected, ...(includePipeline ? [b.outPipeline] : [])],
            false,
          );
          const inFill = ["fill-[var(--success)]", "fill-[var(--success)]/45", "fill-[var(--success)]/20"];
          const outFill = ["fill-destructive", "fill-destructive/45", "fill-destructive/20"];
          return (
            <g key={b.start} onMouseEnter={() => setHover(i)}>
              <rect
                x={x}
                y={PAD.top}
                width={colW}
                height={plotH}
                className={hover === i ? "fill-white/[0.04]" : "fill-transparent"}
              />
              {inSegs.map((s) => (
                <rect
                  key={`i${s.k}`}
                  x={x + colW / 2 - barW - 0.3}
                  y={s.y}
                  width={barW}
                  height={s.h}
                  className={inFill[s.k]}
                  rx="0.4"
                />
              ))}
              {outSegs.map((s) => (
                <rect
                  key={`o${s.k}`}
                  x={x + colW / 2 + 0.3}
                  y={s.y}
                  width={barW}
                  height={s.h}
                  className={outFill[s.k]}
                  rx="0.4"
                />
              ))}
              {inV === 0 && outV === 0 ? null : null}
            </g>
          );
        })}

        {/* projected closing balance */}
        {showBalance ? (
          <>
            <polyline
              points={linePoints}
              fill="none"
              className="stroke-[var(--gold)]"
              strokeWidth="0.45"
              vectorEffect="non-scaling-stroke"
            />
            {buckets.map((b, i) => (
              <circle
                key={b.start}
                cx={(i + 0.5) * colW}
                cy={yBal(b.closing)}
                r={hover === i ? 0.9 : 0.55}
                className="fill-[var(--gold)]"
              />
            ))}
          </>
        ) : null}

        {/* zero line for the balance scale, when the forecast goes negative */}
        {balMin < 0 ? (
          <line
            x1={0}
            x2={W}
            y1={yBal(0)}
            y2={yBal(0)}
            className="stroke-destructive"
            strokeWidth="0.2"
            strokeDasharray="1 1"
          />
        ) : null}
      </svg>

      {/* axis labels, in HTML so the text is not stretched by the viewBox */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-0 top-[16px] h-[190px] w-[52px]">
          {gridLines.map((g) => (
            <span
              key={g}
              className="tabular absolute right-1 -translate-y-1/2 text-[10px] text-muted-foreground"
              style={{ top: `${g * 100}%` }}
            >
              {moneyShort(maxBar * (1 - g))}
            </span>
          ))}
        </div>
        <div className="absolute bottom-[6px] left-0 right-0 flex">
          {buckets.map((b, i) => (
            <span
              key={b.start}
              className={`flex-1 text-center text-[10px] ${hover === i ? "text-foreground" : "text-muted-foreground"}`}
            >
              {b.label}
            </span>
          ))}
        </div>
      </div>

      {hover !== null && buckets[hover] ? (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 w-[230px] -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-xl">
          <p className="font-semibold">
            {shortDate(buckets[hover]!.start)} to {shortDate(buckets[hover]!.end)}
          </p>
          <dl className="mt-1.5 space-y-0.5">
            <Row label="In, committed" value={money(buckets[hover]!.inCommitted)} tone="success" />
            <Row label="In, expected" value={money(buckets[hover]!.inExpected)} tone="success" />
            {includePipeline ? (
              <Row label="In, pipeline" value={money(buckets[hover]!.inPipeline)} tone="muted" />
            ) : null}
            <Row label="Out, committed" value={money(buckets[hover]!.outCommitted)} tone="danger" />
            <Row label="Out, expected" value={money(buckets[hover]!.outExpected)} tone="danger" />
            <div className="my-1 border-t border-border" />
            <Row label="Net" value={money(buckets[hover]!.net)} />
            <Row label="Closing" value={money(buckets[hover]!.closing)} tone="gold" />
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "danger" | "muted" | "gold";
}) {
  const cls = {
    default: "text-foreground",
    success: "text-[var(--success)]",
    danger: "text-destructive",
    muted: "text-muted-foreground",
    gold: "text-[var(--gold)]",
  }[tone];
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`tabular font-medium ${cls}`}>{value}</dd>
    </div>
  );
}

/** The legend, kept next to the chart it explains. */
export function ChartLegend({ includePipeline }: { includePipeline: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
      <Key className="bg-[var(--success)]" label="In, committed" />
      <Key className="bg-[var(--success)]/45" label="In, expected" />
      {includePipeline ? <Key className="bg-[var(--success)]/20" label="In, pipeline" /> : null}
      <Key className="bg-destructive" label="Out, committed" />
      <Key className="bg-destructive/45" label="Out, expected" />
      <Key className="bg-[var(--gold)]" label="Projected balance" />
    </div>
  );
}

function Key({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block size-2.5 rounded-sm ${className}`} />
      {label}
    </span>
  );
}
