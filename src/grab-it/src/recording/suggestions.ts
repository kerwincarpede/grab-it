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
import { MIN_CLIP_MS } from "./edits";
import { clipLength, clipStarts, isGap, mergeGaps, newClipId, type Clip } from "./clips";
import type { CursorPath } from "./zooms";

/** A stretch of a recording, in its own time. */
export interface Span {
  startMs: number;
  endMs: number;
}

/** What a recording's pauses were heard in. Mirrors `PauseSound` in src-tauri/src/recording_suggest.rs. */
export type PauseSound = "microphone" | "mixed" | "system" | "silent";

/** Why a stretch is proposed. */
export type CutReason = "pause" | "idle";

/** One proposed cut, in its recording's time. */
export interface CutProposal {
  id: string;
  source: string;
  startMs: number;
  endMs: number;
  reason: CutReason;
}

/** The shortest pause worth proposing a cut for. */
export const MIN_CUT_MS = 1200;
/** How much of a pause is kept at each end of a cut. */
export const CUT_PAD_MS = 250;
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
 * for at least `minMs`. Null without a pointer path.
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
 * `pauses` where the pointer stays still for at least `MIN_CUT_MS` (all
 * of them without a pointer path), or, with no sound to pause (`sound` is silent or system sound
 * only), the stretches the pointer is idle. Each keeps `CUT_PAD_MS` at both
 * ends, lies inside one clip of `source`, leaves that clip at least
 * `MIN_CLIP_MS` either side or not at all, and is at least `MIN_CUT_MS`.
 */
export function proposeCuts(clips: readonly Clip[], source: string, sound: PauseSound, pauses: readonly Span[], cursor: CursorPath | null): CutProposal[] {
  const audible = sound === "microphone" || sound === "mixed";
  // Over a pause the pointer need only rest as long as a cut; alone it must rest longer.
  const still = stillSpans(cursor, audible ? MIN_CUT_MS : MIN_IDLE_MS);
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
      let startMs = Math.max(span.startMs + CUT_PAD_MS, clip.startMs);
      let endMs = Math.min(span.endMs - CUT_PAD_MS, clip.endMs);
      // What is left either side must be a clip, or nothing at all.
      if (startMs > clip.startMs && startMs - clip.startMs < MIN_CLIP_MS) continue;
      if (endMs < clip.endMs && clip.endMs - endMs < MIN_CLIP_MS) continue;
      if (startMs === clip.startMs && endMs === clip.endMs) continue;
      startMs = Math.round(startMs);
      endMs = Math.round(endMs);
      if (endMs - startMs < MIN_CUT_MS) continue;
      proposals.push({ id: `${clip.id}:${startMs}`, source, startMs, endMs, reason });
    }
  }
  return proposals;
}

/** Whether `cut` still lies inside one clip of `clips` that plays its recording. */
export function isValidCut(clips: readonly Clip[], cut: Span & { source: string }): boolean {
  return cut.endMs > cut.startMs && clips.some((clip) => !isGap(clip) && clip.source === cut.source && cut.startMs >= clip.startMs && cut.endMs <= clip.endMs);
}

/**
 * `clips` without each of `cuts` (a ripple delete of each stretch). A cut
 * that no longer lies inside a clip is skipped; so is one that would
 * remove the last stretch that plays a recording.
 */
export function applyCuts(clips: readonly Clip[], cuts: readonly CutProposal[], makeId: () => string = newClipId): Clip[] {
  let next = [...clips];
  const sorted = [...cuts].sort((a, b) => a.startMs - b.startMs);
  for (const cut of sorted) {
    const index = next.findIndex((clip) => !isGap(clip) && clip.source === cut.source && cut.startMs >= clip.startMs && cut.endMs <= clip.endMs && cut.endMs > cut.startMs);
    if (index < 0) continue;
    const clip = next[index];
    const parts: Clip[] = [];
    if (cut.startMs > clip.startMs) parts.push({ ...clip, endMs: cut.startMs });
    if (cut.endMs < clip.endMs) parts.push({ ...clip, id: parts.length > 0 ? makeId() : clip.id, startMs: cut.endMs });
    const replaced = [...next.slice(0, index), ...parts, ...next.slice(index + 1)];
    if (!replaced.some((each) => !isGap(each))) continue;
    next = replaced;
  }
  return mergeGaps(next);
}

/** Where `cut` begins on the sequence `clips` play, or null when no clip holds it. */
export function cutSequenceMs(clips: readonly Clip[], cut: Span & { source: string }): number | null {
  const starts = clipStarts([...clips]);
  const index = clips.findIndex((clip) => !isGap(clip) && clip.source === cut.source && cut.startMs >= clip.startMs && cut.endMs <= clip.endMs);
  return index < 0 ? null : starts[index] + cut.startMs - clips[index].startMs;
}

/** How long `cuts` take together. */
export const cutsLength = (cuts: readonly Span[]) => cuts.reduce((sum, cut) => sum + clipLength(cut), 0);

/** What the editor says a recording's sound is, for the audio auditions. */
export function soundLabel(sound: PauseSound): string {
  switch (sound) {
    case "microphone":
      return "Microphone recorded on its own: Original and Cleaned can be compared.";
    case "mixed":
      return "Microphone and system sound recorded together: only the original can be played.";
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
