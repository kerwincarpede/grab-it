/**
 * Waveform lanes: where each clip draws its own recording's sound on the
 * timeline. A recording's peaks (`recordingWaveform`) are one byte for
 * each 10 ms of the whole file; a clip shows those of its kept stretch at
 * its place on the timeline, and gaps stay empty.
 */
import type { AudioKind } from "./api";
import { clipLength, clipStarts, isGap, type Clip } from "./clips";

/** How many ms one peak covers. */
export const PEAK_MS = 10;
/** One bar's width on the canvas, in px; bars are drawn a pixel apart. */
export const BAR_PX = 2;

/** The kinds lanes are drawn for, in their order top to bottom. */
export const LANE_KINDS: readonly AudioKind[] = ["microphone", "system", "mixed"];

/** What is known of one recording source's peaks. */
export type PeaksState = { status: "loading" } | { status: "ready"; peaks: Uint8Array } | { status: "failed"; error: string };

/** One clip's stretch of sound in a lane. */
export interface LaneSegment {
  /** The clip it belongs to. */
  clipId: string;
  /** Its recording, and which of its sound sources the lane draws. */
  source: string;
  audio: number;
  /** Where it starts on the timeline, in ms. */
  atMs: number;
  /** How long it runs on the timeline, in ms. */
  lengthMs: number;
  /** The recording's time at its start, in ms. */
  fromMs: number;
  /** The kept stretch on the timeline; outside it the bars are dimmed. */
  keptStartMs: number;
  keptEndMs: number;
}

/**
 * The kinds of sound any clip of `clips` has, in lane order, from
 * `audioOf` (each recording's sources, or null until they are known).
 */
export function laneKinds(clips: Clip[], audioOf: (source: string) => readonly AudioKind[] | null): AudioKind[] {
  const present = new Set<AudioKind>();
  for (const clip of clips) {
    if (isGap(clip)) continue;
    for (const kind of audioOf(clip.source) ?? []) present.add(kind);
  }
  return LANE_KINDS.filter((kind) => present.has(kind));
}

/**
 * The stretches lane `kind` draws. Joined, each clip with that kind takes
 * its place in the sequence. Otherwise the timeline is the opened
 * recording's own time: its one clip spans `durationMs`, the ends outside
 * `kept` (the trim on screen, else the clip's own) dimmed.
 */
export function laneSegments(
  clips: Clip[],
  kind: AudioKind,
  audioOf: (source: string) => readonly AudioKind[] | null,
  joined: boolean,
  durationMs: number,
  kept?: { startMs: number; endMs: number },
): LaneSegment[] {
  if (!joined) {
    const clip = clips[0];
    const audio = clip && !isGap(clip) ? (audioOf(clip.source) ?? []).indexOf(kind) : -1;
    if (!clip || audio < 0 || durationMs <= 0) return [];
    const trim = kept ?? clip;
    return [{ clipId: clip.id, source: clip.source, audio, atMs: 0, lengthMs: durationMs, fromMs: 0, keptStartMs: trim.startMs, keptEndMs: trim.endMs }];
  }
  const starts = clipStarts(clips);
  const segments: LaneSegment[] = [];
  clips.forEach((clip, index) => {
    if (isGap(clip)) return;
    const audio = (audioOf(clip.source) ?? []).indexOf(kind);
    const lengthMs = clipLength(clip);
    if (audio < 0 || lengthMs <= 0) return;
    const atMs = starts[index] ?? 0;
    segments.push({ clipId: clip.id, source: clip.source, audio, atMs, lengthMs, fromMs: clip.startMs, keptStartMs: atMs, keptEndMs: atMs + lengthMs });
  });
  return segments;
}

/** One bar of a lane: `x` px into the visible lane, `height` 0 to 1 of it. */
export interface LaneBar {
  x: number;
  height: number;
  dim: boolean;
}

/** Where a segment shows in the visible lane, in px, and what is known of its peaks. */
export interface LaneSpan {
  segment: LaneSegment;
  x: number;
  width: number;
  state: PeaksState | undefined;
}

/** The visible stretch of the timeline and its width in px. */
export interface LaneView {
  startMs: number;
  endMs: number;
  width: number;
}

/**
 * The bars and segment spans of a lane for `view`. Each `BAR_PX` column
 * takes the loudest peak its stretch of a clip's recording holds; columns
 * over a gap, or a clip whose peaks have not arrived, have no bar.
 */
export function layoutLane(segments: LaneSegment[], peaksOf: (segment: LaneSegment) => PeaksState | undefined, view: LaneView): { bars: LaneBar[]; spans: LaneSpan[] } {
  const bars: LaneBar[] = [];
  const spans: LaneSpan[] = [];
  const span = view.endMs - view.startMs;
  if (span <= 0 || view.width <= 0) return { bars, spans };
  const pxPerMs = view.width / span;
  const msAt = (x: number) => view.startMs + x / pxPerMs;
  for (const segment of segments) {
    const end = segment.atMs + segment.lengthMs;
    if (end <= view.startMs || segment.atMs >= view.endMs) continue;
    const left = Math.max(0, (segment.atMs - view.startMs) * pxPerMs);
    const right = Math.min(view.width, (end - view.startMs) * pxPerMs);
    const state = peaksOf(segment);
    spans.push({ segment, x: left, width: right - left, state });
    if (state?.status !== "ready") continue;
    const { peaks } = state;
    const first = Math.floor(left / BAR_PX) * BAR_PX;
    for (let x = first; x < right; x += BAR_PX) {
      const fromMs = Math.max(segment.atMs, msAt(x));
      const toMs = Math.min(end, msAt(x + BAR_PX));
      if (toMs <= fromMs) continue;
      const sourceFrom = segment.fromMs + (fromMs - segment.atMs);
      const sourceTo = segment.fromMs + (toMs - segment.atMs);
      const low = Math.max(0, Math.floor(sourceFrom / PEAK_MS));
      const high = Math.min(peaks.length - 1, Math.max(low, Math.ceil(sourceTo / PEAK_MS) - 1));
      if (low > high) continue;
      let loudest = 0;
      for (let i = low; i <= high; i++) loudest = Math.max(loudest, peaks[i]);
      const middle = (fromMs + toMs) / 2;
      bars.push({ x, height: loudest / 255, dim: middle < segment.keptStartMs || middle > segment.keptEndMs });
    }
  }
  return { bars, spans };
}

/** The key a recording source's peaks are kept under. */
export const peaksKey = (source: string, audio: number) => `${audio}:${source}`;
