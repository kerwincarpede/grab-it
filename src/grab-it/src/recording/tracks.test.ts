import { describe, expect, it } from "vitest";
import type { Clip } from "./clips";
import { parseEdits, serializeEdits, type RecordingEdits } from "./edits";
import {
  addTrack,
  cutSpan,
  flattenPicture,
  hasOverlay,
  isLockedClip,
  placeRecording,
  removeTrack,
  defaultTimeline,
  exportAudio,
  FIRST_AUDIO_ID,
  isRefusal,
  linkClips,
  lockTrack,
  MAIN_TRACK_ID,
  moveInTime,
  needsTracks,
  parseTracks,
  reconcile,
  serializeTracks,
  shiftUnlinked,
  renameTrack,
  rippleDelete,
  snapClip,
  snapMs,
  canSplitAt,
  snapTargets,
  splitAt,
  timelineOf,
  unlinkClips,
  withTimeline,
  TRACKS_VERSION,
  type Refusal,
  type Timeline,
  type Track,
} from "./tracks";

const sound = () => true;
const a: Clip = { id: "a", source: "a.mp4", startMs: 0, endMs: 4000 };
const b: Clip = { id: "b", source: "b.mp4", startMs: 1000, endMs: 3000 };
let ids = 0;
const makeId = () => `n${++ids}`;
const audio = (timeline: Timeline) => timeline.tracks.find((track) => track.id === FIRST_AUDIO_ID)!.clips;
const expectTimeline = (value: Timeline | Refusal | null): Timeline => {
  if (!value) throw new Error("refused");
  if (isRefusal(value)) throw new Error(value.refused);
  return value;
};

describe("tracks", () => {
  it("loads older sequences as Video 1 with linked, aligned sound on Audio 1", () => {
    const timeline = defaultTimeline([a, b], (source) => source === "a.mp4");
    expect(timeline.tracks.map((track) => track.name)).toEqual(["Video 1", "Audio 1"]);
    expect(timeline.main[0].link).toBe("link-a");
    expect(timeline.main[1].link).toBeUndefined();
    expect(audio(timeline)).toEqual([{ id: "a-sound", source: "a.mp4", startMs: 0, endMs: 4000, atMs: 0, link: "link-a" }]);
    expect(needsTracks(timeline, (source) => source === "a.mp4")).toBe(false);
  });

  it("saves the default timeline as withClips does and a changed one as TRACKS_VERSION", () => {
    const own = "a.mp4";
    const plain = withTimeline({ version: 1 }, defaultTimeline([a], sound), own, 4000, sound);
    expect(serializeEdits(plain)).toEqual({ version: 1 });

    const unlinked = unlinkClips(defaultTimeline([a, b], sound), new Set(["a"]));
    const edits = withTimeline({ version: 1, trim: { startMs: 5, endMs: 6 } }, unlinked, own, 4000, sound);
    const sidecar = JSON.parse(JSON.stringify(serializeEdits(edits)));
    expect(sidecar.version).toBe(TRACKS_VERSION);
    expect(sidecar.trim).toBeUndefined();
    expect(sidecar.clips).toBeUndefined();
    expect(sidecar.tracks[0]).toEqual({ id: MAIN_TRACK_ID, name: "Video 1", kind: "video", clips: [{ ...a }, { ...b, link: "link-b" }] });
    const read: RecordingEdits = parseEdits(sidecar);
    expect(read.version).toBe(TRACKS_VERSION);
    expect(timelineOf(read, read.clips!, sound)).toEqual(unlinked);
  });

  it("drops what it does not understand in saved tracks", () => {
    const timeline = parseTracks(
      [
        { id: MAIN_TRACK_ID, name: "Video 1", kind: "video", clips: [a] },
        { id: "x", kind: "subtitle", clips: [] },
        { id: "audio-1", name: "Voice", kind: "audio", locked: true, clips: [
          { id: "s1", source: "a.mp4", startMs: 0, endMs: 1000, atMs: 0 },
          { id: "s2", source: "a.mp4", startMs: 0, endMs: 1000, atMs: 500 },
          { id: "s3", source: "../a.mp4", startMs: 0, endMs: 1000, atMs: 2000 },
        ] },
      ],
      TRACKS_VERSION,
    )!;
    expect(timeline.tracks.map((track) => track.id)).toEqual([MAIN_TRACK_ID, "audio-1"]);
    expect(timeline.tracks[1]).toMatchObject({ name: "Voice", locked: true });
    expect(timeline.tracks[1].clips.map((clip) => clip.id)).toEqual(["s1"]);
    expect(parseTracks([{ id: "audio-1", kind: "audio", clips: [] }], TRACKS_VERSION)).toBeNull();
    expect(parseTracks([{ id: MAIN_TRACK_ID, kind: "video", clips: [a] }], (TRACKS_VERSION - 1) as RecordingEdits["version"])).toBeNull();
  });

  it("does not split one half of a linked group when the other track is locked", () => {
    const timeline = lockTrack(defaultTimeline([a, b], sound), FIRST_AUDIO_ID, true);
    expect(canSplitAt(timeline, 1000, a.id)).toBe(false);
    expect(splitAt(timeline, 1000)).toBe(timeline);
  });

  it("refuses cuts that would remove or displace locked linked sound", () => {
    const timeline = lockTrack(defaultTimeline([a, b], sound), FIRST_AUDIO_ID, true);
    expect(cutSpan(timeline, 1000, 2000)).toMatchObject({ refused: expect.stringContaining("locked track") });
    expect(rippleDelete(timeline, a.id)).toMatchObject({ refused: expect.stringContaining("locked track") });
    const laterSound = lockTrack(defaultTimeline([a, b], (source) => source === b.source), FIRST_AUDIO_ID, true);
    expect(cutSpan(laterSound, 1000, 2000)).toMatchObject({ refused: expect.stringContaining("locked track") });
  });

  it("links two or more clips and unlinks a whole group", () => {
    const timeline = unlinkClips(defaultTimeline([a], sound), new Set(["a-sound"]));
    expect(timeline.main[0].link).toBeUndefined();
    expect(linkClips(timeline, new Set(["a"]))).toBeNull();
    const linked = linkClips(timeline, new Set(["a", "a-sound"]), "L")!;
    expect(linked.main[0].link).toBe("L");
    expect(audio(linked)[0].link).toBe("L");
  });

  it("moves unlinked sound in time and refuses sound linked to Video 1", () => {
    const timeline = defaultTimeline([a, b], sound);
    expect(isRefusal(moveInTime(timeline, "a-sound", 500))).toBe(true);
    const free = unlinkClips(timeline, new Set(["a-sound"]));
    expect(isRefusal(moveInTime(free, "a-sound", 500))).toBe(true); // runs into b's sound
    const shifted = expectTimeline(moveInTime(unlinkClips(free, new Set(["b"])), "b-sound", 4500));
    expect(audio(shifted).find((clip) => clip.id === "b-sound")!.atMs).toBe(4500);
    // With the timeline's end given, it starts just before it at the latest.
    const late = expectTimeline(moveInTime(unlinkClips(free, new Set(["b"])), "b-sound", 9000, undefined, 6000));
    expect(audio(late).find((clip) => clip.id === "b-sound")!.atMs).toBe(5900);
  });

  it("carries linked sound when the sequence is reordered", () => {
    const timeline = defaultTimeline([a, b], sound);
    const reordered = expectTimeline(reconcile(timeline, [timeline.main[1], timeline.main[0]], sound));
    expect(audio(reordered).map((clip) => [clip.id, clip.atMs])).toEqual([["b-sound", 0], ["a-sound", 2000]]);
  });

  it("trims linked clips by the same amount, clamped together", () => {
    const timeline = defaultTimeline([a, b], sound);
    const trimmed = expectTimeline(reconcile(timeline, [{ ...timeline.main[0], startMs: 1000 }, timeline.main[1]], sound));
    expect(trimmed.main[0]).toMatchObject({ startMs: 1000, endMs: 4000 });
    expect(audio(trimmed)[0]).toMatchObject({ startMs: 1000, atMs: 0 });
    expect(audio(trimmed)[1].atMs).toBe(3000);
    // b's recording ends at 3500, so its end grows only 500, picture and sound alike.
    const longer = expectTimeline(reconcile(timeline, [timeline.main[0], { ...timeline.main[1], endMs: 5000 }], sound, undefined, (source) => (source === "b.mp4" ? 3500 : 10_000)));
    expect(longer.main[1].endMs).toBe(3500);
    expect(audio(longer)[1].endMs).toBe(3500);
  });

  it("keeps pictures and sound with unequal offsets in step when trimming", () => {
    // The picture starts 2 s into its recording, its linked sound 0.5 s into another.
    const picture: Clip = { id: "p", source: "a.mp4", startMs: 2000, endMs: 4000, link: "L" };
    const timeline: Timeline = {
      main: [picture],
      tracks: [
        { id: MAIN_TRACK_ID, name: "Video 1", kind: "video", clips: [] },
        { id: FIRST_AUDIO_ID, name: "Audio 1", kind: "audio", clips: [{ id: "s", source: "v.mp4", startMs: 500, endMs: 2500, atMs: 0, link: "L" }] },
      ],
    };
    const trimmed = expectTimeline(reconcile(timeline, [{ ...picture, startMs: 500 }], sound));
    // The sound can give only 500 ms, so the picture gives the same.
    expect(trimmed.main[0].startMs).toBe(1500);
    expect(audio(trimmed)[0]).toMatchObject({ startMs: 0, endMs: 2500, atMs: 0 });
  });

  it("keeps one recording's unlinked sound on the recording's own time as its trim moves", () => {
    const free = expectTimeline(moveInTime(unlinkClips(defaultTimeline([a], sound), new Set(["a"])), "a-sound", 500));
    const trimmed = shiftUnlinked(free, 1000);
    expect(audio(trimmed)[0]).toMatchObject({ startMs: 500, atMs: 0 });
    expect(audio(shiftUnlinked(free, -1000))[0]).toMatchObject({ startMs: 0, atMs: 1500 });
  });

  it("splits every track at the playhead, or a clip and its links", () => {
    ids = 0;
    const timeline = defaultTimeline([a], sound);
    const all = splitAt(timeline, 1000, undefined, 500, makeId);
    expect(all.main.map((clip) => [clip.startMs, clip.endMs])).toEqual([[0, 1000], [1000, 4000]]);
    expect(audio(all).map((clip) => [clip.startMs, clip.atMs])).toEqual([[0, 0], [1000, 1000]]);
    expect(all.main[1].link).toBe(audio(all)[1].link);
    expect(all.main[1].link).not.toBe(all.main[0].link);
    expect(audio(splitAt(timeline, 1000, "a-sound", 500, makeId))).toHaveLength(2);
  });

  it("keeps an intersected link group whole when its shorter sound cannot split", () => {
    const timeline = defaultTimeline([a], sound);
    audio(timeline)[0].endMs = 3000;
    expect(canSplitAt(timeline, 2800, "a")).toBe(false);
    expect(splitAt(timeline, 2800, "a")).toBe(timeline);
    // Ripple cuts still use a one-millisecond minimum.
    expect(splitAt(timeline, 2800, "a", 1).main).toHaveLength(2);
  });

  it("does not link a split picture tail to a partner that ends at the split", () => {
    const timeline = defaultTimeline([a], sound);
    audio(timeline)[0].endMs = 3000;
    for (const minMs of [500, 1]) {
      const next = splitAt(timeline, 3000, "a", minMs);
      expect(next.main).toHaveLength(2);
      expect(next.main[0].link).toBe(audio(next)[0].link);
      expect(next.main[1].link).toBeUndefined();
      expect(audio(next)).toHaveLength(1);
    }
  });

  it("ripple-deletes a clip with its sound and shifts later clips", () => {
    const timeline = defaultTimeline([a, b], sound);
    const next = expectTimeline(rippleDelete(timeline, "a"));
    expect(next.main.map((clip) => clip.id)).toEqual(["b"]);
    expect(audio(next)).toEqual([{ id: "b-sound", source: "b.mp4", startMs: 1000, endMs: 3000, atMs: 0, link: "link-b" }]);
  });

  it("refuses a ripple over an unlinked clip, saying why", () => {
    const shifted = expectTimeline(moveInTime(unlinkClips(defaultTimeline([a, b], sound), new Set(["b"])), "b-sound", 4100));
    const free = unlinkClips(shifted, new Set(["a"]));
    const refused = rippleDelete(free, "a");
    expect(isRefusal(refused) && refused.refused).toMatch(/not linked/);
    const cut = expectTimeline(cutSpan(shifted, 1000, 2000, makeId));
    expect(cut.main.map((clip) => [clip.startMs, clip.endMs])).toEqual([[0, 1000], [2000, 4000], [1000, 3000]]);
    expect(audio(cut).map((clip) => clip.atMs)).toEqual([0, 1000, 3100]);
  });

  it("leaves a gap where a deleted clip and its sound were", () => {
    const timeline = defaultTimeline([a, b], sound);
    const next = expectTimeline(reconcile(timeline, [{ id: "g", source: "", startMs: 0, endMs: 4000, gap: true }, timeline.main[1]], sound));
    expect(next.main[0]).toMatchObject({ id: "g", gap: true, endMs: 4000 });
    expect(audio(next).map((clip) => clip.atMs)).toEqual([4000]);
  });

  it("sends every audio clip to the export at its place", () => {
    const timeline = defaultTimeline([a, b], sound);
    expect(exportAudio(timeline)).toEqual([
      { source: "a.mp4", startMs: 0, endMs: 4000, atMs: 0 },
      { source: "b.mp4", startMs: 1000, endMs: 3000, atMs: 4000 },
    ]);
  });

  it("makes linked sound follow edits of the sequence", () => {
    ids = 0;
    const timeline = defaultTimeline([a, b], sound);
    // Trimmed: the sound is trimmed too, and later sound moves up.
    const trimmed = reconcile(timeline, [{ ...timeline.main[0], startMs: 1000 }, timeline.main[1]], sound, makeId)!;
    expect(audio(trimmed).map((clip) => [clip.startMs, clip.atMs])).toEqual([[1000, 0], [1000, 3000]]);
    // Copied: the copy gets its own link and its own sound.
    const copied = reconcile(timeline, [timeline.main[0], { ...timeline.main[0], id: "copy" }, timeline.main[1]], sound, makeId)!;
    expect(copied.main[1].link).not.toBe(copied.main[0].link);
    expect(audio(copied).map((clip) => clip.atMs)).toEqual([0, 4000, 8000]);
    // Removed: its sound goes.
    expect(audio(reconcile(timeline, [timeline.main[1]], sound, makeId)!).map((clip) => clip.id)).toEqual(["b-sound"]);
    // Added: its sound lands on Audio 1, linked.
    const added = reconcile(timeline, [...timeline.main, { id: "c", source: "c.mp4", startMs: 0, endMs: 1000 }], sound, makeId)!;
    expect(audio(added)[audio(added).length - 1]).toMatchObject({ source: "c.mp4", atMs: 6000, link: added.main[2].link });
  });

  it("renames tracks, which then need saving, and keeps a saved lock", () => {
    const timeline = renameTrack(defaultTimeline([a], sound), FIRST_AUDIO_ID, " Voice ");
    expect(timeline.tracks[1].name).toBe("Voice");
    expect(needsTracks(timeline, sound)).toBe(true);
    const locked = { ...timeline, tracks: timeline.tracks.map((track) => (track.id === FIRST_AUDIO_ID ? { ...track, locked: true } : track)) };
    expect((serializeTracks(locked)[1] as { locked?: boolean }).locked).toBe(true);
    expect(parseTracks(serializeTracks(locked), TRACKS_VERSION)!.tracks[1].locked).toBe(true);
  });

  it("lines up two sound clips linked together, refusing an overlap", () => {
    const free = expectTimeline(moveInTime(unlinkClips(defaultTimeline([a], sound), new Set(["a"])), "a-sound", 500));
    const second: Track = { id: "audio-2", name: "Audio 2", kind: "audio", clips: [{ id: "v", source: "v.mp4", startMs: 0, endMs: 1000, atMs: 3000 }] };
    const two = { ...free, tracks: [...free.tracks, second] };
    const linked = linkClips(two, new Set(["a-sound", "v"]), "L")!;
    expect(linked.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip.atMs, clip.link])).toEqual([["a-sound", 500, "L"], ["v", 500, "L"]]);
    expect(linkClips({ ...free, tracks: [free.tracks[0], { ...free.tracks[1], clips: [...free.tracks[1].clips, { id: "w", source: "v.mp4", startMs: 0, endMs: 500, atMs: 4600 }] }] }, new Set(["a-sound", "w"]))).toBeNull();
  });

  it("lines linked sound up with its picture, and keeps it there through other edits", () => {
    ids = 0;
    const free = unlinkClips(defaultTimeline([a, b], sound), new Set(["b"]));
    const shifted = expectTimeline(moveInTime(free, "b-sound", 4500));
    const relinked = linkClips(shifted, new Set(["b", "b-sound"]), "L")!;
    expect(audio(relinked).find((clip) => clip.id === "b-sound")).toMatchObject({ atMs: 4000, link: "L" });
    // Trimming the other clip moves the linked sound with its picture, no further.
    const trimmed = reconcile(relinked, [{ ...relinked.main[0], endMs: 3000 }, relinked.main[1]], sound, makeId)!;
    expect(audio(trimmed).find((clip) => clip.id === "b-sound")!.atMs).toBe(3000);
    // Two pictures can't share one link.
    expect(linkClips(defaultTimeline([a, b], sound), new Set(["a", "b"]))).toBeNull();
    // Unlinked sound linked to a picture it would then overlap is refused.
    const both = unlinkClips(defaultTimeline([a, b], sound), new Set(["a", "b"]));
    expect(linkClips(both, new Set(["a", "b-sound"]))).toBeNull();
  });

  it("closes a gap on every track, refusing one under unlinked sound", () => {
    const withGap = defaultTimeline([a, { id: "g", source: "", startMs: 0, endMs: 1000, gap: true }, b], sound);
    const free = unlinkClips(withGap, new Set(["b"]));
    const closed = expectTimeline(rippleDelete(free, "g"));
    expect(closed.main.map((clip) => clip.id)).toEqual(["a", "b"]);
    expect(audio(closed).find((clip) => clip.id === "b-sound")!.atMs).toBe(4000);
    const over = expectTimeline(moveInTime(free, "b-sound", 4500));
    expect(isRefusal(rippleDelete(over, "g"))).toBe(true);
  });

  it("snaps within 8 px unless turned off", () => {
    expect(snapMs(1030, [0, 1000], 0.2)).toBe(1000);
    expect(snapMs(1050, [0, 1000], 0.1)).toBe(1000);
    expect(snapMs(1100, [0, 1000], 0.1)).toBe(1100);
    expect(snapMs(1030, [1000], 0.2, false)).toBe(1030);
    expect(snapClip(2960, 1000, [4000], 0.2)).toBe(3000);
    expect(snapClip(1000, 4000, [1000, 5050], 0.1)).toBe(1000);
    expect(snapClip(1000, 4000, [950, 5000], 0.1)).toBe(1000);
    expect(snapTargets(defaultTimeline([a], sound), 1500, new Set(["a-sound"]))).toEqual([0, 1500, 4000]);
  });
});

describe("more tracks", () => {
  const withVideo2 = () => {
    ids = 0;
    return addTrack(defaultTimeline([a], sound), "video", makeId);
  };

  it("adds video tracks on top and audio tracks last, and removes only empty extra tracks", () => {
    const { timeline, id } = withVideo2();
    expect(timeline.tracks.map((track) => track.name)).toEqual(["Video 2", "Video 1", "Audio 1"]);
    const withAudio = addTrack(timeline, "audio", makeId);
    expect(withAudio.timeline.tracks.map((track) => track.name)).toEqual(["Video 2", "Video 1", "Audio 1", "Audio 2"]);
    expect(needsTracks(timeline, sound)).toBe(true);
    expect(expectTimeline(removeTrack(withAudio.timeline, withAudio.id)).tracks).toHaveLength(3);
    expect(isRefusal(removeTrack(timeline, MAIN_TRACK_ID))).toBe(true);
    expect(isRefusal(removeTrack(timeline, FIRST_AUDIO_ID))).toBe(true);
    const placed = placeRecording(timeline, id, b, 0, () => false, makeId);
    if (isRefusal(placed)) throw new Error(placed.refused);
    expect(removeTrack(placed.timeline, id)).toEqual({ refused: "Video 2 still holds clips. Move or delete them first." });
  });

  it("places a recording on an extra video track at the playhead with its sound linked", () => {
    const { timeline, id } = withVideo2();
    const placed = placeRecording(timeline, id, b, 1500, sound, makeId);
    if (isRefusal(placed)) throw new Error(placed.refused);
    const video2 = placed.timeline.tracks.find((track) => track.id === id)!;
    expect(video2.clips).toEqual([{ id: placed.id, source: "b.mp4", startMs: 1000, endMs: 3000, atMs: 1500, link: expect.any(String) }]);
    // Audio 1 holds a's sound over 0-4000, so b's goes on a new Audio 2, linked.
    const audio2 = placed.timeline.tracks.find((track) => track.name === "Audio 2")!;
    expect(audio2.clips).toEqual([{ id: expect.any(String), source: "b.mp4", startMs: 1000, endMs: 3000, atMs: 1500, link: video2.clips[0].link }]);
    expect(isRefusal(placeRecording(placed.timeline, id, b, 2000, sound, makeId))).toBe(true);
    expect(isRefusal(placeRecording(timeline, MAIN_TRACK_ID, b, 0, sound, makeId))).toBe(true);
    const locked = lockTrack(timeline, id, true);
    expect(isRefusal(placeRecording(locked, id, b, 0, sound, makeId))).toBe(true);
  });

  it("moves clips between tracks of one kind, refusing overlaps and other kinds", () => {
    const { timeline, id } = withVideo2();
    const third = addTrack(timeline, "video", makeId);
    const placed = placeRecording(third.timeline, id, b, 0, () => false, makeId);
    if (isRefusal(placed)) throw new Error(placed.refused);
    const moved = expectTimeline(moveInTime(placed.timeline, placed.id, 500, third.id));
    expect(moved.tracks.find((track) => track.id === third.id)!.clips.map((clip) => clip.atMs)).toEqual([500]);
    expect(moved.tracks.find((track) => track.id === id)!.clips).toEqual([]);
    expect(isRefusal(moveInTime(placed.timeline, placed.id, 0, FIRST_AUDIO_ID))).toBe(true);
    expect(isRefusal(moveInTime(placed.timeline, placed.id, 0, MAIN_TRACK_ID))).toBe(true);
    const busy = placeRecording(placed.timeline, third.id, b, 0, () => false, makeId);
    if (isRefusal(busy)) throw new Error(busy.refused);
    expect(moveInTime(busy.timeline, placed.id, 100, third.id)).toEqual({ refused: "It would overlap another clip on that track." });
  });

  it("flattens video tracks so the highest one with a clip shows", () => {
    const { timeline, id } = withVideo2();
    expect(flattenPicture(timeline)).toBe(timeline.main);
    expect(hasOverlay(timeline)).toBe(false);
    const placed = placeRecording(timeline, id, b, 1000, () => false, makeId);
    if (isRefusal(placed)) throw new Error(placed.refused);
    expect(hasOverlay(placed.timeline)).toBe(true);
    const picture = flattenPicture(placed.timeline);
    expect(picture.map((clip) => [clip.source, clip.startMs, clip.endMs])).toEqual([
      ["a.mp4", 0, 1000],
      ["b.mp4", 1000, 3000],
      ["a.mp4", 3000, 4000],
    ]);
    expect(picture[0].id).toBe("a");
    expect(picture[2].id).toBe("a@3000");
  });

  it("fills time no video track covers with gaps and ends with the last video clip", () => {
    const { timeline, id } = withVideo2();
    const placed = placeRecording(timeline, id, b, 6000, () => false, makeId);
    if (isRefusal(placed)) throw new Error(placed.refused);
    const picture = flattenPicture(placed.timeline);
    expect(picture.map((clip) => [clip.gap === true, clip.endMs - clip.startMs])).toEqual([
      [false, 4000],
      [true, 2000],
      [false, 2000],
    ]);
  });

  it("keeps locked clips out of selection", () => {
    const timeline = lockTrack(defaultTimeline([a], sound), FIRST_AUDIO_ID, true);
    expect(isLockedClip(timeline, "a-sound")).toBe(true);
    expect(isLockedClip(timeline, "a")).toBe(false);
    expect(isRefusal(moveInTime(unlinkClips(timeline, new Set(["a"])), "a-sound", 500))).toBe(true);
  });

  it("splits every unlocked track's clip under the playhead, extra tracks too", () => {
    const { timeline, id } = withVideo2();
    const placed = placeRecording(timeline, id, b, 0, () => false, makeId);
    if (isRefusal(placed)) throw new Error(placed.refused);
    const all = splitAt(placed.timeline, 1000, undefined, 500, makeId);
    expect(all.main).toHaveLength(2);
    expect(all.tracks.find((track) => track.id === id)!.clips.map((clip) => [clip.startMs, clip.atMs])).toEqual([[1000, 0], [2000, 1000]]);
    const locked = splitAt(lockTrack(placed.timeline, id, true), 1000, undefined, 500, makeId);
    expect(locked.tracks.find((track) => track.id === id)!.clips).toHaveLength(1);
    expect(locked.main).toHaveLength(2);
  });

  it("saves and reopens three tracks with a locked one", () => {
    const { timeline, id } = withVideo2();
    const placed = placeRecording(timeline, id, b, 1000, sound, makeId);
    if (isRefusal(placed)) throw new Error(placed.refused);
    const audio2 = placed.timeline.tracks.find((track) => track.name === "Audio 2")!;
    const arranged = lockTrack(placed.timeline, audio2.id, true);
    const edits = withTimeline({ version: 1 }, arranged, "a.mp4", 4000, sound);
    const sidecar = JSON.parse(JSON.stringify(serializeEdits(edits)));
    expect(sidecar.version).toBe(TRACKS_VERSION);
    expect(sidecar.tracks.map((track: { name: string; locked?: boolean }) => [track.name, track.locked === true])).toEqual([
      ["Video 2", false],
      ["Video 1", false],
      ["Audio 1", false],
      ["Audio 2", true],
    ]);
    const read = parseEdits(sidecar);
    expect(timelineOf(read, read.clips!, sound)).toEqual(arranged);
  });
});
