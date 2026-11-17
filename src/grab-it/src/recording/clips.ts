/**
 * The joined sequence: recordings from the recordings folder played one
 * after another, each cut to a stretch of its own time.
 *
 * A clip's times are in its source recording. The sequence's time starts
 * each clip at the sum of the earlier clips' kept lengths; `toSource` and
 * `toSequence` map between the two. Later timeline, sound and overlay work
 * addresses media by (source, ms) and clips by id.
 *
 * The sidecar holds `clips` (version 2) only when the sequence is not a
 * single clip of its own recording; otherwise it keeps the version 1
 * `trim`, so a sidecar older builds read stays readable by them.
 */
import { MIN_CLIP_MS, isWhole, trimOf, type RecordingEdits } from "./edits";
import type { Zoom } from "./zooms";

export interface Clip {
  id: string;
  /** The file name of its recording, in `<save folder>/recordings/`. */
  source: string;
  /** The stretch kept, in its recording's time. */
  startMs: number;
  endMs: number;
}

/** Where a sequence time falls: the clip, its index, and the time in its recording. */
export interface ClipAt {
  index: number;
  clip: Clip;
  sourceMs: number;
}

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

let nextClipId = 0;
export function newClipId(): string {
  nextClipId += 1;
  return `c${Date.now().toString(36)}${nextClipId.toString(36)}`;
}

/**
 * Reads the sidecar's `clips`: an entry that is not understood is dropped
 * on its own, and so is a second clip with an id already taken.
 */
export function parseClips(value: unknown): Clip[] {
  if (!Array.isArray(value)) return [];
  const clips: Clip[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const clip = entry as Record<string, unknown>;
    if (typeof clip.id !== "string" || !clip.id || ids.has(clip.id)) continue;
    if (typeof clip.source !== "string" || !clip.source || /[\\/]/.test(clip.source)) continue;
    if (!isNum(clip.startMs) || !isNum(clip.endMs) || clip.startMs < 0 || clip.endMs <= clip.startMs) continue;
    ids.add(clip.id);
    clips.push({ id: clip.id, source: clip.source, startMs: Math.round(clip.startMs), endMs: Math.round(clip.endMs) });
  }
  return clips;
}

/**
 * The sequence a sidecar holds: its `clips`, else one clip of its own
 * recording `own` (`ownDurationMs` long) cut by its trim.
 */
export function clipsOf(edits: RecordingEdits, own: string, ownDurationMs: number): Clip[] {
  if (edits.clips && edits.clips.length > 0) return edits.clips;
  const trim = trimOf(edits, ownDurationMs);
  return [{ id: "own", source: own, ...trim }];
}

/**
 * `edits` holding `clips`: a single clip of `own` is written as the
 * version 1 trim (none when it keeps all `ownDurationMs`), anything else
 * as version 2 `clips`.
 */
export function withClips(edits: RecordingEdits, clips: Clip[], own: string, ownDurationMs: number): RecordingEdits {
  const rest = { ...edits };
  delete rest.clips;
  delete rest.trim;
  if (clips.length === 1 && clips[0].source === own) {
    const { startMs, endMs } = clips[0];
    const trim = { startMs, endMs };
    return { ...rest, version: 1, ...(isWhole(trim, ownDurationMs) ? {} : { trim }) };
  }
  return { ...rest, version: 2, clips };
}

/** How long a clip plays. */
export const clipLength = (clip: Pick<Clip, "startMs" | "endMs">) => Math.max(0, clip.endMs - clip.startMs);

/** Where each clip starts in the sequence. */
export function clipStarts(clips: Clip[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const clip of clips) {
    starts.push(at);
    at += clipLength(clip);
  }
  return starts;
}

/** How long the whole sequence plays. */
export const sequenceDuration = (clips: Clip[]) => clips.reduce((sum, clip) => sum + clipLength(clip), 0);

/**
 * The clip playing at sequence time `ms` and the time in its recording.
 * A time on the line between two clips belongs to the later one; past the
 * end gives the last clip's end. Null for no clips.
 */
export function toSource(clips: Clip[], ms: number): ClipAt | null {
  if (clips.length === 0) return null;
  let start = 0;
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index];
    const length = clipLength(clip);
    if (ms < start + length || index === clips.length - 1) {
      return { index, clip, sourceMs: clamp(clip.startMs + ms - start, clip.startMs, clip.endMs) };
    }
    start += length;
  }
  return null;
}

/** The sequence time of `sourceMs` in clip `index`, kept inside that clip. */
export function toSequence(clips: Clip[], index: number, sourceMs: number): number {
  const clip = clips[index] as Clip | undefined;
  if (!clip) return 0;
  return clipStarts(clips)[index] + clamp(sourceMs, clip.startMs, clip.endMs) - clip.startMs;
}

/** Whether `zoom` is on `clip`'s recording (an untagged zoom is on `own`). */
export const zoomOnSource = (zoom: Zoom, source: string, own: string) => (zoom.source ?? own) === source;

/**
 * The zooms that show in `clip`: those on its recording that reach into
 * its kept stretch. One outside it stays saved but is hidden.
 */
export function zoomsIn(zooms: Zoom[], clip: Clip, own: string): Zoom[] {
  return zooms.filter((zoom) => zoomOnSource(zoom, clip.source, own) && zoom.endMs > clip.startMs && zoom.startMs < clip.endMs);
}

/** `zoom` tagged with `source`, untagged when that is the sidecar's own recording. */
export function tagZoom(zoom: Zoom, source: string, own: string): Zoom {
  const rest = { ...zoom };
  delete rest.source;
  return source === own ? rest : { ...rest, source };
}

/** `clips` with `clip` added after index `after` (-1 puts it first). */
export function insertClip(clips: Clip[], after: number, clip: Clip): Clip[] {
  const at = clamp(after + 1, 0, clips.length);
  return [...clips.slice(0, at), clip, ...clips.slice(at)];
}

/** `clips` with clip `id` moved to index `to`. */
export function moveClip(clips: Clip[], id: string, to: number): Clip[] {
  const from = clips.findIndex((clip) => clip.id === id);
  if (from < 0) return clips;
  const target = clamp(to, 0, clips.length - 1);
  if (target === from) return clips;
  const rest = clips.filter((clip) => clip.id !== id);
  return [...rest.slice(0, target), clips[from], ...rest.slice(target)];
}

/** `clips` without clip `id`; the last clip is never removed. */
export function removeClip(clips: Clip[], id: string): Clip[] {
  if (clips.length <= 1) return clips;
  return clips.filter((clip) => clip.id !== id);
}

/**
 * Moves one edge of clip `id` to `ms` in its recording, which is
 * `sourceDurationMs` long, keeping at least `MIN_CLIP_MS` (or all of a
 * shorter recording).
 */
export function trimClip(clips: Clip[], id: string, edge: "start" | "end", ms: number, sourceDurationMs: number): Clip[] {
  const duration = Math.max(0, Math.round(sourceDurationMs));
  const shortest = Math.min(MIN_CLIP_MS, duration);
  return clips.map((clip) => {
    if (clip.id !== id) return clip;
    return edge === "start"
      ? { ...clip, startMs: Math.round(clamp(ms, 0, clip.endMs - shortest)) }
      : { ...clip, endMs: Math.round(clamp(ms, clip.startMs + shortest, duration)) };
  });
}

/** A file name, without folders, as the sidecar holds it. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Where a `sourceWidth` × `sourceHeight` recording sits inside a
 * `boxWidth` × `boxHeight` video box: as large as fits, centred, with
 * black bars on the other sides. Sides are whole and even so the export
 * can encode them.
 */
export function fitInside(sourceWidth: number, sourceHeight: number, boxWidth: number, boxHeight: number): { x: number; y: number; width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0, width: boxWidth, height: boxHeight };
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const even = (side: number, most: number) => Math.min(most, Math.max(2, Math.round((side * scale) / 2) * 2));
  const width = even(sourceWidth, boxWidth);
  const height = even(sourceHeight, boxHeight);
  return { x: Math.floor((boxWidth - width) / 2), y: Math.floor((boxHeight - height) / 2), width, height };
}

/**
 * Which clip shows each zoom: the first that holds it (see `zoomsIn`),
 * when a recording is in the sequence more than once. The preview and
 * the export both give a zoom to that clip only.
 */
export function zoomOwners(clips: Clip[], zooms: Zoom[], own: string): Map<string, number> {
  const owners = new Map<string, number>();
  clips.forEach((clip, index) => {
    for (const zoom of zoomsIn(zooms, clip, own)) if (!owners.has(zoom.id)) owners.set(zoom.id, index);
  });
  return owners;
}
