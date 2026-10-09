import * as React from "react";

/**
 * Finger or mouse signature for the web. Sends the same shape the phone pad
 * and lib/signature.ts use: the pad size and each stroke as a flat list of
 * x,y points in pad pixels. The server checks there is real ink.
 */
export type SignatureValue = { w: number; h: number; strokes: number[][] };

export function SignaturePad({
  onChange,
  height = 180,
  disabled = false,
}: {
  onChange: (value: SignatureValue | null) => void;
  height?: number;
  disabled?: boolean;
}) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const strokes = React.useRef<number[][]>([]);
  const drawing = React.useRef(false);
  const [width, setWidth] = React.useState(0);
  const [hasInk, setHasInk] = React.useState(false);

  // The pad is as wide as its box. A resize clears it, since the points would no longer line up.
  React.useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const redraw = React.useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = "#171614";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes.current) {
      if (s.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(s[0]!, s[1]!);
      if (s.length === 2) ctx.lineTo(s[0]! + 0.1, s[1]! + 0.1);
      for (let i = 2; i + 1 < s.length; i += 2) ctx.lineTo(s[i]!, s[i + 1]!);
      ctx.stroke();
    }
  }, []);

  React.useEffect(() => {
    const c = canvas.current;
    if (!c || !width) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = width * ratio;
    c.height = height * ratio;
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    strokes.current = [];
    setHasInk(false);
    onChange(null);
    redraw();
    // onChange is the parent's setter; only a size change should clear the pad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, redraw]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(width, e.clientX - r.left)), Math.max(0, Math.min(height, e.clientY - r.top))] as const;
  };

  const emit = () => {
    const ink = strokes.current.some((s) => s.length >= 4);
    setHasInk(ink);
    onChange(ink ? { w: width, h: height, strokes: strokes.current.map((s) => s.map((v) => Math.round(v))) } : null);
  };

  return (
    <div>
      <div
        ref={wrap}
        className="relative overflow-hidden rounded-lg border border-dashed border-[#BC9558] bg-white"
        style={{ height }}
      >
        <canvas
          ref={canvas}
          aria-label="Signature pad"
          className="block touch-none"
          style={{ cursor: disabled ? "not-allowed" : "crosshair" }}
          onPointerDown={(e) => {
            if (disabled || strokes.current.length >= 200) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drawing.current = true;
            const [x, y] = point(e);
            strokes.current.push([x, y]);
            redraw();
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return;
            const s = strokes.current[strokes.current.length - 1];
            if (!s || s.length >= 3998) return;
            const [x, y] = point(e);
            const lx = s[s.length - 2]!;
            const ly = s[s.length - 1]!;
            if (Math.hypot(x - lx, y - ly) < 1.5) return;
            s.push(x, y);
            redraw();
          }}
          onPointerUp={() => {
            if (!drawing.current) return;
            drawing.current = false;
            emit();
          }}
          onPointerCancel={() => {
            drawing.current = false;
            emit();
          }}
        />
        {!hasInk ? (
          <span className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-[#77706A]">
            Sign here with your finger or mouse
          </span>
        ) : null}
        <span className="pointer-events-none absolute inset-x-6 bottom-9 border-b border-[#E3DFD9]" />
      </div>
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          disabled={disabled || !hasInk}
          className="text-xs font-medium text-[#906F3C] hover:underline disabled:opacity-40"
          onClick={() => {
            strokes.current = [];
            redraw();
            emit();
          }}
        >
          Clear signature
        </button>
      </div>
    </div>
  );
}
