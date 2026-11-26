import { describe, expect, it } from "vitest";
import {
  canRemove,
  canSplit,
  clipsOf,
  duplicateClip,
  gapOf,
  leaveGap,
  mergeGaps,
  movedIndex,
  splitClip,
  clipStarts,
  fitInside,
  insertClip,
  moveClip,
  parseClips,
  removeClip,
  sequenceDuration,
  tagZoom,
  toSequence,
  toSource,
  trimClip,
  withClips,
  zoomsIn,
  type Clip,
} from "./clips";
import { EDITS_VERSION, parseEdits, serializeEdits } from "./edits";
import type { Zoom } from "./zooms";

const OWN = "own.mp4";
const A: Clip = { id: "a", source: OWN, startMs: 1000, endMs: 5000 };
const B: Clip = { id: "b", source: "other.mp4", startMs: 0, endMs: 2000 };
const C: Clip = { id: "c", source: "third.mp4", startMs: 500, endMs: 1500 };
const zoom = (id: string, startMs: number, endMs: number, source?: string): Zoom => ({
  id,
  ...(source ? { source } : {}),
  startMs,
  endMs,
  scale: 2,
  focus: { kind: "cursor" },
});

describe("clips", () => {
  it("reads clips, dropping entries it cannot use", () => {
    expect(
      parseClips([
        A,
        { ...B, startMs: 3000 },
        { ...C, source: "../c.mp4" },
        { ...C, id: "a" },
        C,
        "clip",
      ]),
    ).toEqual([A, C]);
    expect(parseClips(undefined)).toEqual([]);
  });

  it("gives a sidecar without clips one clip of its own recording, cut by its trim", () => {
    expect(clipsOf({ version: 1 }, OWN, 8000)).toEqual([{ id: "own", source: OWN, startMs: 0, endMs: 8000 }]);
    expect(clipsOf({ version: 1, trim: { startMs: 1000, endMs: 5000 } }, OWN, 8000)).toEqual([{ id: "own", source: OWN, startMs: 1000, endMs: 5000 }]);
    expect(clipsOf({ version: 2, clips: [B, A] }, OWN, 8000)).toEqual([B, A]);
  });

  it("writes one clip of its own recording as a version 1 trim, anything else as version 2", () => {
    expect(withClips({ version: 2, clips: [A, B] }, [A], OWN, 8000)).toEqual({ version: 1, trim: { startMs: 1000, endMs: 5000 } });
    expect(withClips({ version: 1, trim: { startMs: 1, endMs: 2 } }, [{ ...A, startMs: 0, endMs: 8000 }], OWN, 8000)).toEqual({ version: 1 });
    expect(withClips({ version: 1, trim: { startMs: 1000, endMs: 5000 } }, [A, B], OWN, 8000)).toEqual({ version: 2, clips: [A, B] });
    // A single clip of another recording still needs the list.
    expect(withClips({ version: 1 }, [B], OWN, 8000)).toEqual({ version: 2, clips: [B] });
  });

  it("round-trips a version 2 sidecar with source-tagged zooms", () => {
    const edits = { version: 2 as const, clips: [A, B], zooms: [zoom("z1", 1500, 2500), zoom("z2", 1500, 2500, "other.mp4")] };
    const written = JSON.parse(JSON.stringify(serializeEdits(edits)));
    expect(written).toEqual(edits);
    expect(parseEdits(written)).toEqual(edits);
    // Zooms on different recordings may share times; on one they may not.
    expect(parseEdits({ version: 1, zooms: [zoom("z1", 0, 1000), zoom("z2", 500, 1500)] }).zooms).toEqual([zoom("z1", 0, 1000)]);
  });

  it("maps sequence time to each clip's recording and back", () => {
    const clips = [A, B, C];
    expect(clipStarts(clips)).toEqual([0, 4000, 6000]);
    expect(sequenceDuration(clips)).toBe(7000);
    expect(toSource(clips, 0)).toEqual({ index: 0, clip: A, sourceMs: 1000 });
    expect(toSource(clips, 3999)).toEqual({ index: 0, clip: A, sourceMs: 4999 });
    // The line between two clips belongs to the later one.
    expect(toSource(clips, 4000)).toEqual({ index: 1, clip: B, sourceMs: 0 });
    expect(toSource(clips, 6500)).toEqual({ index: 2, clip: C, sourceMs: 1000 });
    expect(toSource(clips, 99_000)).toEqual({ index: 2, clip: C, sourceMs: 1500 });
    expect(toSource([], 0)).toBeNull();
    expect(toSequence(clips, 2, 1000)).toBe(6500);
    expect(toSequence(clips, 0, 0)).toBe(0);
    expect(toSequence(clips, 1, 5000)).toBe(6000);
  });

  it("shows each clip only the zooms on its recording that reach into its stretch", () => {
    const zooms = [zoom("own", 2000, 3000), zoom("outside", 6000, 7000), zoom("other", 500, 1500, "other.mp4")];
    expect(zoomsIn(zooms, A, OWN).map((each) => each.id)).toEqual(["own"]);
    expect(zoomsIn(zooms, B, OWN).map((each) => each.id)).toEqual(["other"]);
    expect(zoomsIn(zooms, C, OWN)).toEqual([]);
    expect(tagZoom(zoom("z", 0, 1), "other.mp4", OWN).source).toBe("other.mp4");
    expect("source" in tagZoom(zoom("z", 0, 1, "other.mp4"), OWN, OWN)).toBe(false);
  });

  it("adds, moves and removes clips, never the last one", () => {
    expect(insertClip([A, C], 0, B)).toEqual([A, B, C]);
    expect(insertClip([A], -1, B)).toEqual([B, A]);
    expect(moveClip([A, B, C], "a", 2)).toEqual([B, C, A]);
    expect(moveClip([A, B, C], "c", 0)).toEqual([C, A, B]);
    expect(moveClip([A, B], "b", 9)).toEqual([A, B]);
    expect(removeClip([A, B], "a")).toEqual([B]);
    expect(removeClip([A], "a")).toEqual([A]);
  });

  it("splits a clip at the playhead into two that meet there, each long enough", () => {
    expect(splitClip([A, B], 0, 3000, "a2")).toEqual([{ ...A, endMs: 3000 }, { ...A, id: "a2", startMs: 3000 }, B]);
    // Each part keeps at least half a second.
    expect(canSplit([A], 0, 1499)).toBe(false);
    expect(canSplit([A], 0, 1500)).toBe(true);
    expect(canSplit([A], 0, 4501)).toBe(false);
    expect(splitClip([A], 0, 4800, "a2")).toEqual([A]);
    expect(canSplit([gapOf("g", 4000)], 0, 2000)).toBe(false);
  });

  it("duplicates a clip right after itself under a new id, never a gap", () => {
    expect(duplicateClip([A, B], "a", "a2")).toEqual([A, { ...A, id: "a2" }, B]);
    const gap = gapOf("g", 1000);
    expect(duplicateClip([A, gap], "g", "g2")).toEqual([A, gap]);
  });

  it("leaves a gap the length of a deleted clip, merging it with neighbouring gaps", () => {
    expect(leaveGap([A, B, C], "b", "g")).toEqual([A, gapOf("g", 2000), C]);
    expect(leaveGap([A, gapOf("g", 1000), B], "b", "x")).toEqual([A, gapOf("g", 3000)]);
    // Never the last clip that plays a recording.
    expect(leaveGap([A, gapOf("g", 1000)], "a", "x")).toEqual([A, gapOf("g", 1000)]);
    expect(canRemove([A, gapOf("g", 1000)], "a")).toBe(false);
    expect(canRemove([A, gapOf("g", 1000)], "g")).toBe(true);
  });

  it("closes a gap or a clip with a ripple delete, merging the gaps it leaves side by side", () => {
    expect(removeClip([A, gapOf("g", 1000), B], "g")).toEqual([A, B]);
    expect(removeClip([gapOf("g", 1000), A, gapOf("h", 500), B], "a")).toEqual([gapOf("g", 1500), B]);
    expect(mergeGaps([A, B])).toEqual([A, B]);
  });

  it("merges a gap moved next to another, and finds where it went", () => {
    const g1 = gapOf("g1", 1000);
    const g2 = gapOf("g2", 500);
    const next = moveClip([A, g1, B, g2, C], "g2", 2);
    expect(next).toEqual([A, gapOf("g1", 1500), B, C]);
    expect(movedIndex(next, "g2", 2)).toBe(1);
    // Moved up against a gap after it, it keeps its own id.
    const after = moveClip([A, g1, B, g2, C], "g1", 2);
    expect(after).toEqual([A, B, gapOf("g1", 1500), C]);
    expect(movedIndex(after, "g1", 2)).toBe(2);
  });

  it("keeps a gap's time in the sequence", () => {
    const clips = [A, gapOf("g", 1500), B];
    expect(sequenceDuration(clips)).toBe(7500);
    expect(clipStarts(clips)).toEqual([0, 4000, 5500]);
    expect(toSource(clips, 4500)?.index).toBe(1);
    expect(toSource(clips, 5500)).toEqual({ index: 2, clip: B, sourceMs: 0 });
    expect(zoomsIn([zoom("z", 0, 99_000)], clips[1], OWN)).toEqual([]);
  });

  it("writes and reads gaps as version 3, and a sequence without them as before", () => {
    const gapped = withClips({ version: 1 }, [A, gapOf("g", 1500), B], OWN, 8000);
    expect(gapped.version).toBe(3);
    const written = JSON.parse(JSON.stringify(serializeEdits(gapped)));
    expect(written).toEqual({ version: 3, clips: [A, { id: "g", gapMs: 1500 }, B] });
    expect(parseEdits(written)).toEqual(gapped);
    // Closing the gap writes version 2 again, and one clip version 1.
    expect(serializeEdits(withClips(gapped, [A, B], OWN, 8000)).version).toBe(2);
    expect(serializeEdits(withClips(gapped, [A], OWN, 8000)).version).toBe(1);
    // A gap needs version 3; gaps alone hold nothing to play.
    expect(parseClips([A, { id: "g", gapMs: 1500 }])).toEqual([A]);
    expect(parseClips([{ id: "g", gapMs: 1500 }], 3)).toEqual([]);
    expect(parseClips([A, { id: "g", gapMs: 0 }, { id: "h", gapMs: 500 }, { id: "i", gapMs: 500 }], 3)).toEqual([A, gapOf("h", 1000)]);
    expect(parseEdits({ version: 3, clips: [A, B] }).version).toBe(2);
    expect(() => parseEdits({ version: EDITS_VERSION + 1 })).toThrow();
  });

  it("trims a clip within its recording, keeping it long enough", () => {
    expect(trimClip([A, B], "b", "start", 1200, 2000)).toEqual([A, { ...B, startMs: 1200 }]);
    expect(trimClip([B], "b", "start", 1900, 2000)).toEqual([{ ...B, startMs: 1500 }]);
    expect(trimClip([B], "b", "end", 9000, 3000)).toEqual([{ ...B, endMs: 3000 }]);
    expect(trimClip([B], "b", "end", 100, 3000)).toEqual([{ ...B, endMs: 500 }]);
  });

  it("fits a recording inside the video box, centred, with even sides", () => {
    expect(fitInside(1920, 1080, 960, 540)).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    expect(fitInside(1280, 1024, 960, 540)).toEqual({ x: 142, y: 0, width: 676, height: 540 });
    expect(fitInside(1080, 1920, 1920, 1080)).toEqual({ x: 656, y: 0, width: 608, height: 1080 });
  });
});
