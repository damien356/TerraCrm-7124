import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, ChevronLeft, ChevronRight, FileText, Minus, Plus, RefreshCw, X } from "lucide-react";
import {
  MAX_ZOOM,
  clampPan,
  clampZoom,
  counter,
  isZoomed,
  neighbours,
  stepIndex,
  swipeDecision,
  viewerKind,
} from "../lib/gallery";

export type ViewerItem = {
  id: number;
  kind: string;
  url: string;
  filename: string | null;
  caption: string | null;
  mime?: string | null;
  archivedAt?: Date | string | null;
};

type Gesture = {
  mode: "none" | "swipe" | "pan" | "pinch";
  startX: number;
  startY: number;
  startT: number;
  startPan: { x: number; y: number };
  startZoom: number;
  startDist: number;
  startMid: { x: number; y: number };
  wasPinch: boolean;
};

const idle = (): Gesture => ({
  mode: "none",
  startX: 0,
  startY: 0,
  startT: 0,
  startPan: { x: 0, y: 0 },
  startZoom: 1,
  startDist: 1,
  startMid: { x: 0, y: 0 },
  wasPinch: false,
});

const coarse = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

/**
 * Full screen viewer for one category of one job's files. Opens on the file
 * that was tapped and moves through the rest of that category in the order
 * the thumbnails show. It never reaches into another category or job: it only
 * knows the list it was handed.
 *
 * Photos: swipe or arrows to move, pinch, wheel with Ctrl, or the buttons to
 * zoom. While zoomed a drag moves the picture and never changes file.
 * PDFs keep their own page scrolling. Moving between files is the side
 * buttons and the arrow keys only, so paging through a plan never jumps file.
 */
export function FileViewer({
  items,
  openId,
  title,
  onClose,
  refresh,
}: {
  items: ViewerItem[];
  openId: number;
  title: string;
  onClose: () => void;
  /** Fetches fresh links for this category (signed links run out). */
  refresh: () => Promise<ViewerItem[] | undefined>;
}) {
  const [currentId, setCurrentId] = useState(openId);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragX, setDragX] = useState(0);
  const [loaded, setLoaded] = useState<Record<number, boolean>>({});
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const [attempt, setAttempt] = useState<Record<number, number>>({});
  const [retrying, setRetrying] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture>(idle());

  // A link is kept for as long as the viewer is open. A background refetch
  // re-signs every link, which would otherwise reload the picture on screen.
  const urls = useRef(new Map<number, string>());
  const preloaded = useRef(new Set<string>());
  for (const it of items) if (!urls.current.has(it.id)) urls.current.set(it.id, it.url);
  const urlOf = (it: ViewerItem) => urls.current.get(it.id) ?? it.url;

  const found = items.findIndex((i) => i.id === currentId);
  const index = found < 0 ? 0 : found;
  const item = items[index];

  // The file was archived or moved out of this category while open.
  useEffect(() => {
    if (items.length === 0) onClose();
    else if (found < 0) setCurrentId(items[Math.min(index, items.length - 1)]!.id);
  }, [found, index, items, onClose]);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setDragX(0);
  }, []);

  const go = useCallback(
    (delta: number) => {
      const next = stepIndex(index, delta, items.length);
      if (next === index) return;
      setCurrentId(items[next]!.id);
      resetView();
    },
    [index, items, resetView],
  );

  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => {
      const nz = clampZoom(z * factor);
      if (!isZoomed(nz)) setPan({ x: 0, y: 0 });
      return nz;
    });
  }, []);

  const bounds = () => {
    const s = stageRef.current;
    const im = imgRef.current;
    return {
      stage: { w: s?.clientWidth ?? 0, h: s?.clientHeight ?? 0 },
      shown: { w: im?.offsetWidth ?? 0, h: im?.offsetHeight ?? 0 },
    };
  };

  // Keyboard: arrows move, Escape closes, + and - zoom, 0 resets.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "+" || e.key === "=") {
        zoomBy(1.4);
      } else if (e.key === "-" || e.key === "_") {
        zoomBy(1 / 1.4);
      } else if (e.key === "0") {
        resetView();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, resetView, zoomBy]);

  // The page behind stays where it was. Focus goes back to the thumbnail
  // that opened the viewer without scrolling the page.
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = prev;
      // Safari does not focus a clicked button, so look the thumbnail up by id.
      const thumb = document.querySelector<HTMLElement>(`[data-media-id="${openId}"]`);
      (thumb ?? opener)?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch only the neighbours ahead, never the whole category.
  useEffect(() => {
    for (const i of neighbours(index, items.length)) {
      const n = items[i]!;
      const src = urlOf(n);
      if (viewerKind(n) === "photo" && !failed[n.id] && !preloaded.current.has(src)) {
        preloaded.current.add(src);
        const pre = new Image();
        pre.decoding = "async";
        pre.src = src;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items]);

  async function retry(id: number) {
    setRetrying(true);
    try {
      const fresh = await refresh();
      const again = fresh?.find((f) => f.id === id);
      if (again) urls.current.set(id, again.url);
    } catch {
      // The old link is tried again; the file shows the retry again if it fails.
    } finally {
      setFailed((f) => ({ ...f, [id]: false }));
      setLoaded((l) => ({ ...l, [id]: false }));
      setAttempt((a) => ({ ...a, [id]: (a[id] ?? 0) + 1 }));
      setRetrying(false);
    }
  }

  /* ------------------------------ touch and mouse ------------------------------ */

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length === 1) {
      g.mode = g.wasPinch ? (isZoomed(zoom) ? "pan" : "none") : isZoomed(zoom) ? "pan" : "swipe";
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.startT = performance.now();
      g.startPan = pan;
    } else if (pts.length === 2) {
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      g.mode = "pinch";
      g.wasPinch = true;
      g.startDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      g.startZoom = zoom;
      g.startPan = pan;
      g.startMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      setDragX(0);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (g.mode === "pinch" && pts.length >= 2) {
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const nz = clampZoom((g.startZoom * dist) / g.startDist);
      const { stage, shown } = bounds();
      setZoom(nz);
      setPan(clampPan({ x: g.startPan.x + mid.x - g.startMid.x, y: g.startPan.y + mid.y - g.startMid.y }, nz, shown, stage));
    } else if (g.mode === "pan") {
      const { stage, shown } = bounds();
      setPan(clampPan({ x: g.startPan.x + e.clientX - g.startX, y: g.startPan.y + e.clientY - g.startY }, zoom, shown, stage));
    } else if (g.mode === "swipe") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      setDragX(Math.abs(dx) > Math.abs(dy) ? dx : 0);
    }
  }

  function onPointerEnd(e: React.PointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    const left = pointers.current.size;
    if (left === 1 && g.mode === "pinch") {
      // One finger stays down after a pinch: it may pan, it may never swipe.
      const [p] = [...pointers.current.values()] as [{ x: number; y: number }];
      g.mode = isZoomed(zoom) ? "pan" : "none";
      g.startX = p.x;
      g.startY = p.y;
      g.startPan = pan;
      return;
    }
    if (left > 0) return;
    if (g.mode === "swipe") {
      const width = stageRef.current?.clientWidth ?? window.innerWidth;
      const d = swipeDecision({
        dx: e.clientX - g.startX,
        dy: e.clientY - g.startY,
        ms: performance.now() - g.startT,
        zoom,
        width,
        wasPinch: g.wasPinch,
      });
      setDragX(0);
      if (d !== 0) go(d);
    }
    if (!isZoomed(zoom)) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
    gesture.current = idle();
  }

  function onWheel(e: React.WheelEvent) {
    // A trackpad pinch arrives as a wheel with Ctrl held.
    if (!e.ctrlKey && !e.metaKey) return;
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  if (!item) return null;
  const kind = viewerKind(item);
  const url = urlOf(item);
  const label = item.caption || item.filename || "Untitled";
  const isFailed = !!failed[item.id];
  const isLoaded = !!loaded[item.id];
  const tries = attempt[item.id] ?? 0;
  const onTouch = coarse();

  const sideBtn =
    "absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/55 p-2.5 text-white transition hover:bg-black/75 disabled:pointer-events-none disabled:opacity-0";

  return createPortal(
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      aria-label={`${title}, ${counter(index, items.length)}`}
      tabIndex={-1}
      data-slot="file-viewer"
      className="fixed inset-0 z-[60] m-0 flex h-full max-h-none w-full max-w-none flex-col border-0 bg-[#111] p-0 text-white outline-none"
    >
      {/* ------------------------------ header ------------------------------ */}
      <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {title} <span data-testid="viewer-counter" className="ml-1.5 font-normal tabular-nums text-white/70">{counter(index, items.length)}</span>
          </p>
          <p className="truncate text-xs text-white/60">
            {label}
            {item.archivedAt ? " · Archived" : ""}
          </p>
        </div>
        {kind === "photo" && !isFailed ? (
          <div className="flex items-center gap-0.5 sm:gap-1">
            <button type="button" aria-label="Zoom out" className="rounded-md p-1.5 hover:bg-white/10 disabled:opacity-40" disabled={!isZoomed(zoom)} onClick={() => zoomBy(1 / 1.4)}>
              <Minus className="size-4" />
            </button>
            <button type="button" aria-label="Reset zoom" className="w-12 rounded-md py-1 text-xs tabular-nums hover:bg-white/10" onClick={resetView}>
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" aria-label="Zoom in" className="rounded-md p-1.5 hover:bg-white/10 disabled:opacity-40" disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(1.4)}>
              <Plus className="size-4" />
            </button>
          </div>
        ) : null}
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs hover:bg-white/10">
          Open <ArrowUpRight className="size-3.5" />
        </a>
        <button type="button" aria-label="Close" className="rounded-md p-1.5 hover:bg-white/10" onClick={onClose}>
          <X className="size-5" />
        </button>
      </div>

      {/* ------------------------------ stage ------------------------------ */}
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden">
        <button type="button" aria-label="Previous file" className={`${sideBtn} left-2 sm:left-4`} disabled={index === 0} onClick={() => go(-1)}>
          <ChevronLeft className="size-5" />
        </button>
        <button type="button" aria-label="Next file" className={`${sideBtn} right-2 sm:right-4`} disabled={index >= items.length - 1} onClick={() => go(1)}>
          <ChevronRight className="size-5" />
        </button>

        {kind === "photo" ? (
          <div
            data-testid="viewer-photo-stage"
            className="flex size-full select-none items-center justify-center"
            style={{ touchAction: "none", cursor: isZoomed(zoom) ? "grab" : "default" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onWheel={onWheel}
            onDoubleClick={() => (isZoomed(zoom) ? resetView() : setZoom(2.5))}
          >
            {isFailed ? (
              <Failed onRetry={() => void retry(item.id)} retrying={retrying} url={url} />
            ) : (
              <>
                {!isLoaded ? <div className="absolute size-8 animate-spin rounded-full border-2 border-white/25 border-t-white" /> : null}
                <img
                  key={`${item.id}-${tries}`}
                  ref={imgRef}
                  src={url}
                  alt={label}
                  draggable={false}
                  decoding="async"
                  data-zoom={zoom.toFixed(2)}
                  onLoad={() => setLoaded((l) => ({ ...l, [item.id]: true }))}
                  onError={() => setFailed((f) => ({ ...f, [item.id]: true }))}
                  className="max-h-full max-w-full object-contain"
                  style={{
                    transform: `translate(${pan.x + dragX}px, ${pan.y}px) scale(${zoom})`,
                    transition: gesture.current.mode === "none" ? "transform 120ms ease-out" : "none",
                    opacity: isLoaded ? 1 : 0,
                  }}
                />
              </>
            )}
          </div>
        ) : kind === "video" ? (
          <div className="flex size-full items-center justify-center px-14">
            {isFailed ? (
              <Failed onRetry={() => void retry(item.id)} retrying={retrying} url={url} />
            ) : (
              <video
                key={`${item.id}-${tries}`}
                src={url}
                controls
                playsInline
                preload="metadata"
                aria-label={label}
                onError={() => setFailed((f) => ({ ...f, [item.id]: true }))}
                className="max-h-full max-w-full"
              >
                <track kind="captions" />
              </video>
            )}
          </div>
        ) : kind === "pdf" && !onTouch ? (
          <div className="size-full px-14 pb-3">
            {/* The browser's own PDF viewer pages through the plan. */}
            <iframe key={`${item.id}-${tries}`} src={url} title={label} className="size-full rounded-md bg-white" />
          </div>
        ) : (
          <NoPreview url={url} label={label} pdf={kind === "pdf"} />
        )}
      </div>
    </dialog>,
    document.body,
  );
}

function Failed({ onRetry, retrying, url }: { onRetry: () => void; retrying: boolean; url: string }) {
  return (
    <div data-testid="viewer-failed" className="flex max-w-xs flex-col items-center gap-3 px-6 text-center">
      <p className="text-sm">This file didn't load.</p>
      <p className="text-xs text-white/60">Check the connection and try again. You can still move to the other files.</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-60"
        >
          <RefreshCw className={`size-3.5 ${retrying ? "animate-spin" : ""}`} /> Try again
        </button>
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-white/30 px-3 py-1.5 text-xs">
          Open <ArrowUpRight className="size-3.5" />
        </a>
      </div>
    </div>
  );
}

function NoPreview({ url, label, pdf }: { url: string; label: string; pdf: boolean }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 px-16 text-center">
      <FileText className="size-12 text-white/60" />
      <p className="max-w-xs truncate text-sm">{label}</p>
      <p className="text-xs text-white/60">{pdf ? "Open the PDF to read every page." : "No preview for this file type."}</p>
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-black">
        {pdf ? "Open PDF" : "Open or download"} <ArrowUpRight className="size-3.5" />
      </a>
    </div>
  );
}
