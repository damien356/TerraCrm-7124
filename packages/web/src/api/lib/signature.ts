import { z } from "zod";
import { rgb, type PDFPage } from "pdf-lib";

/* ---------------------------------------------------------------------------
 * On-screen signatures, shared by the SWMS and (next) quote acceptance.
 *
 * The phone sends the raw strokes, not a picture: the pad size it was drawn
 * on and each stroke as a flat list of x,y points. The server checks there is
 * real ink, stores the JSON, and draws it into whatever PDF needs it. No image
 * library on the phone, so the pad ships as an over-the-air update.
 * ------------------------------------------------------------------------- */

export const signatureInput = z.object({
  w: z.number().min(50).max(4000),
  h: z.number().min(30).max(4000),
  /** Each stroke is [x0, y0, x1, y1, ...] in pad pixels. */
  strokes: z.array(z.array(z.number()).max(4000)).min(1).max(200),
});
export type Signature = z.infer<typeof signatureInput>;

/** Total ink length in pad pixels. */
function inkLength(sig: Signature) {
  let len = 0;
  for (const s of sig.strokes) {
    for (let i = 2; i + 1 < s.length; i += 2) len += Math.hypot(s[i]! - s[i - 2]!, s[i + 1]! - s[i - 1]!);
  }
  return len;
}

/**
 * A tap or a dot is not a signature. Asks for ink at least a third of the
 * pad's width, which any real scrawl clears easily.
 */
export function checkSignature(sig: Signature): string | null {
  const points = sig.strokes.reduce((n, s) => n + Math.floor(s.length / 2), 0);
  if (points < 8 || inkLength(sig) < sig.w / 3) return "Sign in the box before saving.";
  return null;
}

/** Round to whole pixels and drop anything outside the pad, so stored JSON stays small. */
export function tidySignature(sig: Signature): Signature {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  return {
    w: Math.round(sig.w),
    h: Math.round(sig.h),
    strokes: sig.strokes
      .map((s) => {
        const out: number[] = [];
        for (let i = 0; i + 1 < s.length; i += 2) out.push(clamp(s[i]!, sig.w), clamp(s[i + 1]!, sig.h));
        return out;
      })
      .filter((s) => s.length >= 2),
  };
}

/**
 * Draw a signature into a PDF box, keeping its shape. (x, y) is the bottom
 * left of the box in PDF points.
 */
export function drawSignature(page: PDFPage, sig: Signature, box: { x: number; y: number; w: number; h: number }) {
  const scale = Math.min(box.w / sig.w, box.h / sig.h);
  const ox = box.x + (box.w - sig.w * scale) / 2;
  const oy = box.y + (box.h - sig.h * scale) / 2;
  const P = (x: number, y: number) => ({ x: ox + x * scale, y: oy + (sig.h - y) * scale });
  const color = rgb(0.08, 0.12, 0.3);
  for (const s of sig.strokes) {
    if (s.length === 2) {
      page.drawCircle({ ...P(s[0]!, s[1]!), size: 0.8, color });
      continue;
    }
    for (let i = 2; i + 1 < s.length; i += 2) {
      page.drawLine({ start: P(s[i - 2]!, s[i - 1]!), end: P(s[i]!, s[i + 1]!), thickness: 1.3, color });
    }
  }
}
