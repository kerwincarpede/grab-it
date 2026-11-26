import { describe, expect, it } from "vitest";
import { clampTrim, EDITS_VERSION, EditsError, formatTime, isWhole, MIN_CLIP_MS, parseEdits, serializeEdits, trimOf, type RecordingEdits } from "./edits";

const BACKDROP = { fill: "sunset", padding: 48, radius: 24, radiusUnit: "pt" as const, shadow: true, aspect: "9:16" as const };

describe("recording edits sidecar", () => {
  it("reads no sidecar as no edits", () => {
    expect(parseEdits(null)).toEqual({ version: 1 });
    expect(parseEdits(undefined)).toEqual({ version: 1 });
  });

  it("round-trips a trim and a 9:16 backdrop", () => {
    const edits: RecordingEdits = { version: 1, trim: { startMs: 1250, endMs: 9500 }, backdrop: BACKDROP };
    const written = JSON.parse(JSON.stringify(serializeEdits(edits)));
    expect(written).toEqual(edits);
    expect(parseEdits(written)).toEqual(edits);
  });

  it("writes only what is set", () => {
    expect(serializeEdits({ version: 1, trim: null, backdrop: null })).toEqual({ version: 1 });
    expect(serializeEdits({ version: 1, trim: { startMs: 10.4, endMs: 2000.6 } })).toEqual({ version: 1, trim: { startMs: 10, endMs: 2001 } });
  });

  it("round-trips month references on clips and zooms as version 4", () => {
    const source = "2026-11/2026-11-24 14-32-08 – Firefox.mp4";
    const zoom = { id: "z", source, startMs: 500, endMs: 1000, scale: 2, focus: { kind: "cursor" as const } };
    const clip = { id: "c", source, startMs: 0, endMs: 2000 };
    const sidecar = serializeEdits({ version: 2, clips: [clip], zooms: [zoom] });
    expect(sidecar).toEqual({ version: 4, clips: [clip], zooms: [zoom] });
    expect(parseEdits(sidecar)).toEqual(sidecar);
    expect(serializeEdits({ version: 1, zooms: [zoom] })).toEqual({ version: 4, zooms: [zoom] });
    expect(parseEdits({ ...sidecar, version: 3 })).toEqual({ version: 1 });
  });

  it("skips invalid month paths in a version 4 sidecar", () => {
    const entries = [
      { id: "flat", source: "legacy.mp4", startMs: 0, endMs: 1000 },
      { id: "bad-month", source: "2026-13/file.mp4", startMs: 0, endMs: 1000 },
      { id: "bad-depth", source: "2026-11/nested/file.mp4", startMs: 0, endMs: 1000 },
    ];
    expect(parseEdits({ version: 4, clips: entries })).toEqual({ version: 2, clips: [entries[0]] });
  });

  it("refuses a version it does not know, so it is never overwritten", () => {
    expect(() => parseEdits({ version: EDITS_VERSION + 1 })).toThrow(EditsError);
    expect(() => parseEdits("edits")).toThrow(EditsError);
  });

  it("round-trips noise removal either way, and leaves it out until it is set", () => {
    for (const removeNoise of [true, false]) {
      const written = JSON.parse(JSON.stringify(serializeEdits({ version: 1, removeNoise })));
      expect(written).toEqual({ version: 1, removeNoise });
      expect(parseEdits(written)).toEqual({ version: 1, removeNoise });
    }
    expect(serializeEdits({ version: 1 })).not.toHaveProperty("removeNoise");
    expect(parseEdits({ version: 1, removeNoise: "yes" })).toEqual({ version: 1 });
  });

  it("drops a trim or backdrop it cannot read, keeping the rest", () => {
    expect(parseEdits({ version: 1, trim: { startMs: 5000, endMs: 100 }, backdrop: BACKDROP })).toEqual({ version: 1, backdrop: BACKDROP });
    expect(parseEdits({ version: 1, trim: { startMs: 0, endMs: 900 }, backdrop: { fill: 3 } })).toEqual({ version: 1, trim: { startMs: 0, endMs: 900 } });
  });
});

describe("trimming", () => {
  it("keeps the trim inside the recording", () => {
    expect(clampTrim({ startMs: -400, endMs: 99_000 }, 12_000)).toEqual({ startMs: 0, endMs: 12_000 });
    expect(clampTrim({ startMs: 2000, endMs: 8000 }, 12_000)).toEqual({ startMs: 2000, endMs: 8000 });
  });

  it("never trims shorter than the shortest clip", () => {
    expect(clampTrim({ startMs: 3000, endMs: 3100 }, 12_000)).toEqual({ startMs: 3000, endMs: 3000 + MIN_CLIP_MS });
    // At the very end, the start gives way.
    expect(clampTrim({ startMs: 11_900, endMs: 12_000 }, 12_000)).toEqual({ startMs: 12_000 - MIN_CLIP_MS, endMs: 12_000 });
    // A recording shorter than that is kept whole.
    expect(clampTrim({ startMs: 100, endMs: 200 }, 300)).toEqual({ startMs: 0, endMs: 300 });
  });

  it("plays the whole recording until it is trimmed", () => {
    expect(trimOf({ version: 1 }, 12_000)).toEqual({ startMs: 0, endMs: 12_000 });
    expect(trimOf({ version: 1, trim: { startMs: 1000, endMs: 60_000 } }, 12_000)).toEqual({ startMs: 1000, endMs: 12_000 });
    expect(isWhole({ startMs: 0, endMs: 12_000 }, 12_000)).toBe(true);
    expect(isWhole({ startMs: 0, endMs: 11_000 }, 12_000)).toBe(false);
  });

  it("shows times to the tenth of a second", () => {
    expect(formatTime(0)).toBe("0:00.0");
    expect(formatTime(8250)).toBe("0:08.2");
    expect(formatTime(75_960)).toBe("1:15.9");
  });
});
