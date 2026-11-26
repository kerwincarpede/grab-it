/**
 * Named video and audio tracks, which #199, #200 and #201 extend.
 *
 * The sidecar's `tracks` (edits `TRACKS_VERSION`) lists every track top first:
 * `{id, name, kind: "video" | "audio", locked?, clips}`. Video 1, the main
 * track, holds the joined sequence in order (clips with an optional `link`
 * and no `atMs`, and `{id, gapMs}` gaps); `tracks` replaces `clips` and
 * `trim`. Every other track places clips freely, `{id, source, startMs,
 * endMs, atMs, link?}`, never overlapping on one track. Video 1 and Audio 1
 * always exist.
 *
 * Clips sharing a `link` sit at the same timeline times and are moved,
 * trimmed, split, duplicated and deleted together. A recording's sound is
 * one clip on an audio track linked to its picture; video clips are silent.
 *
 * In memory the main sequence stays `RecordingEdits.clips` (see clips.ts),
 * so a `Timeline` is that sequence plus the tracks, whose Video 1 entry
 * keeps no clips of its own.
 *
 * Versions 1 to 4 load as Video 1 plus an Audio 1 clip linked to and
 * aligned with each main clip whose recording has sound. `tracks` is
 * written only when something differs from that: an extra track, an
 * unaligned or unlinked clip, a lock or a rename.
 */
import { clipLength, clipStarts, isClipSource, isGap, mergeGaps, newClipId, parseClips, sourceClips, withClips, type Clip } from "./clips";
import { MIN_CLIP_MS, TRACKS_VERSION, versionForEdits, type RecordingEdits } from "./edits";

export type TrackKind = "video" | "audio";

/** A clip placed freely on a track other than Video 1. */
export interface PlacedClip {
  id: string;
  /** Its recording's reference within `recordings/`. */
  source: string;
  /** The stretch kept, in its recording's time. */
  startMs: number;
  endMs: number;
  /** Where it starts on the timeline. */
  atMs: number;
  /** Clips sharing a link are edited together; absent when unlinked. */
  link?: string;
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  /** Kept as saved so a file round-trips; this build edits no lock. */
  locked?: boolean;
  /** Empty for Video 1, whose clips are the timeline's `main`. */
  clips: PlacedClip[];
}

/** The main sequence (Video 1's clips) and every track, top first. */
export interface Timeline {
  main: Clip[];
  tracks: Track[];
}

export const MAIN_TRACK_ID = "video-1";
export const FIRST_AUDIO_ID = "audio-1";

/** The sidecar's first version with `tracks`, defined in edits.ts. */
export { TRACKS_VERSION };

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const isMain = (track: Pick<Track, "id">) => track.id === MAIN_TRACK_ID;
export const mainTrack = (timeline: Timeline) => timeline.tracks.find(isMain) as Track;
export const placedEnd = (clip: PlacedClip) => clip.atMs + clipLength(clip);

/** The link an Audio 1 clip loaded from a version 1 to 4 sidecar shares with main clip `id`. */
export const defaultLink = (id: string) => `link-${id}`;
/** The id of that Audio 1 clip. */
export const defaultSoundId = (id: string) => `${id}-sound`;

/**
 * The timeline older sidecars and a fresh recording load as: Video 1 and
 * Audio 1, which holds each main clip's sound (where `hasAudio`) linked
 * to it at the same time.
 */
export function defaultTimeline(main: Clip[], hasAudio: (source: string) => boolean): Timeline {
  const starts = clipStarts(main);
  const linked: Clip[] = [];
  const sound: PlacedClip[] = [];
  main.forEach((clip, index) => {
    if (isGap(clip) || !hasAudio(clip.source)) {
      const rest = { ...clip };
      delete rest.link;
      linked.push(rest);
      return;
    }
    const link = defaultLink(clip.id);
    linked.push({ ...clip, link });
    sound.push({ id: defaultSoundId(clip.id), source: clip.source, startMs: clip.startMs, endMs: clip.endMs, atMs: starts[index], link });
  });
  return {
    main: linked,
    tracks: [
      { id: MAIN_TRACK_ID, name: "Video 1", kind: "video", clips: [] },
      { id: FIRST_AUDIO_ID, name: "Audio 1", kind: "audio", clips: sound },
    ],
  };
}

/**
 * The timeline `edits` hold: its `tracks` when saved (`TRACKS_VERSION`), else the
 * default for its sequence `main` (see `clipsOf`).
 */
export function timelineOf(edits: RecordingEdits, main: Clip[], hasAudio: (source: string) => boolean): Timeline {
  if (edits.tracks && edits.tracks.length > 0) return withRequiredTracks({ main, tracks: edits.tracks });
  return defaultTimeline(main, hasAudio);
}

/** `timeline` with Video 1 and Audio 1 put back when missing. */
function withRequiredTracks(timeline: Timeline): Timeline {
  let tracks = timeline.tracks;
  if (!tracks.some(isMain)) {
    const firstAudio = tracks.findIndex((track) => track.kind === "audio");
    const at = firstAudio < 0 ? tracks.length : firstAudio;
    tracks = [...tracks.slice(0, at), { id: MAIN_TRACK_ID, name: "Video 1", kind: "video", clips: [] }, ...tracks.slice(at)];
  }
  if (!tracks.some((track) => track.kind === "audio")) tracks = [...tracks, { id: FIRST_AUDIO_ID, name: "Audio 1", kind: "audio", clips: [] }];
  return tracks === timeline.tracks ? timeline : { ...timeline, tracks };
}

/**
 * `edits` holding `timeline`: as `withClips` writes the sequence when the
 * timeline is the default it loads as, else with `tracks` (`TRACKS_VERSION`).
 */
export function withTimeline(edits: RecordingEdits, timeline: Timeline, own: string, ownDurationMs: number, hasAudio: (source: string) => boolean): RecordingEdits {
  if (!needsTracks(timeline, hasAudio)) {
    const main = timeline.main.map((clip) => {
      const rest = { ...clip };
      delete rest.link;
      return rest;
    });
    return withClips(edits, main, own, ownDurationMs);
  }
  const rest = { ...edits };
  delete rest.trim;
  return { ...rest, clips: timeline.main, tracks: timeline.tracks, version: versionForEdits(timeline.main, rest.zooms, { tracks: timeline.tracks, captions: rest.captions }) };
}

/** Whether `timeline` differs from the default its sequence loads as, so it needs `tracks` saved. */
export function needsTracks(timeline: Timeline, hasAudio: (source: string) => boolean): boolean {
  const plain = timeline.main.map((clip) => {
    const rest = { ...clip };
    delete rest.link;
    return rest;
  });
  const expected = defaultTimeline(plain, hasAudio);
  return JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(timeline));
}

/** Links renamed to the order they first appear in, so equal shapes compare equal. */
function normalize(timeline: Timeline): unknown {
  const names = new Map<string, string>();
  const name = (link?: string) => {
    if (link === undefined) return undefined;
    if (!names.has(link)) names.set(link, `l${names.size}`);
    return names.get(link);
  };
  return {
    main: timeline.main.map((clip) => ({ ...clip, link: name(clip.link) })),
    tracks: timeline.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      locked: track.locked === true,
      clips: [...track.clips].sort((a, b) => a.atMs - b.atMs).map((clip) => ({ source: clip.source, startMs: clip.startMs, endMs: clip.endMs, atMs: clip.atMs, link: name(clip.link) })),
    })),
  };
}

/**
 * Reads the sidecar's `tracks` (`TRACKS_VERSION`): the main sequence and the
 * tracks. A track or clip that is not understood is dropped on its own,
 * and so is a clip overlapping one before it on its track or reusing an
 * id. Null when there is no Video 1 sequence to play.
 */
export function parseTracks(value: unknown, version: RecordingEdits["version"]): Timeline | null {
  if (version < TRACKS_VERSION || !Array.isArray(value)) return null;
  const tracks: Track[] = [];
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  let main: Clip[] | null = null;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id || trackIds.has(raw.id)) continue;
    if (raw.kind !== "video" && raw.kind !== "audio") continue;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : raw.id;
    const track: Track = { id: raw.id, name, kind: raw.kind, clips: [], ...(raw.locked === true ? { locked: true } : {}) };
    if (isMain(track)) {
      if (track.kind !== "video") continue;
      main = parseClips(raw.clips, version).filter((clip) => !clipIds.has(clip.id));
      for (const clip of main) clipIds.add(clip.id);
    } else {
      track.clips = parsePlaced(raw.clips, version, clipIds);
    }
    trackIds.add(track.id);
    tracks.push(track);
  }
  if (!main || sourceClips(main).length === 0) return null;
  return withRequiredTracks({ main, tracks });
}

function parsePlaced(value: unknown, version: RecordingEdits["version"], ids: Set<string>): PlacedClip[] {
  if (!Array.isArray(value)) return [];
  const clips: PlacedClip[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const clip = entry as Record<string, unknown>;
    if (typeof clip.id !== "string" || !clip.id || ids.has(clip.id)) continue;
    if (typeof clip.source !== "string" || !isClipSource(clip.source, version)) continue;
    if (!isNum(clip.startMs) || !isNum(clip.endMs) || !isNum(clip.atMs) || clip.startMs < 0 || clip.endMs <= clip.startMs || clip.atMs < 0) continue;
    const placed: PlacedClip = { id: clip.id, source: clip.source, startMs: Math.round(clip.startMs), endMs: Math.round(clip.endMs), atMs: Math.round(clip.atMs) };
    if (typeof clip.link === "string" && clip.link) placed.link = clip.link;
    if (clips.some((other) => overlaps(other, placed))) continue;
    ids.add(placed.id);
    clips.push(placed);
  }
  return clips.sort((a, b) => a.atMs - b.atMs);
}

const overlaps = (a: PlacedClip, b: PlacedClip) => a.atMs < placedEnd(b) && b.atMs < placedEnd(a);

/** The sidecar's `tracks`: Video 1 holds `main` as the sequence, gaps as `{id, gapMs}`. */
export function serializeTracks(timeline: Timeline): unknown[] {
  return timeline.tracks.map((track) => ({
    id: track.id,
    name: track.name,
    kind: track.kind,
    ...(track.locked ? { locked: true } : {}),
    clips: isMain(track)
      ? timeline.main.map((clip) =>
          isGap(clip)
            ? { id: clip.id, gapMs: Math.round(clipLength(clip)) }
            : { id: clip.id, source: clip.source, startMs: Math.round(clip.startMs), endMs: Math.round(clip.endMs), ...(clip.link ? { link: clip.link } : {}) },
        )
      : track.clips.map((clip) => ({
          id: clip.id,
          source: clip.source,
          startMs: Math.round(clip.startMs),
          endMs: Math.round(clip.endMs),
          atMs: Math.round(clip.atMs),
          ...(clip.link ? { link: clip.link } : {}),
        })),
  }));
}

/** Where a clip of the timeline sits: its track and its timeline span. */
export interface ClipPlace {
  trackId: string;
  id: string;
  atMs: number;
  endMs: number;
  link?: string;
}

/** Every clip (gaps left out) with its timeline span. */
export function clipPlaces(timeline: Timeline): ClipPlace[] {
  const starts = clipStarts(timeline.main);
  const places: ClipPlace[] = [];
  timeline.main.forEach((clip, index) => {
    if (!isGap(clip)) places.push({ trackId: MAIN_TRACK_ID, id: clip.id, atMs: starts[index], endMs: starts[index] + clipLength(clip), link: clip.link });
  });
  for (const track of timeline.tracks) {
    if (isMain(track)) continue;
    for (const clip of track.clips) places.push({ trackId: track.id, id: clip.id, atMs: clip.atMs, endMs: placedEnd(clip), link: clip.link });
  }
  return places;
}

/** Clip `id` and every clip linked to it. */
export function linkedIds(timeline: Timeline, id: string): Set<string> {
  const places = clipPlaces(timeline);
  const link = places.find((place) => place.id === id)?.link;
  const ids = new Set([id]);
  if (link) for (const place of places) if (place.link === link) ids.add(place.id);
  return ids;
}

/**
 * Gives the selected clips one new link. Linked clips sit at the same
 * timeline times: clips off Video 1 move to the start of the Video 1 clip
 * among them, or else of the earliest of them. Null when fewer than two
 * clips are selected, more than one is on Video 1, or that move would put
 * a clip over another.
 */
export function linkClips(timeline: Timeline, ids: ReadonlySet<string>, link: string = `link-${newClipId()}`): Timeline | null {
  const found = clipPlaces(timeline).filter((place) => ids.has(place.id));
  if (found.length < 2) return null;
  const onMain = found.filter((place) => place.trackId === MAIN_TRACK_ID);
  if (onMain.length > 1) return null;
  const linked = mapClips(timeline, ids, (clip) => ({ ...clip, link }));
  if (onMain.length === 1) return realign(linked);
  const at = Math.min(...found.map((place) => place.atMs));
  const tracks = linked.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => (ids.has(clip.id) ? { ...clip, atMs: at } : clip)).sort((a, b) => a.atMs - b.atMs) }));
  return tracks.some(hasOverlap) ? null : { ...linked, tracks };
}

/** Whether two clips of `track` overlap. */
const hasOverlap = (track: Track) => track.clips.some((clip, index) => index > 0 && overlaps(track.clips[index - 1], clip));

/** Clears the links of the selected clips and of everything linked to them. */
export function unlinkClips(timeline: Timeline, ids: ReadonlySet<string>): Timeline {
  const all = new Set<string>();
  for (const id of ids) for (const each of linkedIds(timeline, id)) all.add(each);
  return mapClips(timeline, all, (clip) => {
    const rest = { ...clip };
    delete rest.link;
    return rest;
  });
}

function mapClips(timeline: Timeline, ids: ReadonlySet<string>, change: <T extends Clip | PlacedClip>(clip: T) => T): Timeline {
  return {
    main: timeline.main.map((clip) => (ids.has(clip.id) ? change(clip) : clip)),
    tracks: timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => (ids.has(clip.id) ? change(clip) : clip)) })),
  };
}

/**
 * Puts each clip linked to a main clip at that clip's sequence time, after
 * the sequence changed. Null when that leaves two clips overlapping on a
 * track.
 */
export function realign(timeline: Timeline): Timeline | null {
  const starts = clipStarts(timeline.main);
  const at = new Map<string, number>();
  timeline.main.forEach((clip, index) => {
    if (clip.link) at.set(clip.link, starts[index]);
  });
  const tracks = timeline.tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => (clip.link && at.has(clip.link) ? { ...clip, atMs: at.get(clip.link) as number } : clip)).sort((a, b) => a.atMs - b.atMs),
  }));
  for (const track of tracks) for (let i = 1; i < track.clips.length; i++) if (overlaps(track.clips[i - 1], track.clips[i])) return null;
  return { ...timeline, tracks };
}

/** Why a move was refused. */
/** How far before the timeline's end a moved clip starts at the latest. */
export const END_MARGIN_MS = 100;

/** Why an edit was refused; `overlap` when it would cut into sound not linked to the picture it removes. */
export type Refusal = { refused: string; overlap?: true };
export const isRefusal = <T extends object>(value: T | Refusal): value is Refusal => "refused" in value;

/**
 * Moves clip `id` (not on Video 1) and its links by the same amount so it
 * starts at `atMs`, onto `toTrack` when given (of the same kind), and
 * with `endMs`, the timeline's end, kept starting `END_MARGIN_MS` before
 * it so it stays in sight. Refused when a link is on Video 1, a track is
 * locked, or a clip would overlap.
 */
export function moveInTime(timeline: Timeline, id: string, atMs: number, toTrack?: string, endMs?: number): Timeline | Refusal {
  const places = clipPlaces(timeline);
  const place = places.find((each) => each.id === id);
  if (!place) return { refused: "That clip is no longer on the timeline." };
  const ids = linkedIds(timeline, id);
  if (places.some((each) => ids.has(each.id) && each.trackId === MAIN_TRACK_ID)) return { refused: "Unlink it from its picture on Video 1 first." };
  const locked = lockedIds(timeline);
  if (places.some((each) => ids.has(each.id) && locked.has(each.trackId))) return { refused: "Its track is locked." };
  const from = timeline.tracks.find((track) => track.id === place.trackId) as Track;
  const target = toTrack ? timeline.tracks.find((track) => track.id === toTrack) : from;
  if (!target || isMain(target) || target.kind !== from.kind) return { refused: "A clip moves only between tracks of its own kind." };
  if (locked.has(target.id)) return { refused: "That track is locked." };
  const wanted = endMs === undefined ? Math.round(atMs) : Math.min(Math.round(atMs), Math.max(0, endMs - END_MARGIN_MS));
  const delta = Math.max(wanted - place.atMs, -Math.min(...places.filter((each) => ids.has(each.id)).map((each) => each.atMs)));
  const tracks = timeline.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => !(clip.id === id && track.id !== target.id)) }));
  const moved = from.clips.find((clip) => clip.id === id) as PlacedClip;
  for (const track of tracks) {
    if (track.id === target.id && !track.clips.some((clip) => clip.id === id)) track.clips = [...track.clips, moved];
    track.clips = track.clips.map((clip) => (ids.has(clip.id) ? { ...clip, atMs: clip.atMs + delta } : clip)).sort((a, b) => a.atMs - b.atMs);
    for (let i = 1; i < track.clips.length; i++) if (overlaps(track.clips[i - 1], track.clips[i])) return { refused: "It would overlap another clip on that track." };
  }
  return { ...timeline, tracks };
}

/** Clips with room on both sides, unless an intersected partner is too short. */
function splittableIds(timeline: Timeline, at: number, only: string | undefined, minMs: number): Set<string> {
  const selected = only ? linkedIds(timeline, only) : null;
  const blockedLinks = new Set<string>();
  const locked = lockedIds(timeline);
  const candidates = clipPlaces(timeline).filter((place) => (!selected || selected.has(place.id)) && place.atMs < at && at < place.endMs);
  const fits = (place: ClipPlace) => !locked.has(place.trackId) && at - place.atMs >= minMs && place.endMs - at >= minMs;
  for (const place of candidates) {
    if (place.link && !fits(place)) blockedLinks.add(place.link);
  }
  return new Set(candidates.filter((place) => fits(place) && (!place.link || !blockedLinks.has(place.link))).map((place) => place.id));
}

/** Whether a Split at this time would cut any clips. */
export function canSplitAt(timeline: Timeline, ms: number, only?: string): boolean {
  return splittableIds(timeline, Math.round(ms), only, MIN_CLIP_MS).size > 0;
}

/**
 * Splits at timeline time `ms`: with `only` set, that clip and its links;
 * otherwise every clip there on an unlocked track. Second parts take new
 * ids, and the second parts of one link group share a new link. Each part
 * keeps at least `minMs`; a clip that cannot is left whole with its links.
 */
export function splitAt(timeline: Timeline, ms: number, only?: string, minMs: number = MIN_CLIP_MS, makeId: () => string = newClipId): Timeline {
  const at = Math.round(ms);
  const ids = splittableIds(timeline, at, only, minMs);
  if (ids.size === 0) return timeline;
  const splitPartners = new Map<string, number>();
  for (const place of clipPlaces(timeline)) {
    if (place.link && ids.has(place.id)) splitPartners.set(place.link, (splitPartners.get(place.link) ?? 0) + 1);
  }
  const links = new Map<string, string>();
  const nextLink = (link?: string) => {
    if (!link || (splitPartners.get(link) ?? 0) < 2) return undefined;
    if (!links.has(link)) links.set(link, `link-${makeId()}`);
    return links.get(link);
  };
  const starts = clipStarts(timeline.main);
  const main: Clip[] = [];
  timeline.main.forEach((clip, index) => {
    if (!ids.has(clip.id)) {
      main.push(clip);
      return;
    }
    const cut = clip.startMs + at - starts[index];
    const second: Clip = { ...clip, id: makeId(), startMs: cut };
    const link = nextLink(clip.link);
    if (link) second.link = link;
    else delete second.link;
    main.push({ ...clip, endMs: cut }, second);
  });
  const tracks = timeline.tracks.map((track) => ({
    ...track,
    clips: track.clips.flatMap((clip) => {
      if (!ids.has(clip.id)) return [clip];
      const cut = clip.startMs + at - clip.atMs;
      const second: PlacedClip = { ...clip, id: makeId(), startMs: cut, atMs: at };
      const link = nextLink(clip.link);
      if (link) second.link = link;
      else delete second.link;
      return [{ ...clip, endMs: cut }, second];
    }),
  }));
  return { main, tracks };
}

/**
 * Removes timeline stretch `startMs`-`endMs` from every track and
 * shifts what follows back by its length (a ripple). Refused when it
 * overlaps a clip off Video 1 that is not linked to a main clip
 * the stretch also cuts, or would leave nothing that plays a recording.
 */
export function cutSpan(timeline: Timeline, startMs: number, endMs: number, makeId: () => string = newClipId): Timeline | Refusal {
  const start = Math.round(startMs);
  const end = Math.round(endMs);
  if (end <= start) return timeline;
  const split = splitAt(splitAt(timeline, start, undefined, 1, makeId), end, undefined, 1, makeId);
  const places = clipPlaces(split);
  const inside = (place: ClipPlace) => place.atMs >= start && place.endMs <= end;
  const cutLinks = new Set(places.filter((place) => place.trackId === MAIN_TRACK_ID && inside(place) && place.link).map((place) => place.link as string));
  for (const place of places) {
    if (place.trackId === MAIN_TRACK_ID) continue;
    const touches = place.atMs < end && place.endMs > start;
    if (!touches) continue;
    if (!place.link) return { refused: "It would cut into sound that is not linked to the picture being removed. Move it or link it first.", overlap: true };
    if (!inside(place) || !cutLinks.has(place.link)) return { refused: "It would cut into a clip linked to another picture. Unlink or move it first.", overlap: true };
  }
  const length = end - start;
  const starts = clipStarts(split.main);
  const main = mergeGaps(split.main.filter((clip, index) => !(starts[index] >= start && starts[index] + clipLength(clip) <= end)));
  if (sourceClips(main).length === 0) return { refused: "That would remove every clip." };
  const tracks = split.tracks.map((track) =>
    isMain(track)
      ? track
      : {
          ...track,
          clips: track.clips.filter((clip) => !(clip.atMs >= start && placedEnd(clip) <= end)).map((clip) => (clip.atMs >= end ? { ...clip, atMs: clip.atMs - length } : clip)),
        },
  );
  return { main, tracks };
}

/**
 * Ripple-deletes clip `id` and its links. A main clip's or gap's stretch
 * is cut from every track (see `cutSpan`); a clip off Video 1 with no
 * link there is removed and later clips on its own track close up.
 */
export function rippleDelete(timeline: Timeline, id: string, makeId: () => string = newClipId): Timeline | Refusal {
  const places = clipPlaces(timeline);
  const ids = linkedIds(timeline, id);
  const onMain = places.find((place) => ids.has(place.id) && place.trackId === MAIN_TRACK_ID);
  if (onMain) return cutSpan(timeline, onMain.atMs, onMain.endMs, makeId);
  // A gap's stretch closes on every track, as a clip's does.
  const gapIndex = timeline.main.findIndex((clip) => clip.id === id && isGap(clip));
  if (gapIndex >= 0) {
    const start = clipStarts(timeline.main)[gapIndex];
    return cutSpan(timeline, start, start + clipLength(timeline.main[gapIndex]), makeId);
  }
  const place = places.find((each) => each.id === id);
  if (!place) return timeline;
  const length = place.endMs - place.atMs;
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.filter((clip) => !ids.has(clip.id)).map((clip) => (track.id === place.trackId && clip.atMs >= place.endMs ? { ...clip, atMs: clip.atMs - length } : clip)),
    })),
  };
}

/** The nearest target within the snap radius, including an exact match. */
function snapTarget(ms: number, targets: readonly number[], pxPerMs: number, thresholdPx: number): number | undefined {
  if (pxPerMs <= 0) return undefined;
  let best: number | undefined;
  let bestPx = thresholdPx;
  for (const target of targets) {
    const px = Math.abs(target - ms) * pxPerMs;
    if (px <= bestPx) {
      best = target;
      bestPx = px;
    }
  }
  return best;
}

/** Where a drag lands: `ms` pulled to the nearest of `targets` within `thresholdPx`, unless `enabled` is false. */
export function snapMs(ms: number, targets: readonly number[], pxPerMs: number, enabled: boolean = true, thresholdPx: number = 8): number {
  return enabled ? (snapTarget(ms, targets, pxPerMs, thresholdPx) ?? ms) : ms;
}

/** What drags snap to: 0, the playhead and every clip edge, leaving out the clips in `except`. */
export function snapTargets(timeline: Timeline, playheadMs: number, except: ReadonlySet<string> = new Set()): number[] {
  const targets = new Set([0, Math.round(playheadMs)]);
  for (const place of clipPlaces(timeline)) {
    if (except.has(place.id)) continue;
    targets.add(place.atMs);
    targets.add(place.endMs);
  }
  return [...targets].sort((a, b) => a - b);
}

/**
 * Where a clip `lengthMs` long dragged to start at `atMs` lands: whichever
 * of its edges is nearer a target snaps, unless `enabled` is false (Shift).
 */
export function snapClip(atMs: number, lengthMs: number, targets: readonly number[], pxPerMs: number, enabled: boolean = true): number {
  if (!enabled) return Math.max(0, atMs);
  const start = snapTarget(atMs, targets, pxPerMs, 8);
  const end = snapTarget(atMs + lengthMs, targets, pxPerMs, 8);
  const endAligned = end === undefined ? undefined : end - lengthMs;
  if (start === undefined) return Math.max(0, endAligned ?? atMs);
  if (endAligned === undefined || Math.abs(start - atMs) <= Math.abs(endAligned - atMs)) return Math.max(0, start);
  return Math.max(0, endAligned);
}

/** Every clip on an audio track, as the export plan's `audio` mixes them. */
export function exportAudio(timeline: Timeline): { source: string; startMs: number; endMs: number; atMs: number }[] {
  return timeline.tracks
    .filter((track) => track.kind === "audio")
    .flatMap((track) => track.clips.map(({ source, startMs, endMs, atMs }) => ({ source, startMs, endMs, atMs })))
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * `timeline` after an edit of the main sequence alone made `next` (a
 * trim, reorder, duplicate, insert or delete from clips.ts): linked sound
 * follows its picture. A link no main clip keeps loses its clips off
 * Video 1 only when it was on Video 1; a trimmed edge trims linked clips
 * by the same amount, the picture too, clamped so each keeps
 * `MIN_CLIP_MS` and stays inside its recording (`durationOf` its source,
 * when known); a copied clip (a second main clip with a link
 * already used) gets copies of its linked clips under a new link; a new
 * clip whose recording `hasAudio` gets its sound on the first audio track
 * with room, or a new one. Null when linked sound would overlap.
 */
export function reconcile(
  timeline: Timeline,
  next: Clip[],
  hasAudio: (source: string) => boolean,
  makeId: () => string = newClipId,
  durationOf: (source: string) => number = () => 0,
): Timeline | null {
  const before = new Map(timeline.main.map((clip) => [clip.id, clip]));
  const mainLinks = new Set(timeline.main.flatMap((clip) => (clip.link ? [clip.link] : [])));
  const seen = new Set<string>();
  const main: Clip[] = [];
  let tracks = timeline.tracks.map((track) => ({ ...track, clips: [...track.clips] }));
  const partnersOf = (link: string) => tracks.flatMap((track) => track.clips.filter((clip) => clip.link === link).map((clip) => ({ track, clip })));
  const added: Clip[] = [];
  for (const clip of next) {
    if (isGap(clip) || !clip.link) {
      main.push(clip);
      if (!isGap(clip) && !before.has(clip.id)) added.push(clip);
      continue;
    }
    const old = before.get(clip.id);
    if (seen.has(clip.link) || !old) {
      // A copy: its own link, and copies of what the original links.
      const link = `link-${makeId()}`;
      for (const { track, clip: partner } of partnersOf(clip.link)) track.clips.push({ ...partner, id: makeId(), link });
      main.push({ ...clip, link });
      seen.add(link);
      continue;
    }
    seen.add(clip.link);
    let startBy = clip.startMs - old.startMs;
    let endBy = clip.endMs - old.endMs;
    if (startBy !== 0 || endBy !== 0) {
      // The whole group moves its edge by the amount every one of them can.
      for (const { clip: partner } of partnersOf(clip.link)) {
        const shortest = Math.min(MIN_CLIP_MS, clipLength(partner));
        startBy = Math.min(Math.max(startBy, -partner.startMs), clipLength(partner) - shortest);
        const most = durationOf(partner.source);
        if (most > 0) endBy = Math.min(endBy, most - partner.endMs);
        endBy = Math.max(endBy, shortest - (clipLength(partner) - startBy));
      }
      const link = clip.link;
      tracks = tracks.map((track) => ({
        ...track,
        clips: track.clips.map((each) => (each.link === link ? { ...each, startMs: each.startMs + startBy, endMs: each.endMs + endBy } : each)),
      }));
      main.push({ ...clip, startMs: old.startMs + startBy, endMs: old.endMs + endBy });
      continue;
    }
    main.push(clip);
  }
  // Sound whose picture is gone goes with it.
  tracks = tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => !clip.link || !mainLinks.has(clip.link) || seen.has(clip.link)) }));
  let result = realign({ main, tracks });
  if (!result) return null;
  for (const clip of added) {
    if (!hasAudio(clip.source)) continue;
    const link = `link-${makeId()}`;
    const withLink: Clip[] = result.main.map((each) => (each.id === clip.id ? { ...each, link } : each));
    const at = clipStarts(withLink)[withLink.findIndex((each) => each.id === clip.id)];
    const sound: PlacedClip = { id: makeId(), source: clip.source, startMs: clip.startMs, endMs: clip.endMs, atMs: at, link };
    const free: Track | undefined = result.tracks.find((track) => track.kind === "audio" && !track.clips.some((each) => overlaps(each, sound)));
    const audioTracks = result.tracks.filter((track) => track.kind === "audio");
    const target: Track = free ?? { id: `audio-${makeId()}`, name: `Audio ${audioTracks.length + 1}`, kind: "audio", clips: [] };
    const placed = { ...target, clips: [...target.clips, sound].sort((a, b) => a.atMs - b.atMs) };
    result = { main: withLink, tracks: free ? result.tracks.map((track) => (track.id === target.id ? placed : track)) : [...result.tracks, placed] };
  }
  return result;
}

/**
 * Moves every unlinked clip off Video 1 back by `byMs`, as when one
 * recording's trim start moves on by `byMs`: its sound keeps playing at
 * the same moment of the recording. What would start before 0 is cut
 * there, and dropped when nothing is left.
 */
export function shiftUnlinked(timeline: Timeline, byMs: number): Timeline {
  if (byMs === 0) return timeline;
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.flatMap((clip) => {
        if (clip.link) return [clip];
        const at = clip.atMs - byMs;
        if (at >= 0) return [{ ...clip, atMs: at }];
        const startMs = clip.startMs - at;
        return startMs < clip.endMs ? [{ ...clip, startMs, atMs: 0 }] : [];
      }),
    })),
  };
}

/** Renames track `id`; an empty name keeps the old one. */
export function renameTrack(timeline: Timeline, id: string, name: string): Timeline {
  const trimmed = name.trim();
  if (!trimmed) return timeline;
  return { ...timeline, tracks: timeline.tracks.map((track) => (track.id === id ? { ...track, name: trimmed } : track)) };
}

/** Locks or unlocks track `id`. */
export function lockTrack(timeline: Timeline, id: string, locked: boolean): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => {
      if (track.id !== id) return track;
      const rest = { ...track };
      delete rest.locked;
      return locked ? { ...rest, locked: true } : rest;
    }),
  };
}

/** A new, empty track of `kind`: a video track goes on top, so it shows over the others; an audio track goes last. */
export function addTrack(timeline: Timeline, kind: TrackKind, makeId: () => string = newClipId): { timeline: Timeline; id: string } {
  const names = new Set(timeline.tracks.map((track) => track.name));
  let number = timeline.tracks.filter((track) => track.kind === kind).length + 1;
  const base = kind === "video" ? "Video" : "Audio";
  while (names.has(`${base} ${number}`)) number++;
  const track: Track = { id: `${kind}-${makeId()}`, name: `${base} ${number}`, kind, clips: [] };
  const tracks = kind === "video" ? [track, ...timeline.tracks] : [...timeline.tracks, track];
  return { timeline: { ...timeline, tracks }, id: track.id };
}

/** Removes track `id`; refused for Video 1, Audio 1 and a track that holds clips. */
export function removeTrack(timeline: Timeline, id: string): Timeline | Refusal {
  const track = timeline.tracks.find((each) => each.id === id);
  if (!track) return timeline;
  if (isMain(track) || track.id === FIRST_AUDIO_ID) return { refused: `${track.name} always stays.` };
  if (track.clips.length > 0) return { refused: `${track.name} still holds clips. Move or delete them first.` };
  return { ...timeline, tracks: timeline.tracks.filter((each) => each.id !== id) };
}

/** The ids of the locked tracks. */
const lockedIds = (timeline: Timeline) => new Set(timeline.tracks.filter((track) => track.locked).map((track) => track.id));

/** Whether clip `id` sits on a locked track, so it can't be selected or edited. */
export function isLockedClip(timeline: Timeline, id: string): boolean {
  const locked = lockedIds(timeline);
  return clipPlaces(timeline).some((place) => place.id === id && locked.has(place.trackId));
}

/** The track clip `id` sits on. */
export const trackOf = (timeline: Timeline, id: string): Track | undefined => {
  if (timeline.main.some((clip) => clip.id === id)) return mainTrack(timeline);
  return timeline.tracks.find((track) => track.clips.some((clip) => clip.id === id));
};

/**
 * Places recording `source` (its stretch `startMs`-`endMs`) on extra video
 * track `trackId` at timeline time `atMs`. When the recording `hasAudio`,
 * its sound goes, linked, on the first unlocked audio track with room, or
 * a new one. Refused on Video 1, a locked track or over another clip.
 */
export function placeRecording(
  timeline: Timeline,
  trackId: string,
  clip: { source: string; startMs: number; endMs: number },
  atMs: number,
  hasAudio: (source: string) => boolean,
  makeId: () => string = newClipId,
): { timeline: Timeline; id: string } | Refusal {
  const track = timeline.tracks.find((each) => each.id === trackId);
  if (!track || isMain(track) || track.kind !== "video") return { refused: "Choose an extra video track to place the recording on." };
  if (track.locked) return { refused: `${track.name} is locked.` };
  const at = Math.max(0, Math.round(atMs));
  const sound = hasAudio(clip.source);
  const link = sound ? `link-${makeId()}` : undefined;
  const picture: PlacedClip = { id: makeId(), source: clip.source, startMs: Math.round(clip.startMs), endMs: Math.round(clip.endMs), atMs: at, ...(link ? { link } : {}) };
  if (track.clips.some((each) => overlaps(each, picture))) return { refused: `It would overlap another clip on ${track.name}.` };
  let tracks: Track[] = timeline.tracks.map((each) => (each.id === trackId ? { ...each, clips: [...each.clips, picture].sort((a, b) => a.atMs - b.atMs) } : each));
  let next: Timeline = { ...timeline, tracks };
  if (link) {
    const placed: PlacedClip = { ...picture, id: makeId() };
    const free = tracks.find((each) => each.kind === "audio" && !each.locked && !each.clips.some((other) => overlaps(other, placed)));
    if (free) tracks = tracks.map((each) => (each.id === free.id ? { ...each, clips: [...each.clips, placed].sort((a, b) => a.atMs - b.atMs) } : each));
    else {
      const added = addTrack(next, "audio", makeId);
      tracks = added.timeline.tracks.map((each) => (each.id === added.id ? { ...each, clips: [placed] } : each));
    }
    next = { ...timeline, tracks };
  }
  return { timeline: next, id: picture.id };
}

/** One video track's clips as timeline spans: Video 1's sequence, or a track's placed clips. */
function videoSpans(timeline: Timeline, track: Track): { atMs: number; clip: Clip }[] {
  if (isMain(track)) {
    const starts = clipStarts(timeline.main);
    return timeline.main.flatMap((clip, index) => (isGap(clip) ? [] : [{ atMs: starts[index], clip }]));
  }
  return track.clips.map((clip) => ({ atMs: clip.atMs, clip: { id: clip.id, source: clip.source, startMs: clip.startMs, endMs: clip.endMs } }));
}

/** Whether a video track other than Video 1 holds a clip, so the picture is no longer Video 1 alone. */
export const hasOverlay = (timeline: Timeline) => timeline.tracks.some((track) => track.kind === "video" && !isMain(track) && track.clips.length > 0);

/**
 * The picture every video track makes, as one sequence of clips and gaps
 * (what `ExportPlan.clips` holds): at each moment the highest video track
 * with a clip there shows; where none has one is a gap. It ends with the
 * last video clip. Pieces keep their clip's id, the later pieces of one
 * clip taking `<id>@<ms>`. A timeline with only Video 1 gives `main` back.
 */
export function flattenPicture(timeline: Timeline): Clip[] {
  if (!hasOverlay(timeline)) return timeline.main;
  const layers = timeline.tracks.filter((track) => track.kind === "video").map((track) => videoSpans(timeline, track));
  const edges = new Set<number>();
  for (const layer of layers) for (const span of layer) {
    edges.add(span.atMs);
    edges.add(span.atMs + clipLength(span.clip));
  }
  const sorted = [...edges].sort((a, b) => a - b);
  const out: Clip[] = [];
  let lastClip: { id: string; endAt: number } | null = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    let found: { atMs: number; clip: Clip } | undefined;
    for (const layer of layers) {
      found = layer.find((span) => span.atMs <= from && span.atMs + clipLength(span.clip) >= to);
      if (found) break;
    }
    const hit = found;
    const prev = out[out.length - 1];
    if (!hit) {
      if (from === 0 || out.length > 0) {
        if (prev && isGap(prev)) prev.endMs += to - from;
        else out.push({ id: `gap@${from}`, source: "", startMs: 0, endMs: to - from, gap: true });
      }
      lastClip = null;
      continue;
    }
    const startMs = hit.clip.startMs + (from - hit.atMs);
    if (prev && !isGap(prev) && lastClip && lastClip.id === hit.clip.id && lastClip.endAt === from) {
      prev.endMs = startMs + (to - from);
    } else {
      const used = out.some((clip) => clip.id === hit.clip.id);
      out.push({ id: used ? `${hit.clip.id}@${from}` : hit.clip.id, source: hit.clip.source, startMs, endMs: startMs + (to - from) });
    }
    lastClip = { id: hit.clip.id, endAt: to };
  }
  // A leading stretch with no clip is a gap from 0.
  const first = sorted[0] ?? 0;
  if (first > 0) out.unshift({ id: "gap@0", source: "", startMs: 0, endMs: first, gap: true });
  while (out.length > 0 && isGap(out[out.length - 1])) out.pop();
  return out;
}
