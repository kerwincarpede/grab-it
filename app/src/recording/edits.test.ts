import { describe, expect, it } from "vitest";
import { clampTrim, EditsError, formatTime, isWhole, MIN_CLIP_MS, parseEdits, serializeEdits, trimOf, type RecordingEdits } from "./edits";

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

  it("refuses a version it does not know, so it is never overwritten", () => {
    expect(() => parseEdits({ version: 2 })).toThrow(EditsError);
    expect(() => parseEdits("edits")).toThrow(EditsError);
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
