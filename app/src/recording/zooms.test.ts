import { describe, expect, it } from "vitest";
import { parseEdits, serializeEdits, type RecordingEdits } from "./edits";
import {
  addZoom,
  clampCentre,
  cursorAt,
  DEFAULT_ZOOM_MS,
  FULL_VIEW,
  MIN_ZOOM_MS,
  moveZoom,
  parseZooms,
  removeZoom,
  resizeZoom,
  updateZoom,
  viewAt,
  viewRect,
  viewTransform,
  zoomStrength,
  type CursorPath,
  type Zoom,
} from "./zooms";

const area = (id: string, startMs: number, endMs: number, scale = 2, x = 0.5, y = 0.5): Zoom => ({ id, startMs, endMs, scale, focus: { kind: "area", x, y } });
const follow = (id: string, startMs: number, endMs: number, scale = 2): Zoom => ({ id, startMs, endMs, scale, focus: { kind: "cursor" } });
const close = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 9);

describe("zooms in the sidecar", () => {
  it("round-trips an area zoom and a follow-cursor zoom", () => {
    const edits: RecordingEdits = { version: 1, zooms: [area("z1", 2000, 4500, 2, 0.25, 0.75), follow("z2", 6000, 8000, 1.5)] };
    const written = JSON.parse(JSON.stringify(serializeEdits(edits)));
    expect(written).toEqual(edits);
    expect(parseEdits(written)).toEqual(edits);
  });

  it("writes no zooms when there are none", () => {
    expect(serializeEdits({ version: 1, zooms: [] })).toEqual({ version: 1 });
    expect(parseEdits({ version: 1, zooms: [] })).toEqual({ version: 1 });
  });

  it("drops zooms it cannot read, and any that overlap an earlier one", () => {
    const zooms = parseZooms([
      area("late", 6000, 7000),
      { id: "bad", startMs: 3000, endMs: 2000, scale: 2, focus: { kind: "cursor" } },
      { id: "nofocus", startMs: 0, endMs: 500, scale: 2 },
      { id: "odd", startMs: 0, endMs: 500, scale: 2, focus: { kind: "spiral" } },
      area("early", 1000, 3000),
      area("overlap", 2500, 4000),
      "zoom",
    ]);
    expect(zooms.map((zoom) => zoom.id)).toEqual(["early", "late"]);
    expect(parseZooms({ zooms: 1 })).toEqual([]);
  });

  it("keeps scales and areas in range", () => {
    const [zoom] = parseZooms([{ id: "z", startMs: 0, endMs: 1000, scale: 40, focus: { kind: "area", x: -1, y: 3 } }]);
    expect(zoom.scale).toBe(4);
    expect(zoom.focus).toEqual({ kind: "area", x: 0, y: 1 });
    const [given] = parseZooms([{ startMs: 0, endMs: 1000, scale: 1.3, focus: { kind: "cursor" } }]);
    expect(given.id).toMatch(/^z/);
    expect(given.scale).toBe(1.25);
  });
});

describe("editing zooms", () => {
  it("adds a zoom at the playhead, fitting the gap", () => {
    const added = addZoom([], 1000, 12_000, undefined, "a");
    expect(added?.zoom).toEqual(area("a", 1000, 1000 + DEFAULT_ZOOM_MS));
    // Shortened by the next zoom.
    expect(addZoom([area("b", 2000, 3000)], 1000, 12_000, undefined, "a")?.zoom).toMatchObject({ startMs: 1000, endMs: 2000 });
    // Moved back to stay long enough before the end.
    expect(addZoom([], 11_900, 12_000, undefined, "a")?.zoom).toMatchObject({ startMs: 12_000 - MIN_ZOOM_MS, endMs: 12_000 });
    // Kept sorted.
    expect(addZoom([area("b", 5000, 6000)], 1000, 12_000, undefined, "a")?.zooms.map((zoom) => zoom.id)).toEqual(["a", "b"]);
  });

  it("refuses to add inside a zoom or in too small a gap", () => {
    const zooms = [area("a", 1000, 3000), area("b", 3200, 5000)];
    expect(addZoom(zooms, 2000, 12_000)).toBeNull();
    expect(addZoom(zooms, 3100, 12_000)).toBeNull();
    expect(addZoom(zooms, 6000, 12_000)).not.toBeNull();
  });

  it("moves a zoom without changing its length or crossing a neighbour", () => {
    const zooms = [area("a", 1000, 3000), area("b", 5000, 6000)];
    expect(moveZoom(zooms, "a", 2000, 12_000)[0]).toMatchObject({ startMs: 2000, endMs: 4000 });
    expect(moveZoom(zooms, "a", 4000, 12_000)[0]).toMatchObject({ startMs: 3000, endMs: 5000 });
    expect(moveZoom(zooms, "a", -500, 12_000)[0]).toMatchObject({ startMs: 0, endMs: 2000 });
    expect(moveZoom(zooms, "b", 20_000, 12_000)[1]).toMatchObject({ startMs: 11_000, endMs: 12_000 });
    expect(moveZoom(zooms, "missing", 0, 12_000)).toBe(zooms);
  });

  it("resizes either edge, keeping the shortest zoom and clear of neighbours", () => {
    const zooms = [area("a", 1000, 3000), area("b", 5000, 6000)];
    expect(resizeZoom(zooms, "a", "start", 500, 12_000)[0]).toMatchObject({ startMs: 500, endMs: 3000 });
    expect(resizeZoom(zooms, "a", "start", 2900, 12_000)[0]).toMatchObject({ startMs: 3000 - MIN_ZOOM_MS });
    expect(resizeZoom(zooms, "a", "end", 9000, 12_000)[0]).toMatchObject({ endMs: 5000 });
    expect(resizeZoom(zooms, "b", "start", 2000, 12_000)[1]).toMatchObject({ startMs: 3000 });
    expect(resizeZoom(zooms, "b", "end", 99_000, 12_000)[1]).toMatchObject({ endMs: 12_000 });
  });

  it("changes a zoom's scale and focus, and deletes it", () => {
    const zooms = [area("a", 1000, 3000)];
    expect(updateZoom(zooms, "a", { scale: 3.1 })[0].scale).toBe(3);
    expect(updateZoom(zooms, "a", { scale: 9 })[0].scale).toBe(4);
    expect(updateZoom(zooms, "a", { focus: { kind: "cursor" } })[0].focus).toEqual({ kind: "cursor" });
    expect(removeZoom(zooms, "a")).toEqual([]);
  });
});

describe("the zoomed view", () => {
  it("eases in and out over three tenths of a second", () => {
    const zoom = area("a", 1000, 3000);
    expect(zoomStrength(zoom, 1000)).toBe(0);
    close(zoomStrength(zoom, 1150), 0.5);
    expect(zoomStrength(zoom, 1300)).toBe(1);
    expect(zoomStrength(zoom, 2000)).toBe(1);
    close(zoomStrength(zoom, 2850), 0.5);
    expect(zoomStrength(zoom, 3000)).toBe(0);
    // Smoothstep: slow at either end of the ramp. The same numbers as zoom.rs.
    close(zoomStrength(zoom, 1075), 0.15625);
    // A zoom shorter than both ramps eases half way each.
    expect(zoomStrength({ startMs: 0, endMs: 400 }, 200)).toBe(1);
    close(zoomStrength({ startMs: 0, endMs: 400 }, 100), 0.5);
  });

  it("scales up along the ease", () => {
    const zooms = [area("a", 1000, 3000, 4)];
    expect(viewAt(zooms, 500, null)).toEqual(FULL_VIEW);
    close(viewAt(zooms, 1150, null).scale, 2);
    close(viewAt(zooms, 2000, null).scale, 4);
    expect(viewAt(zooms, 3500, null)).toEqual(FULL_VIEW);
  });

  it("stays inside the frame", () => {
    expect(clampCentre([0, 1], 2)).toEqual([0.25, 0.75]);
    expect(clampCentre([0.4, 0.6], 2)).toEqual([0.4, 0.6]);
    expect(clampCentre([0, 0], 1)).toEqual([0.5, 0.5]);
    const zooms = [area("a", 0, 2000, 2, 0.95, 0.02)];
    expect(viewAt(zooms, 1000, null)).toEqual({ scale: 2, x: 0.75, y: 0.25 });
    for (let ms = 0; ms < 300; ms += 10) {
      const rect = viewRect(viewAt(zooms, ms, null));
      expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("finds the pointer between frames", () => {
    const path: CursorPath = { fps: 10, points: [[0, 0], [0.5, 1], [1, 1]] };
    expect(cursorAt(path, 0)).toEqual([0, 0]);
    expect(cursorAt(path, 50)).toEqual([0.25, 0.5]);
    expect(cursorAt(path, 150)).toEqual([0.75, 1]);
    expect(cursorAt(path, 9000)).toEqual([1, 1]);
    expect(cursorAt(path, -10)).toEqual([0, 0]);
    expect(cursorAt({ fps: 10, points: [] }, 0)).toBeNull();
    expect(cursorAt(null, 0)).toBeNull();
  });

  it("follows the pointer, held inside the frame", () => {
    const points: [number, number][] = [...Array<[number, number]>(6).fill([0.3, 0.4]), ...Array<[number, number]>(5).fill([1, 0])];
    const path: CursorPath = { fps: 10, points };
    const zooms = [follow("a", 0, 2000)];
    expect(viewAt(zooms, 400, path)).toEqual({ scale: 2, x: 0.3, y: 0.4 });
    expect(viewAt(zooms, 1000, path)).toEqual({ scale: 2, x: 0.75, y: 0.25 });
    // Without a pointer track, the centre of the frame.
    expect(viewAt(zooms, 1000, null)).toEqual({ scale: 2, x: 0.5, y: 0.5 });
  });

  it("shows the view by moving and scaling the video", () => {
    expect(viewTransform(FULL_VIEW)).toBe("none");
    // The right half, twice as large: shifted left by the whole video.
    expect(viewTransform({ scale: 2, x: 0.75, y: 0.5 })).toBe("translate(-100%, -50%) scale(2)");
  });
});
