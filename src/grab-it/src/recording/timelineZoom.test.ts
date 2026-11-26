import { describe, expect, it } from "vitest";
import { clampZoom, followScroll, MAX_PX_PER_SECOND, maxScroll, maxZoom, msAtOffset, scaleFor, scrollToKeep, stepScale, stepZoom, trackInView, visibleRange, zoomFor, type TimelineScale } from "./timelineZoom";

describe("timelineZoom", () => {
  it("zooms from 1x up to 400 px a second", () => {
    // 10 s over 1000 px: 100 px a second at 1x, so 4x at most.
    expect(maxZoom(10_000, 1000)).toBe(4);
    // A short timeline fits and cannot zoom.
    expect(maxZoom(1000, 1000)).toBe(1);
    expect(maxZoom(0, 1000)).toBe(1);
    expect(maxZoom(10_000, 0)).toBe(1);
  });

  it("doubles or halves per step, within the limits", () => {
    expect(stepZoom(1, 1, 10_000, 1000)).toBe(2);
    expect(stepZoom(2, 1, 10_000, 1000)).toBe(4);
    expect(stepZoom(4, 1, 10_000, 1000)).toBe(4);
    expect(stepZoom(3, 1, 10_000, 1000)).toBe(4);
    expect(stepZoom(2, -1, 10_000, 1000)).toBe(1);
    expect(stepZoom(1, -1, 10_000, 1000)).toBe(1);
    expect(clampZoom(Number.NaN, 10_000, 1000)).toBe(1);
    expect(clampZoom(0.2, 10_000, 1000)).toBe(1);
  });

  it("keeps a chosen scale in pixels a second, showing it clamped", () => {
    // 10 s over 1000 px fits at 100 px a second.
    expect(zoomFor(null, 10_000, 1000)).toBe(1);
    expect(zoomFor(200, 10_000, 1000)).toBe(2);
    // Shorter than fits shows at 1x; past 400 px a second shows the limit.
    expect(zoomFor(200, 4000, 1000)).toBe(1);
    expect(zoomFor(800, 10_000, 1000)).toBe(4);
    expect(scaleFor(2, 10_000, 1000)).toBe(200);
    expect(scaleFor(1, 10_000, 1000)).toBeNull();
    expect(stepScale(null, 1, 10_000, 1000)).toBe(200);
    expect(stepScale(200, -1, 10_000, 1000)).toBeNull();
    expect(stepScale(400, 1, 10_000, 1000)).toBe(400);
  });

  it("shows a scale stepped to the limit exactly at the limit, however the length changes", () => {
    // 30 s over 776 px stepped to 400 px a second, then lengthened to 32.7 s.
    let scale: TimelineScale = null;
    for (let i = 0; i < 6; i++) scale = stepScale(scale, 1, 30_000, 776);
    expect(scale).toBe(MAX_PX_PER_SECOND);
    expect(zoomFor(scale, 32_700, 776)).toBe(maxZoom(32_700, 776));
    expect(stepScale(scale, 1, 32_700, 776)).toBe(MAX_PX_PER_SECOND);
    // And across widths, lengths and lengthenings.
    for (const width of [101, 333, 776, 1234, 1999]) {
      for (const durationMs of [3_000, 7_700, 30_000, 61_234]) {
        let at: TimelineScale = null;
        for (let i = 0; i < 12; i++) at = stepScale(at, 1, durationMs, width);
        for (const longer of [1, 1.09, 1.37, 2.5]) {
          const length = Math.round(durationMs * longer);
          if (at !== null) expect(zoomFor(at, length, width)).toBe(maxZoom(length, width));
        }
      }
    }
  });

  it("keeps a time at the same place in view after zooming", () => {
    // At 2x the track is 2000 px; 5 s sits at 1000 px, 300 px into the view.
    expect(scrollToKeep(5000, 300, 2, 10_000, 1000)).toBe(700);
    expect(msAtOffset(300, 700, 2, 10_000, 1000)).toBe(5000);
    // Never past either end.
    expect(scrollToKeep(0, 300, 2, 10_000, 1000)).toBe(0);
    expect(scrollToKeep(10_000, 0, 2, 10_000, 1000)).toBe(maxScroll(2, 1000));
    expect(maxScroll(1, 1000)).toBe(0);
  });

  it("reports the stretch in view", () => {
    expect(visibleRange(0, 1, 10_000, 1000)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(visibleRange(1000, 4, 10_000, 1000)).toEqual({ startMs: 2500, endMs: 5000 });
  });

  it("reports the track the scroller shows, its padding's share included", () => {
    // A 1024 px scroller, 12 px of padding each side of a 1000 px track.
    // Fitted, the track is all there is.
    expect(trackInView(0, 1024, 12, 1, 10_000, 1000)).toEqual({ startMs: 0, endMs: 10_000, width: 1000 });
    // At 4x, unscrolled, the right padding shows track too.
    expect(trackInView(0, 1024, 12, 4, 10_000, 1000)).toEqual({ startMs: 0, endMs: 2530, width: 1012 });
    // Scrolled mid-way, both paddings do: the whole scroller is track.
    expect(trackInView(1000, 1024, 12, 4, 10_000, 1000)).toEqual({ startMs: 2470, endMs: 5030, width: 1024 });
    // At the end, the left padding does.
    expect(trackInView(3000, 1024, 12, 4, 10_000, 1000)).toEqual({ startMs: 7470, endMs: 10_000, width: 1012 });
    // Held past the end, it narrows to nothing.
    expect(trackInView(3500, 1024, 12, 4, 10_000, 1000)).toEqual({ startMs: 8720, endMs: 10_000, width: 512 });
    expect(trackInView(5000, 1024, 12, 4, 10_000, 1000)).toEqual({ startMs: 10_000, endMs: 10_000, width: 0 });
    expect(trackInView(0, 1024, 12, 1, 0, 1000)).toEqual({ startMs: 0, endMs: 0, width: 0 });
  });

  it("pages the view on to keep a playing playhead in view", () => {
    // 4x over 1000 px: 400 px a second; the view shows 0 to 2.5 s.
    expect(followScroll(1000, 0, 4, 10_000, 1000)).toBe(0);
    // Near the right edge, the playhead goes back near the left.
    expect(followScroll(2400, 0, 4, 10_000, 1000)).toBe(2400 * 0.4 - 100);
    // Out of view to the left, as after a jump back.
    expect(followScroll(500, 2000, 4, 10_000, 1000)).toBe(100);
    // Fitted, nothing scrolls.
    expect(followScroll(9000, 0, 1, 10_000, 1000)).toBe(0);
  });
});
