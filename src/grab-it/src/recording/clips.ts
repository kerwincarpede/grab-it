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
 * `trim`, so a sidecar older builds read stays readable by them. A
 * sequence holding a gap, a stretch with no clip, is written as version 3,
 * which builds without gaps refuse and so never write over. Month-qualified
 * sources are written as version 4.
 *
 * In memory a gap is a `Clip` with `gap: true`, no source, and `endMs` its
 * length from a `startMs` of 0, so lengths and sequence times work for
 * both; the sidecar holds it as `{id, gapMs}`.
 */
import { MIN_CLIP_MS, TRACKS_VERSION, isWhole, trimOf, versionForEdits, type RecordingEdits } from "./edits";
import type { Zoom } from "./zooms";

export interface Clip {
  id: string;
  /** The recording's reference within `recordings/`; empty for a gap. */
  source: string;
  /** The stretch kept, in its recording's time; for a gap, 0 and its length. */
  startMs: number;
  endMs: number;
  /** Set on a gap: the backdrop with a black video box, and silence. */
  gap?: true;
  /** Clips sharing a link are edited together (see tracks.ts); from `TRACKS_VERSION`. */
  link?: string;
}

/** Whether `clip` is a gap rather than a stretch of a recording. */
export const isGap = (clip: Clip) => clip.gap === true;

/** A gap `ms` long. */
export const gapOf = (id: string, ms: number): Clip => ({ id, source: "", startMs: 0, endMs: Math.max(1, Math.round(ms)), gap: true });

/** The clips that play a recording, without the gaps. */
export const sourceClips = (clips: Clip[]) => clips.filter((clip) => !isGap(clip));

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
 * Neighbouring gaps are merged.
 */
export function parseClips(value: unknown, version: RecordingEdits["version"] = 2): Clip[] {
  if (!Array.isArray(value)) return [];
  const clips: Clip[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const clip = entry as Record<string, unknown>;
    if (typeof clip.id !== "string" || !clip.id || ids.has(clip.id)) continue;
    if ("gapMs" in clip) {
      if (version < 3 || !isNum(clip.gapMs) || clip.gapMs <= 0) continue;
      ids.add(clip.id);
      clips.push(gapOf(clip.id, clip.gapMs));
      continue;
    }
    if (typeof clip.source !== "string" || !isClipSource(clip.source, version)) continue;
    if (!isNum(clip.startMs) || !isNum(clip.endMs) || clip.startMs < 0 || clip.endMs <= clip.startMs) continue;
    ids.add(clip.id);
    const kept: Clip = { id: clip.id, source: clip.source, startMs: Math.round(clip.startMs), endMs: Math.round(clip.endMs) };
    if (version >= TRACKS_VERSION && typeof clip.link === "string" && clip.link) kept.link = clip.link;
    clips.push(kept);
  }
  // A sequence of gaps alone has nothing to play.
  return sourceClips(clips).length > 0 ? mergeGaps(clips) : [];
}

/** A source path as supported by this edits version (versions 4 and later take month folders). */
export function isClipSource(source: string, version: RecordingEdits["version"]): boolean {
  if (version < 4) return source !== "" && source !== ".." && !/[\\/]/.test(source);
  return !source.includes("\0") && /^(?:\d{4}-(?:0[1-9]|1[0-2])\/)?[^/\\]+\.mp4$/i.test(source);
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
 * version 1 trim (none when it keeps all `ownDurationMs`), a sequence with
 * a gap as version 3 `clips`, and month-qualified sources as version 4.
 */
export function withClips(edits: RecordingEdits, clips: Clip[], own: string, ownDurationMs: number): RecordingEdits {
  const rest = { ...edits };
  delete rest.clips;
  delete rest.trim;
  delete rest.tracks;
  if (clips.length === 1 && clips[0].source === own && !isGap(clips[0])) {
    const { startMs, endMs } = clips[0];
    const trim = { startMs, endMs };
    return { ...rest, version: versionForEdits(null, rest.zooms, { captions: rest.captions }), ...(isWhole(trim, ownDurationMs) ? {} : { trim }) };
  }
  return { ...rest, version: versionForEdits(clips, rest.zooms, { captions: rest.captions }), clips };
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
  return mergeGaps([...rest.slice(0, target), clips[from], ...rest.slice(target)]);
}

/**
 * Where clip `id` is in `next`, the result of `moveClip` to index `to`. A
 * gap moved up against a gap before it merges into that one, which keeps
 * its id: then the index is that merged gap's.
 */
export function movedIndex(next: Clip[], id: string, to: number): number {
  const index = next.findIndex((clip) => clip.id === id);
  if (index >= 0) return index;
  return clamp(to - 1, 0, next.length - 1);
}

/** `clips` with each run of neighbouring gaps made one, keeping the first's id. */
export function mergeGaps(clips: Clip[]): Clip[] {
  const merged: Clip[] = [];
  for (const clip of clips) {
    const last = merged[merged.length - 1] as Clip | undefined;
    if (last && isGap(last) && isGap(clip)) merged[merged.length - 1] = gapOf(last.id, clipLength(last) + clipLength(clip));
    else merged.push(clip);
  }
  return merged.length === clips.length && merged.every((clip, index) => clip === clips[index]) ? clips : merged;
}

/** Whether clip `id` may be deleted: a gap always, a clip unless it is the last that plays a recording. */
export function canRemove(clips: Clip[], id: string): boolean {
  const clip = clips.find((each) => each.id === id);
  if (!clip) return false;
  return isGap(clip) || sourceClips(clips).length > 1;
}

/**
 * `clips` without clip `id`, closing the stretch it took (a ripple
 * delete). The last clip that plays a recording is never removed.
 */
export function removeClip(clips: Clip[], id: string): Clip[] {
  if (!canRemove(clips, id)) return clips;
  return mergeGaps(clips.filter((clip) => clip.id !== id));
}

/**
 * `clips` with clip `id` replaced by a gap of its length, so later clips
 * stay where they were. Neighbouring gaps merge; a gap is left as it is,
 * and the last clip that plays a recording is never removed.
 */
export function leaveGap(clips: Clip[], id: string, gapId: string = newClipId()): Clip[] {
  const clip = clips.find((each) => each.id === id);
  if (!clip || isGap(clip) || !canRemove(clips, id)) return clips;
  return mergeGaps(clips.map((each) => (each.id === id ? gapOf(gapId, clipLength(clip)) : each)));
}

/**
 * Whether clip `index` can be split at `sourceMs` in its recording: each
 * part keeps at least `MIN_CLIP_MS`. A gap is never split.
 */
export function canSplit(clips: Clip[], index: number, sourceMs: number): boolean {
  const clip = clips[index] as Clip | undefined;
  if (!clip || isGap(clip)) return false;
  return sourceMs - clip.startMs >= MIN_CLIP_MS && clip.endMs - sourceMs >= MIN_CLIP_MS;
}

/**
 * `clips` with clip `index` split at `sourceMs` into two clips of its
 * recording that meet there: the first keeps its id. Unchanged when
 * `canSplit` is false.
 */
export function splitClip(clips: Clip[], index: number, sourceMs: number, secondId: string = newClipId()): Clip[] {
  if (!canSplit(clips, index, sourceMs)) return clips;
  const clip = clips[index];
  const at = Math.round(sourceMs);
  return [...clips.slice(0, index), { ...clip, endMs: at }, { ...clip, id: secondId, startMs: at }, ...clips.slice(index + 1)];
}

/** `clips` with a copy of clip `id`, under a new id, right after it. A gap is not copied. */
export function duplicateClip(clips: Clip[], id: string, copyId: string = newClipId()): Clip[] {
  const index = clips.findIndex((clip) => clip.id === id);
  if (index < 0 || isGap(clips[index])) return clips;
  return insertClip(clips, index, { ...clips[index], id: copyId });
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
