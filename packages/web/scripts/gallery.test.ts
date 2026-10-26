import { describe, expect, test } from "bun:test";
import { clampPan, clampZoom, counter, neighbours, stepIndex, swipeDecision, viewerKind } from "../src/web/lib/gallery";

describe("Job file viewer rules", () => {
  test("moving holds at both ends of a category of 12", () => {
    expect(stepIndex(5, 1, 12)).toBe(6);
    expect(stepIndex(5, -1, 12)).toBe(4);
    expect(stepIndex(11, 1, 12)).toBe(11);
    expect(stepIndex(0, -1, 12)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });

  test("counter reads like the thumbnails", () => {
    expect(counter(2, 12)).toBe("3 of 12");
    expect(counter(0, 0)).toBe("0 of 0");
  });

  test("only the two neighbours are fetched ahead", () => {
    expect(neighbours(5, 12)).toEqual([4, 6]);
    expect(neighbours(0, 12)).toEqual([1]);
    expect(neighbours(11, 12)).toEqual([10]);
    expect(neighbours(0, 1)).toEqual([]);
  });

  test("zoom stays between 1x and 5x", () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(9)).toBe(5);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
  });

  test("a zoomed picture cannot be dragged past its edge", () => {
    const shown = { w: 800, h: 600 };
    const stage = { w: 800, h: 700 };
    expect(clampPan({ x: 5000, y: -5000 }, 2, shown, stage)).toEqual({ x: 400, y: -250 });
    // Not zoomed: no drag at all.
    expect(clampPan({ x: 50, y: 50 }, 1, shown, stage)).toEqual({ x: 0, y: 0 });
  });

  test("a long left drag goes to the next file, right to the previous", () => {
    expect(swipeDecision({ dx: -200, dy: 10, ms: 400, zoom: 1, width: 400 })).toBe(1);
    expect(swipeDecision({ dx: 200, dy: 10, ms: 400, zoom: 1, width: 400 })).toBe(-1);
  });

  test("a quick flick counts even when short", () => {
    expect(swipeDecision({ dx: -45, dy: 0, ms: 60, zoom: 1, width: 1200 })).toBe(1);
  });

  test("a zoomed drag never changes file, however far", () => {
    expect(swipeDecision({ dx: -900, dy: 0, ms: 50, zoom: 2, width: 400 })).toBe(0);
    expect(swipeDecision({ dx: 900, dy: 0, ms: 50, zoom: 1.5, width: 400 })).toBe(0);
  });

  test("a drag that was part of a pinch never changes file", () => {
    expect(swipeDecision({ dx: -300, dy: 0, ms: 200, zoom: 1, width: 400, wasPinch: true })).toBe(0);
  });

  test("a mostly vertical or tiny drag stays put", () => {
    expect(swipeDecision({ dx: -80, dy: 200, ms: 300, zoom: 1, width: 400 })).toBe(0);
    expect(swipeDecision({ dx: -20, dy: 0, ms: 30, zoom: 1, width: 400 })).toBe(0);
    expect(swipeDecision({ dx: -50, dy: 0, ms: 2000, zoom: 1, width: 1200 })).toBe(0);
  });

  test("files are shown by type, PDFs by mime or name", () => {
    expect(viewerKind({ kind: "photo" })).toBe("photo");
    expect(viewerKind({ kind: "video" })).toBe("video");
    expect(viewerKind({ kind: "doc", mime: "application/pdf" })).toBe("pdf");
    expect(viewerKind({ kind: "doc", mime: null, filename: "Plan.PDF" })).toBe("pdf");
    expect(viewerKind({ kind: "doc", mime: "application/msword", filename: "x.doc" })).toBe("other");
  });
});
