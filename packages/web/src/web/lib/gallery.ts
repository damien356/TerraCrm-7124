/**
 * The rules behind the Job file viewer, kept apart from the screen so they
 * can be tested on their own.
 *
 * One viewer only ever holds the files of one category on one job, in the
 * same order as the thumbnails. It does not wrap round at either end.
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;

/** The file next to this one, held at the first and last. */
export function stepIndex(index: number, delta: number, count: number) {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, index + delta));
}

export function clampZoom(z: number) {
  if (!Number.isFinite(z)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * How far a zoomed picture may be dragged. `shown` is the size it is drawn at
 * before zoom (fitted in the stage), `stage` the size of the space it sits in.
 * Never lets the picture's edge come further in than the stage's edge.
 */
export function clampPan(
  pan: { x: number; y: number },
  zoom: number,
  shown: { w: number; h: number },
  stage: { w: number; h: number },
) {
  const maxX = Math.max(0, (shown.w * zoom - stage.w) / 2);
  const maxY = Math.max(0, (shown.h * zoom - stage.h) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, pan.x)),
    y: Math.min(maxY, Math.max(-maxY, pan.y)),
  };
}

/** True once the picture is zoomed in far enough that a drag should move it, not change file. */
export function isZoomed(zoom: number) {
  return zoom > 1.01;
}

/**
 * What a finished one finger drag means. -1 is the previous file, 1 the next,
 * 0 stay. A zoomed picture never changes file: that drag was a pan. A mostly
 * up and down drag never changes file either. A drag that was part of a pinch
 * (`wasPinch`) never does.
 */
export function swipeDecision(args: {
  dx: number;
  dy: number;
  ms: number;
  zoom: number;
  width: number;
  wasPinch?: boolean;
}) {
  const { dx, dy, ms, zoom, width, wasPinch } = args;
  if (wasPinch || isZoomed(zoom)) return 0;
  if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy) * 1.2) return 0;
  const far = Math.abs(dx) > Math.max(60, width * 0.18);
  const quick = ms > 0 && Math.abs(dx) / ms > 0.5;
  if (!far && !quick) return 0;
  // Finger moving left brings the next file in from the right.
  return dx < 0 ? 1 : -1;
}

/** The files either side of this one, the only ones worth fetching ahead. */
export function neighbours(index: number, count: number) {
  return [index - 1, index + 1].filter((i) => i >= 0 && i < count);
}

export type ViewerKind = "photo" | "video" | "pdf" | "other";

/** How a file is shown. A doc is only shown inline when it is a PDF. */
export function viewerKind(item: { kind: string; mime?: string | null; filename?: string | null }): ViewerKind {
  if (item.kind === "photo") return "photo";
  if (item.kind === "video") return "video";
  const mime = (item.mime ?? "").toLowerCase();
  const name = (item.filename ?? "").toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  return "other";
}

/** "3 of 12". */
export function counter(index: number, count: number) {
  return count === 0 ? "0 of 0" : `${index + 1} of ${count}`;
}
