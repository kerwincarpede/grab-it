import { describe, expect, it } from "vitest";
import type { AudioKind } from "./api";
import { gapOf, type Clip } from "./clips";
import { BAR_PX, laneKinds, laneSegments, layoutLane, peaksKey, soundSegments, type LaneSegment, type PeaksState } from "./waveform";

const clip = (id: string, source: string, startMs: number, endMs: number): Clip => ({ id, source, startMs, endMs });
const AUDIO: Record<string, AudioKind[]> = { a: ["microphone", "system"], b: ["mixed"], silent: [] };
const audioOf = (source: string) => AUDIO[source] ?? null;

describe("laneKinds", () => {
  it("lists each kind any clip has, in lane order", () => {
    expect(laneKinds([clip("1", "b", 0, 10), gapOf("g", 5), clip("2", "a", 0, 10)], audioOf)).toEqual(["microphone", "system", "mixed"]);
    expect(laneKinds([clip("1", "a", 0, 10)], audioOf)).toEqual(["microphone", "system"]);
    expect(laneKinds([clip("1", "silent", 0, 10), clip("2", "unknown", 0, 10)], audioOf)).toEqual([]);
  });
});

describe("laneSegments", () => {
  it("places each clip with the kind at its place in the sequence, skipping gaps and clips without it", () => {
    const clips = [clip("1", "a", 1000, 3000), gapOf("g", 500), clip("2", "b", 0, 1000), clip("3", "a", 4000, 5000)];
    expect(laneSegments(clips, "system", audioOf, true, 0)).toEqual([
      { clipId: "1", source: "a", audio: 1, atMs: 0, lengthMs: 2000, fromMs: 1000, keptStartMs: 0, keptEndMs: 2000 },
      { clipId: "3", source: "a", audio: 1, atMs: 3500, lengthMs: 1000, fromMs: 4000, keptStartMs: 3500, keptEndMs: 4500 },
    ]);
    expect(laneSegments(clips, "mixed", audioOf, true, 0).map((segment) => [segment.clipId, segment.atMs, segment.audio])).toEqual([["2", 2500, 0]]);
  });

  it("spans an unjoined recording's whole length, its trim as the kept stretch", () => {
    expect(laneSegments([clip("1", "a", 2000, 8000)], "microphone", audioOf, false, 10_000)).toEqual([
      { clipId: "1", source: "a", audio: 0, atMs: 0, lengthMs: 10_000, fromMs: 0, keptStartMs: 2000, keptEndMs: 8000 },
    ]);
    expect(laneSegments([clip("1", "a", 0, 1000)], "mixed", audioOf, false, 1000)).toEqual([]);
  });
});

describe("soundSegments", () => {
  it("draws a shifted, unlinked sound clip at its own place, not its picture's", () => {
    // The picture is 1-3 s of "a" at 0; its sound, unlinked, moved to 1.5 s.
    const sound = [{ id: "s", source: "a", startMs: 1000, endMs: 3000, atMs: 1500 }];
    expect(soundSegments(sound, "system", audioOf, 10_000)).toEqual([
      { clipId: "s", source: "a", audio: 1, atMs: 1500, lengthMs: 2000, fromMs: 1000, keptStartMs: 1500, keptEndMs: 3500 },
    ]);
    // One recording trimmed to start at 2 s: sequence time 0 is 2 s on its timeline, and nothing runs past the end.
    expect(soundSegments(sound, "microphone", audioOf, 4000, 2000)).toEqual([
      { clipId: "s", source: "a", audio: 0, atMs: 3500, lengthMs: 500, fromMs: 1000, keptStartMs: 3500, keptEndMs: 4000 },
    ]);
    expect(soundSegments(sound, "mixed", audioOf, 10_000)).toEqual([]);
    // A 12 s recording trimmed to 0-8 s: sound running past 8 s is dimmed there, as trimmed-away ends are.
    const long = [{ id: "t", source: "a", startMs: 0, endMs: 9000, atMs: 1000 }];
    expect(soundSegments(long, "microphone", audioOf, 12_000, 0, 8000)).toEqual([
      { clipId: "t", source: "a", audio: 0, atMs: 1000, lengthMs: 9000, fromMs: 0, keptStartMs: 1000, keptEndMs: 8000 },
    ]);
    const { bars } = layoutLane(soundSegments(long, "microphone", audioOf, 12_000, 0, 8000), () => ({ status: "ready", peaks: new Uint8Array(1200).fill(255) }), { startMs: 0, endMs: 12_000, width: 12 });
    // One bar every 2 s up to the sound's end at 10 s: the one past 8 s is dimmed.
    expect(bars.map((bar) => [bar.x, bar.dim])).toEqual([[0, false], [2, false], [4, false], [6, false], [8, true]]);
  });
});

describe("layoutLane", () => {
  const segment = (atMs: number, lengthMs: number, fromMs = 0, kept?: [number, number]): LaneSegment => ({
    clipId: "c",
    source: "a",
    audio: 0,
    atMs,
    lengthMs,
    fromMs,
    keptStartMs: kept?.[0] ?? atMs,
    keptEndMs: kept?.[1] ?? atMs + lengthMs,
  });
  const ready = (peaks: number[]): PeaksState => ({ status: "ready", peaks: Uint8Array.from(peaks) });

  it("draws the loudest peak of each column's stretch of the recording", () => {
    // 100 ms on 20 px: each 2 px bar covers 10 ms, one peak.
    const peaks = Array.from({ length: 20 }, (_, i) => i * 10);
    const { bars, spans } = layoutLane([segment(0, 100, 50)], () => ready(peaks), { startMs: 0, endMs: 100, width: 20 });
    expect(bars).toHaveLength(10);
    expect(bars[0]).toEqual({ x: 0, height: 50 / 255, dim: false });
    expect(bars[9].height).toBeCloseTo(140 / 255);
    expect(spans).toEqual([expect.objectContaining({ x: 0, width: 20 })]);
  });

  it("takes the maximum when a column covers several peaks", () => {
    const { bars } = layoutLane([segment(0, 100)], () => ready([1, 9, 3, 4, 2, 0, 0, 0, 0, 255]), { startMs: 0, endMs: 100, width: 4 });
    expect(bars.map((bar) => Math.round(bar.height * 255))).toEqual([9, 255]);
  });

  it("leaves gaps and clips without peaks empty, and keeps only what is in view", () => {
    const segments = [segment(0, 100), segment(200, 100), segment(400, 100)];
    const states: Record<number, PeaksState | undefined> = { 0: ready(Array(10).fill(100)), 200: { status: "loading" } };
    const { bars, spans } = layoutLane(segments, (s) => states[s.atMs], { startMs: 50, endMs: 250, width: 200 });
    expect(spans.map((span) => [span.segment.atMs, span.x, span.width, span.state?.status])).toEqual([
      [0, 0, 50, "ready"],
      [200, 150, 50, "loading"],
    ]);
    expect(bars.every((bar) => bar.x < 50)).toBe(true);
    expect(bars).toHaveLength(50 / BAR_PX);
  });

  it("dims the trimmed-away ends of an unjoined recording", () => {
    const { bars } = layoutLane([segment(0, 100, 0, [20, 80])], () => ready(Array(10).fill(255)), { startMs: 0, endMs: 100, width: 10 });
    expect(bars.map((bar) => bar.dim)).toEqual([true, false, false, false, true]);
  });

  it("draws nothing for an empty view", () => {
    expect(layoutLane([segment(0, 100)], () => ready([1]), { startMs: 0, endMs: 0, width: 100 })).toEqual({ bars: [], spans: [] });
  });

  it("keys peaks by source and index", () => {
    expect(peaksKey("a.mp4", 1)).not.toBe(peaksKey("a.mp4", 0));
  });
});
