/**
 * Suggest edits: cuts proposed where a recording pauses. A pause is a
 * quiet stretch of its sound (found on the computer by
 * src-tauri/src/recording_suggest.rs) during which the pointer stays
 * still; a silent recording's pauses come from the pointer alone. Each
 * proposal keeps a little of the pause at both ends so speech is never
 * clipped, and lies inside a clip the sequence still plays, so stretches
 * already cut are never proposed again.
 *
 * Nothing changes until the chosen proposals are applied together with
 * `applyCuts`, which is one undo entry in the editor.
 */
import type { PauseSound } from "../app/bindings";
import { MIN_CLIP_MS } from "./edits";
import { clipLength, clipStarts, isGap, mergeGaps, newClipId, type Clip } from "./clips";
import { cutSpan, isRefusal, type Timeline } from "./tracks";
import type { CursorPath } from "./zooms";

/** A stretch of a recording, in its own time. */
export interface Span {
  startMs: number;
  endMs: number;
}

/** What a recording's pauses were heard in: `PauseSound` in src-tauri/src/recording_suggest.rs. */
export type { PauseSound };

/** Why a stretch is proposed. */
export type CutReason = "pause" | "idle";

/** One proposed cut, in its recording's time. */
export interface CutProposal {
  id: string;
  /** The clip of the sequence it cuts: a recording can be in more than one. */
  clipId: string;
  source: string;
  startMs: number;
  endMs: number;
  reason: CutReason;
}

/** How proposals are tuned: the panel's Minimum cut and Keep padding. */
export interface CutTuning {
  /** The shortest cut proposed, after its padding is kept. */
  minCutMs: number;
  /** How much of a pause is kept at each end of a cut. */
  padMs: number;
}

/** A tuning control's range and where it starts each time the panel opens. */
export interface TuningRange {
  min: number;
  max: number;
  step: number;
  initial: number;
}

/** How quiet sound must be to count as a pause, in dBFS: the range `recording_pauses` accepts. */
export const NOISE_DB_RANGE: TuningRange = { min: -60, max: -20, step: 1, initial: -40 };
/** The shortest cut proposed. The lowest is the shortest pause `recording_pauses` reports. */
export const MIN_CUT_RANGE: TuningRange = { min: 500, max: 5000, step: 100, initial: 1200 };
/** How much of a pause is kept at each end of a cut. */
export const PAD_RANGE: TuningRange = { min: 0, max: 500, step: 50, initial: 250 };
/** The tuning each opening of the panel starts from. */
export const INITIAL_TUNING: CutTuning = { minCutMs: MIN_CUT_RANGE.initial, padMs: PAD_RANGE.initial };
/** How long the pointer must stay still to count as idle in a silent recording. */
export const MIN_IDLE_MS = 2000;
/** How far, as a share of the frame, the pointer may drift and still count as still. */
export const STILL_DRIFT = 0.01;

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** `spans` that are well formed, sorted, and with overlaps merged. */
export function cleanSpans(spans: readonly Span[]): Span[] {
  const sorted = spans
    .filter((span) => isNum(span.startMs) && isNum(span.endMs) && span.startMs >= 0 && span.endMs > span.startMs)
    .map((span) => ({ startMs: Math.round(span.startMs), endMs: Math.round(span.endMs) }))
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1] as Span | undefined;
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * The stretches the pointer stays within `STILL_DRIFT` of where it was
 * for at least `minMs`. Null without a pointer path. Give it the pointer
 * as recorded: the smoothed path comes to rest well after the pointer
 * stops and moves off before it moves, so a short rest would be lost.
 */
export function stillSpans(cursor: CursorPath | null, minMs: number = MIN_IDLE_MS): Span[] | null {
  if (!cursor || cursor.fps <= 0 || cursor.points.length === 0) return null;
  const frameMs = 1000 / cursor.fps;
  const spans: Span[] = [];
  let from = 0;
  const close = (to: number) => {
    const span = { startMs: Math.round(from * frameMs), endMs: Math.round(to * frameMs) };
    if (span.endMs - span.startMs >= minMs) spans.push(span);
  };
  for (let index = 1; index < cursor.points.length; index++) {
    const [x, y] = cursor.points[index];
    const [ax, ay] = cursor.points[from];
    if (Math.hypot(x - ax, y - ay) > STILL_DRIFT) {
      close(index - 1);
      from = index;
    }
  }
  close(cursor.points.length - 1);
  return spans;
}

/** Where `a` and `b`, both sorted and clean, overlap. */
export function intersect(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const startMs = Math.max(a[i].startMs, b[j].startMs);
    const endMs = Math.min(a[i].endMs, b[j].endMs);
    if (endMs > startMs) out.push({ startMs, endMs });
    if (a[i].endMs < b[j].endMs) i++;
    else j++;
  }
  return out;
}

/**
 * The cuts proposed for recording `source`, played by `clips`: its
 * `pauses` where the pointer, as recorded (`cursor`), stays still for at least `tuning.minCutMs` (all
 * of them without a pointer path), or, with no sound to pause (`sound` is silent or system sound
 * only), the stretches the pointer is idle. Each keeps `tuning.padMs` at both
 * ends, lies inside one clip of `source`, leaves that clip at least
 * `MIN_CLIP_MS` either side or not at all, and is at least `tuning.minCutMs`.
 */
export function proposeCuts(clips: readonly Clip[], source: string, sound: PauseSound, pauses: readonly Span[], cursor: CursorPath | null, tuning: CutTuning): CutProposal[] {
  const { minCutMs, padMs } = tuning;
  const audible = sound === "microphone" || sound === "mixed";
  // Over a pause the pointer need only rest as long as a cut; alone it must rest longer.
  const still = stillSpans(cursor, audible ? minCutMs : MIN_IDLE_MS);
  let candidates: Span[];
  let reason: CutReason;
  if (audible) {
    candidates = still ? intersect(cleanSpans(pauses), cleanSpans(still)) : cleanSpans(pauses);
    reason = "pause";
  } else {
    candidates = still ?? [];
    reason = "idle";
  }
  const proposals: CutProposal[] = [];
  for (const clip of clips) {
    if (isGap(clip) || clip.source !== source) continue;
    for (const span of candidates) {
      let startMs = Math.max(span.startMs + padMs, clip.startMs);
      let endMs = Math.min(span.endMs - padMs, clip.endMs);
      // What is left either side must be a clip, or nothing at all.
      if (startMs > clip.startMs && startMs - clip.startMs < MIN_CLIP_MS) continue;
      if (endMs < clip.endMs && clip.endMs - endMs < MIN_CLIP_MS) continue;
      if (startMs === clip.startMs && endMs === clip.endMs) continue;
      startMs = Math.round(startMs);
      endMs = Math.round(endMs);
      if (endMs - startMs < minCutMs) continue;
      proposals.push({ id: `${clip.id}:${startMs}`, clipId: clip.id, source, startMs, endMs, reason });
    }
  }
  return proposals;
}

/** A proposal as the clip track shows it while Suggest edits is open: hatched, ticked or not. */
export interface ShownCut extends CutProposal {
  chosen: boolean;
}

/** The cut a clip may take: where, in which recording, and on which clip. */
type CutPlace = Span & { source: string; clipId: string };

/** Whether clip `clip` plays the whole of `cut`. */
const holds = (clip: Clip, cut: CutPlace) => !isGap(clip) && clip.source === cut.source && cut.endMs > cut.startMs && cut.startMs >= clip.startMs && cut.endMs <= clip.endMs;

/** The index of the clip `cut` was proposed on, while it still plays the whole cut; else -1. */
const clipIndexOf = (clips: readonly Clip[], cut: CutPlace, ids: ReadonlySet<string> = new Set([cut.clipId])) =>
  clips.findIndex((clip) => ids.has(clip.id) && holds(clip, cut));

/** Whether `cut` still lies inside the clip it was proposed on. */
export function isValidCut(clips: readonly Clip[], cut: CutPlace): boolean {
  return clipIndexOf(clips, cut) >= 0;
}

/**
 * `clips` without each of `cuts` (a ripple delete of each stretch from
 * the clip it was proposed on, or from what is left of that clip once an
 * earlier cut split it). A cut that no longer lies inside its clip is
 * skipped; so is one that would remove the last stretch that plays a
 * recording.
 */
export function applyCuts(clips: readonly Clip[], cuts: readonly CutProposal[], makeId: () => string = newClipId): Clip[] {
  let next = [...clips];
  /** For each proposed-on clip, the ids of it and the parts it was split into. */
  const parts = new Map<string, Set<string>>();
  const sorted = [...cuts].sort((a, b) => a.startMs - b.startMs);
  for (const cut of sorted) {
    const ids = parts.get(cut.clipId) ?? new Set([cut.clipId]);
    const index = clipIndexOf(next, cut, ids);
    if (index < 0) continue;
    const clip = next[index];
    const kept: Clip[] = [];
    if (cut.startMs > clip.startMs) kept.push({ ...clip, endMs: cut.startMs });
    if (cut.endMs < clip.endMs) kept.push({ ...clip, id: kept.length > 0 ? makeId() : clip.id, startMs: cut.endMs });
    const replaced = [...next.slice(0, index), ...kept, ...next.slice(index + 1)];
    if (!replaced.some((each) => !isGap(each))) continue;
    for (const part of kept) ids.add(part.id);
    parts.set(cut.clipId, ids);
    next = replaced;
  }
  return mergeGaps(next);
}

/**
 * `timeline` without each of `cuts`, as `applyCuts` cuts the sequence,
 * with linked sound cut along and later clips on every track shifted
 * back (see `cutSpan`). A cut that overlaps a clip not linked to the
 * picture it removes is counted in `skipped`; a cut affecting a locked
 * track is counted in `locked`. Other refusals follow `applyCuts`.
 */
export function applyTimelineCuts(timeline: Timeline, cuts: readonly CutProposal[], makeId: () => string = newClipId): { timeline: Timeline; skipped: number; locked: number } {
  let next = timeline;
  let skipped = 0;
  let locked = 0;
  // Latest first, so each earlier cut's clip keeps its id and its time.
  const placed = cuts.map((cut) => ({ cut, at: cutSequenceMs(timeline.main, cut) })).filter((each) => each.at !== null) as { cut: CutProposal; at: number }[];
  for (const { cut } of placed.sort((a, b) => b.at - a.at)) {
    const at = cutSequenceMs(next.main, cut);
    if (at === null) continue;
    const result = cutSpan(next, at, at + clipLength(cut), makeId);
    if (!isRefusal(result)) next = result;
    else if (result.overlap) skipped += 1;
    else if (result.locked) locked += 1;
  }
  return { timeline: next, skipped, locked };
}

/** Where `cut` begins on the sequence `clips` play, or null when its clip no longer holds it. */
export function cutSequenceMs(clips: readonly Clip[], cut: CutPlace): number | null {
  const index = clipIndexOf(clips, cut);
  return index < 0 ? null : clipStarts([...clips])[index] + cut.startMs - clips[index].startMs;
}

/** How long `cuts` take together. */
export const cutsLength = (cuts: readonly Span[]) => cuts.reduce((sum, cut) => sum + clipLength(cut), 0);

/** What the editor says a recording's sound is, for the audio auditions. */
export function soundLabel(sound: PauseSound): string {
  switch (sound) {
    case "microphone":
      return "Microphone recorded on its own: Original and Cleaned can be compared.";
    case "mixed":
      return "Microphone not recorded on its own: only the original can be played.";
    case "system":
      return "System sound only: cuts follow the pointer.";
    case "silent":
      return "Silent recording: cuts follow the pointer.";
  }
}

/** Why a proposal was made, as the list shows it. */
export function reasonLabel(reason: CutReason): string {
  return reason === "pause" ? "Quiet pause with the pointer still" : "Pointer idle";
}
