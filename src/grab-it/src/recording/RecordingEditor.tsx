import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "../editor/editor.css";
import "./recording.css";
import { MAX_BACKDROP_PRESETS } from "../settings/api";
import { chooseBackdropImage, saveBackdropPresetImage } from "../editor/api";
import BackdropPanel from "../editor/BackdropPanel";
import { BackdropIcon, ExportIcon, RedoIcon, TrashIcon, UndoIcon, ZoomInIcon } from "../editor/icons";
import { canRedo, canUndo, commit, initHistory, redo, undo, type History } from "../editor/history";
import { BACKDROP_FILLS, type Backdrop } from "../editor/model";
import { presetName } from "../editor/preferences";
import { newId } from "../editor/tools";
import { useBackdropImage } from "../editor/useBackdropImage";
import type { BackdropSources } from "../editor/flatten";
import {
  exportRecording,
  fetchRecording,
  onExportProgress,
  playsFromBlob,
  recordingInfo,
  recordingSource,
  saveEdits,
  videoSrc,
  type AudioKind,
  type ExportClip,
  type ExportProgress,
  type RecordingInfo,
  type RecordingSource,
} from "./api";
import {
  clipLength,
  clipStarts,
  clipsOf,
  fileNameOf,
  fitInside,
  insertClip,
  moveClip,
  newClipId,
  removeClip,
  sequenceDuration,
  tagZoom,
  toSequence,
  toSource,
  withClips,
  zoomOnSource,
  zoomOwners,
  zoomsIn,
  type Clip,
  type ClipAt,
} from "./clips";
import ClipTrack from "./ClipTrack";
import { chooseRecording, folderOf, isIn, probeVideo, type SourceMeta } from "./sources";
import { clampTrim, emptyEdits, formatTime, isWhole, parseEdits, serializeEdits, trimOf, type RecordingEdits, type Trim } from "./edits";
import { exportLayers, paintUnderlay, recordingLayout } from "./layout";
import { useBackdropPresets } from "./useBackdropPresets";
import Timeline from "./Timeline";
import ZoomAreaPicker from "./ZoomAreaPicker";
import ZoomTrack from "./ZoomTrack";
import {
  addZoom,
  clampCentre,
  cursorAt,
  FULL_VIEW,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_MS,
  MIN_ZOOM_SCALE,
  removeZoom,
  updateZoom,
  viewAt,
  viewTransform,
  zoomLabel,
  ZOOM_SCALE_STEP,
  type Zoom,
  type ZoomFocus,
} from "./zooms";

type SaveStatus = "idle" | "saving" | "saved" | "error";

const errorText = (err: unknown) => String(err instanceof Error ? err.message : err);
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const AddIcon = () => (
  <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const PlayIcon = () => (
  <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M7 4.5v15l12.5-7.5z" />
  </svg>
);

const PauseIcon = () => (
  <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <rect x="6" y="4.5" width="4" height="15" rx="1" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" />
  </svg>
);

/** Whether a key press belongs to a field or control rather than the window. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches("input, textarea, select, button, [role='slider']") || target.isContentEditable;
}

/** Whether a key press edits text in a field, where Undo and Redo belong to the field. */
function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.matches("textarea, select")) return true;
  return target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "color", "file"].includes(target.type);
}

/** Whether `clips` is more than one clip of the recording `own`: then the timeline is the joined sequence's. */
const isJoined = (clips: Clip[], own: string) => clips.length > 1 || (clips.length === 1 && clips[0].source !== own);

/**
 * Where timeline time `ms` falls. Joined, the timeline is the sequence;
 * otherwise it is the opened recording's own time, cut by its trim.
 */
function positionIn(clips: Clip[], own: string, ms: number): ClipAt | null {
  if (clips.length === 0) return null;
  if (!isJoined(clips, own)) return { index: 0, clip: clips[0], sourceMs: ms };
  return toSource(clips, ms);
}

/** The timeline time of `sourceMs` in clip `index`. */
function timelineMs(clips: Clip[], own: string, index: number, sourceMs: number): number {
  return isJoined(clips, own) ? toSequence(clips, index, sourceMs) : sourceMs;
}

/** How far clip `index` is shifted onto the timeline, and the stretch it takes there. */
function spanOf(clips: Clip[], own: string, index: number, ownDurationMs: number): { offset: number; low: number; high: number } {
  if (!isJoined(clips, own)) return { offset: 0, low: 0, high: ownDurationMs };
  const start = clipStarts(clips)[index] ?? 0;
  const clip = clips[index];
  return { offset: start - clip.startMs, low: start, high: start + clipLength(clip) };
}

/**
 * The URL the video plays `path` from: the grab-it-video scheme itself, or
 * on Linux a blob of the file fetched from it. Null while the blob is on
 * its way.
 *
 * Joined, the one preview plays several recordings in turn. Each one's blob
 * is fetched once and kept until the editor closes: revoking a blob when
 * the preview moves to another recording left WebKitGTK unable to load the
 * next one, and coming back would fetch the whole file again.
 */
function usePlayableSrc(path: string | null, onError: (message: string) => void): string | null {
  const blob = playsFromBlob();
  const [urls, setUrls] = useState<Record<string, string>>({});
  /** Paths fetched or on their way, and every blob URL made; read only in effects. */
  const fetching = useRef(new Set<string>());
  const made = useRef<string[]>([]);
  const closed = useRef(false);
  useEffect(() => {
    if (!path || !blob || fetching.current.has(path)) return;
    fetching.current.add(path);
    fetchRecording(videoSrc(path))
      .then((data) => {
        if (closed.current) return;
        const url = URL.createObjectURL(data);
        made.current.push(url);
        setUrls((known) => ({ ...known, [path]: url }));
      })
      .catch((err: unknown) => {
        fetching.current.delete(path);
        if (!closed.current) onError(`The recording cannot be played: ${errorText(err)}`);
      });
  }, [path, blob, onError]);
  useEffect(() => {
    closed.current = false;
    const all = made.current;
    const asked = fetching.current;
    return () => {
      closed.current = true;
      for (const url of all.splice(0)) URL.revokeObjectURL(url);
      asked.clear();
    };
  }, []);
  if (!path) return null;
  if (!blob) return videoSrc(path);
  return urls[path] ?? null;
}

/** Why a recording's sound shows as Mixed sound. */
const MIXED_SOUND_HINT = "This recording's microphone and system sound are mixed into one track, so they can only be edited together.";

const SOURCE_NAMES: Record<AudioKind, string> = {
  microphone: "Microphone",
  system: "System sound",
  mixed: "Mixed sound",
};

/** The status bar's line naming a recording's sound sources; nothing for a silent one. */
function SoundSources({ audio }: { audio: AudioKind[] }) {
  if (audio.length === 0) return null;
  if (audio.includes("mixed")) return <span title={MIXED_SOUND_HINT}>{SOURCE_NAMES.mixed}</span>;
  return <span>{audio.map((kind) => SOURCE_NAMES[kind]).join(" · ")}</span>;
}

function saveText(status: SaveStatus): string {
  switch (status) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Edits saved";
    case "error":
      return "Could not save edits";
    default:
      return "";
  }
}

/**
 * The recording editor: plays an MP4 recording on its backdrop, with a
 * timeline to trim its start and end and a row of zooms under it, and
 * exports the result as a new MP4 beside it. Edits are kept in `<recording>.edits.json` as they are made;
 * the recording itself is never changed.
 */
export default function RecordingEditor() {
  const [info, setInfo] = useState<RecordingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Every edit made in this window, one entry per commit; the present is what the sidecar holds. */
  const [history, setHistory] = useState<History<RecordingEdits>>(() => initHistory(emptyEdits()));
  const edits = history.present;
  /** A sidecar this version cannot read is never written over. */
  const [readOnly, setReadOnly] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** What each clip's recording is, by file name, once its metadata has loaded. */
  const [meta, setMeta] = useState<Record<string, SourceMeta>>({});
  /** The other recordings clips play, from `recording_source`. */
  const [sourceInfo, setSourceInfo] = useState<Record<string, RecordingSource>>({});
  /** Recordings that are gone or cannot be played; Export waits for them. */
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const requested = useRef(new Set<string>());
  const [clipDraft, setClipDraft] = useState<Clip[] | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  /** Where to put the video once the recording it switches to has loaded. */
  const pendingRef = useRef<{ sourceMs: number; play: boolean } | null>(null);
  /** The recording the video has loaded. */
  const loadedRef = useRef<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** Bumped when a new frame shows, so the blurred backdrop follows it. */
  const [frameTick, setFrameTick] = useState(0);

  const [trimDraft, setTrimDraft] = useState<Trim | null>(null);
  /** A backdrop still being dragged in the panel; undefined when none is. */
  const [backdropDraft, setBackdropDraft] = useState<Backdrop | null | undefined>(undefined);
  const [backdropOpen, setBackdropOpen] = useState(false);
  /** Zooms still being dragged; null when none are. */
  const [zoomDraft, setZoomDraft] = useState<Zoom[] | null>(null);
  const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const exporting = progress !== null;

  const presets = useBackdropPresets(setMessage);

  useEffect(() => {
    let cancelled = false;
    let loading: Promise<RecordingInfo>;
    try {
      loading = recordingInfo();
    } catch (err) {
      loading = Promise.reject(err);
    }
    loading
      .then((loaded) => {
        if (cancelled) return;
        setInfo(loaded);
        try {
          setHistory(initHistory(parseEdits(loaded.edits)));
        } catch (err) {
          setReadOnly(true);
          setMessage(`The edits cannot be read, so they will not be saved: ${errorText(err)}`);
        }
      })
      .catch((err: unknown) => !cancelled && setLoadError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const own = info?.fileName ?? "";
  const ownMeta = meta[own] as SourceMeta | undefined;
  /** The opened recording's length; it sets the output's size and frame rate whatever the order. */
  const durationMs = ownMeta?.durationMs ?? 0;
  const videoSize = useMemo(() => (ownMeta ? { width: ownMeta.width, height: ownMeta.height } : null), [ownMeta]);
  const backdrop = backdropDraft !== undefined ? backdropDraft : (edits.backdrop ?? null);
  const savedTrim = trimOf(edits, durationMs);
  const savedClips = useMemo(() => clipsOf(edits, own, durationMs), [edits, own, durationMs]);
  const clips = clipDraft ?? savedClips;
  const joined = isJoined(clips, own);
  const sequenceMs = sequenceDuration(clips);
  const timelineDuration = joined ? sequenceMs : durationMs;
  const at = positionIn(clips, own, currentMs);
  const currentSource = at?.clip.source ?? own;
  const pathOf = (source: string): string | null => (!info ? null : source === own ? info.path : (sourceInfo[source]?.path ?? null));
  const src = usePlayableSrc(pathOf(currentSource), setMessage);
  const currentMeta = meta[currentSource] as SourceMeta | undefined;
  const cursorOf = (source: string) => (source === own ? (info?.cursor ?? null) : (sourceInfo[source]?.cursor ?? null));
  const cursor = cursorOf(currentSource);
  const selectedClip = joined ? (clips.find((clip) => clip.id === selectedClipId) ?? null) : null;
  const missingClip = clips.find((clip) => missing.has(clip.source)) ?? null;
  /** Every clip's recording is there and its size known. */
  const canExport = !missingClip && clips.every((clip) => meta[clip.source] !== undefined);

  // Zooms keep their recording's time; the timeline shows each on its clip.
  const allZooms = useMemo(() => edits.zooms ?? [], [edits.zooms]);
  const shown = useMemo(() => {
    const list: Zoom[] = [];
    const owner = new Map<string, number>();
    clips.forEach((clip, index) => {
      const { offset, low, high } = spanOf(clips, own, index, durationMs);
      const mine = joined ? zoomsIn(allZooms, clip, own) : allZooms.filter((zoom) => zoomOnSource(zoom, own, own));
      for (const zoom of mine) {
        if (owner.has(zoom.id)) continue;
        owner.set(zoom.id, index);
        const startMs = joined ? Math.max(low, zoom.startMs + offset) : zoom.startMs;
        const endMs = joined ? Math.min(high, zoom.endMs + offset) : zoom.endMs;
        list.push({ ...zoom, startMs, endMs });
      }
    });
    return { list: list.sort((a, b) => a.startMs - b.startMs), owner };
  }, [clips, own, durationMs, joined, allZooms]);
  const zooms = zoomDraft ?? shown.list;
  const selectedZoom = zooms.find((zoom) => zoom.id === selectedZoomId) ?? null;
  const trim = joined ? { startMs: 0, endMs: sequenceMs } : (trimDraft ?? savedTrim);
  const layout = useMemo(() => (videoSize ? recordingLayout(videoSize, backdrop) : null), [videoSize, backdrop]);
  const backdropImageEl = useBackdropImage(backdrop?.fill === BACKDROP_FILLS.image ? (backdrop.image ?? null) : null);

  const save = useCallback(
    (next: RecordingEdits) => {
      if (readOnly) return;
      setSaveStatus("saving");
      let saving: Promise<void>;
      try {
        saving = saveEdits(serializeEdits(next));
      } catch (err) {
        saving = Promise.reject(err);
      }
      saving.then(() => setSaveStatus("saved")).catch(() => setSaveStatus("error"));
    },
    [readOnly],
  );

  /** One undo entry; an edit that leaves the sidecar as it was adds none. */
  const commitEdits = useCallback(
    (next: RecordingEdits) => {
      if (JSON.stringify(serializeEdits(next)) === JSON.stringify(serializeEdits(history.present))) return;
      setHistory(commit(history, next));
      save(next);
    },
    [history, save],
  );

  /** Moves the playhead to timeline time `ms` of `list`, switching recording when it must. */
  const seek = (ms: number, list: Clip[] = clips) => {
    const video = videoRef.current;
    setCurrentMs(ms);
    const pos = positionIn(list, own, ms);
    if (!pos) return;
    if (video && loadedRef.current === pos.clip.source && video.dataset.source === pos.clip.source) {
      try {
        video.currentTime = pos.sourceMs / 1000;
      } catch {
        // Not seekable yet: it opens at the start.
      }
    } else {
      pendingRef.current = { sourceMs: pos.sourceMs, play: pendingRef.current?.play ?? false };
    }
  };

  // --- Clips --------------------------------------------------------------

  // Each other recording a clip plays is looked up once: its path, pointer
  // path and size. One that is gone is marked missing.
  useEffect(() => {
    if (!info) return;
    const needed = new Set(clips.map((clip) => clip.source));
    // The opened recording sets the output: learn its size even when it does not play first.
    if (currentSource !== own) needed.add(own);
    for (const source of needed) {
      if (requested.current.has(source) || meta[source] || (source === currentSource && source === own)) continue;
      requested.current.add(source);
      const looking = source === own ? Promise.resolve(null) : recordingSource(source);
      looking
        .then(async (found) => {
          if (found) setSourceInfo((known) => ({ ...known, [source]: found }));
          const learned = await probeVideo(found?.path ?? info.path);
          setMeta((known) => ({ ...known, [source]: learned }));
        })
        .catch(() => setMissing((gone) => new Set(gone).add(source)));
    }
  }, [info, clips, own, currentSource, meta]);

  /** Keeps `next` as the sequence: one undo entry. */
  const commitClips = (next: Clip[]) => {
    setClipDraft(null);
    commitEdits(withClips(edits, next, own, durationMs));
  };

  const latestRef = useRef({ clips, at, commitClips, seek, meta });
  useEffect(() => {
    latestRef.current = { clips, at, commitClips, seek, meta };
  });

  /** Asks for a recording in the recordings folder and joins it after the clip under the playhead. */
  const addRecording = async () => {
    if (!info || exporting) return;
    const folder = folderOf(info.path);
    let picked: string | null;
    try {
      picked = await chooseRecording(folder);
    } catch (err) {
      setMessage(`Could not choose a recording: ${errorText(err)}`);
      return;
    }
    if (!picked) return;
    if (!isIn(picked, folder)) {
      setMessage("Only recordings in the recordings folder can be added.");
      return;
    }
    const name = fileNameOf(picked);
    try {
      const found = name === own ? null : await recordingSource(name);
      const learned = latestRef.current.meta[name] ?? (await probeVideo(found?.path ?? info.path));
      if (found) setSourceInfo((known) => ({ ...known, [name]: found }));
      setMeta((known) => ({ ...known, [name]: learned }));
      requested.current.add(name);
      setMissing((gone) => {
        if (!gone.has(name)) return gone;
        const left = new Set(gone);
        left.delete(name);
        return left;
      });
      const latest = latestRef.current;
      const after = latest.at?.index ?? latest.clips.length - 1;
      const clip: Clip = { id: newClipId(), source: name, startMs: 0, endMs: learned.durationMs };
      const next = insertClip(latest.clips, after, clip);
      latest.commitClips(next);
      setSelectedClipId(clip.id);
      setSelectedZoomId(null);
      setMessage(null);
      latest.seek(timelineMs(next, own, after + 1, 0), next);
    } catch (err) {
      setMessage(`Could not add ${name}: ${errorText(err)}`);
    }
  };

  const moveSelectedClip = (by: number) => {
    if (!selectedClip) return;
    const from = clips.findIndex((clip) => clip.id === selectedClip.id);
    const next = moveClip(clips, selectedClip.id, from + by);
    if (next === clips) return;
    commitClips(next);
    const index = next.findIndex((clip) => clip.id === selectedClip.id);
    seek(timelineMs(next, own, index, selectedClip.startMs), next);
  };

  const removeSelectedClip = () => {
    if (!selectedClip || clips.length <= 1) return;
    const index = clips.findIndex((clip) => clip.id === selectedClip.id);
    const next = removeClip(clips, selectedClip.id);
    commitClips(next);
    setSelectedClipId(null);
    const stay = Math.min(index, next.length - 1);
    seek(timelineMs(next, own, stay, next[stay].startMs), next);
  };

  const commitTrim = (next: Trim) => {
    setTrimDraft(null);
    const fitted = clampTrim(next, durationMs);
    commitEdits({ ...edits, trim: isWhole(fitted, durationMs) ? null : fitted });
    seek(Math.min(Math.max(currentMs, fitted.startMs), fitted.endMs));
  };

  // --- Undo ---------------------------------------------------------------

  /** Moves to `next` in the history, saves what it holds and keeps the playhead inside its trim. */
  const stepHistory = (next: History<RecordingEdits>) => {
    if (next === history || exporting) return;
    setTrimDraft(null);
    setBackdropDraft(undefined);
    setZoomDraft(null);
    setClipDraft(null);
    setHistory(next);
    save(next.present);
    if (durationMs > 0) {
      const nextClips = clipsOf(next.present, own, durationMs);
      if (isJoined(nextClips, own) || joined) {
        // The playhead stays where it was in the clip it was on, else goes to the start.
        const index = at ? nextClips.findIndex((clip) => clip.id === at.clip.id) : -1;
        if (index >= 0 && at) seek(timelineMs(nextClips, own, index, at.sourceMs), nextClips);
        else seek(timelineMs(nextClips, own, 0, nextClips[0].startMs), nextClips);
      } else {
        const kept = trimOf(next.present, durationMs);
        seek(Math.min(Math.max(currentMs, kept.startMs), kept.endMs), nextClips);
      }
    }
  };

  const undoEdit = () => stepHistory(undo(history));
  const redoEdit = () => stepHistory(redo(history));

  const commitBackdrop = (next: Backdrop | null) => {
    setBackdropDraft(undefined);
    commitEdits({ ...edits, backdrop: next });
  };

  // --- Zooms --------------------------------------------------------------

  /** Keeps `next`, the zooms as the timeline shows them, in their recordings' time. */
  const commitZooms = (next: Zoom[]) => {
    setZoomDraft(null);
    const before = new Map(shown.list.map((zoom) => [zoom.id, zoom]));
    const originals = new Map(allZooms.map((zoom) => [zoom.id, zoom]));
    const placed = next.flatMap((zoom): Zoom[] => {
      const index = shown.owner.get(zoom.id) ?? positionIn(clips, own, zoom.startMs)?.index ?? 0;
      const clip = clips[index];
      const { offset, low, high } = spanOf(clips, own, index, durationMs);
      const was = before.get(zoom.id);
      const original = originals.get(zoom.id);
      // Unmoved, it keeps its own times, even the part its clip hides.
      if (was && original && was.startMs === zoom.startMs && was.endMs === zoom.endMs) return [{ ...original, scale: zoom.scale, focus: zoom.focus }];
      const startMs = Math.max(low, zoom.startMs) - offset;
      const endMs = Math.min(high, zoom.endMs) - offset;
      if (endMs - startMs < Math.min(MIN_ZOOM_MS, high - low)) return [];
      return [tagZoom({ ...zoom, startMs, endMs }, clip.source, own)];
    });
    const kept = allZooms.filter((zoom) => !shown.owner.has(zoom.id));
    commitEdits({ ...edits, zooms: [...kept, ...placed].sort((a, b) => a.startMs - b.startMs) });
  };

  const canAddZoom = timelineDuration > 0 && addZoom(zooms, currentMs, timelineDuration) !== null;

  const addZoomAt = (ms: number) => {
    const added = addZoom(zooms, ms, timelineDuration);
    if (!added) {
      setMessage("There is no room for a zoom there.");
      return;
    }
    setMessage(null);
    commitZooms(added.zooms);
    setSelectedZoomId(added.zoom.id);
    seek(Math.min(Math.max(added.zoom.startMs + 1, trim.startMs), trim.endMs));
  };

  const setZoomFocus = (zoom: Zoom, kind: ZoomFocus["kind"]) => {
    if (zoom.focus.kind === kind) return;
    // An area starts where the pointer was, when that is known.
    const index = shown.owner.get(zoom.id) ?? at?.index ?? 0;
    const { offset } = spanOf(clips, own, index, durationMs);
    const [x, y] = clampCentre(cursorAt(cursorOf(clips[index]?.source ?? own), zoom.startMs - offset) ?? [0.5, 0.5], zoom.scale);
    commitZooms(updateZoom(zooms, zoom.id, { focus: kind === "cursor" ? { kind: "cursor" } : { kind: "area", x, y } }));
  };

  const setZoomScale = (zoom: Zoom, scale: number, keep: boolean) => {
    let next = updateZoom(zooms, zoom.id, { scale });
    // An area stays inside the frame at its new size.
    if (zoom.focus.kind === "area") {
      const [x, y] = clampCentre([zoom.focus.x, zoom.focus.y], scale);
      next = updateZoom(next, zoom.id, { focus: { kind: "area", x, y } });
    }
    if (keep) commitZooms(next);
    else setZoomDraft(next);
  };

  const deleteZoom = (zoom: Zoom) => {
    setSelectedZoomId(null);
    commitZooms(removeZoom(zooms, zoom.id));
  };

  const setZoomArea = (zoom: Zoom, x: number, y: number, keep: boolean) => {
    const next = updateZoom(zooms, zoom.id, { focus: { kind: "area", x, y } });
    if (keep) commitZooms(next);
    else setZoomDraft(next);
  };

  // --- Playback -----------------------------------------------------------

  const pause = () => {
    // A recording still loading for the next clip must not start once it has.
    if (pendingRef.current) pendingRef.current.play = false;
    videoRef.current?.pause();
    setPlaying(false);
  };

  /**
   * Whether the video stopping now is only a clip ending, joined, with
   * another clip after it: a clip that keeps its recording's end runs the
   * video to its own end (and its `ended` and `pause`) first, and loading
   * the next recording pauses it too.
   */
  const handingOn = () => {
    const now = playRef.current;
    const video = videoRef.current;
    if (!now.joined || !now.at || !video) return false;
    if (pendingRef.current) return pendingRef.current.play;
    return now.at.index < now.clips.length - 1 && (video.ended || video.currentTime * 1000 >= now.at.clip.endMs);
  };

  const play = () => {
    const video = videoRef.current;
    if (!video) return;
    if (joined) {
      // From the first clip when at (or past) the end of the last.
      if (currentMs >= sequenceMs - 50) seek(0);
      if (pendingRef.current) {
        pendingRef.current.play = true;
        return;
      }
    } else {
      // From the trimmed start when at (or past) the trimmed end.
      const now = video.currentTime * 1000;
      if (now < trim.startMs || now >= trim.endMs - 50) seek(trim.startMs);
    }
    try {
      void video.play()?.catch(() => setPlaying(false));
    } catch {
      setPlaying(false);
    }
  };

  const toggle = () => (playing ? pause() : play());

  // While playing, the playhead follows every frame and stops at the trimmed end.
  // Joined, it goes on to the next clip at each clip's end, switching recording when it must.
  const endRef = useRef(trim.endMs);
  const playRef = useRef({ clips, joined, own, at });
  useEffect(() => {
    endRef.current = trim.endMs;
    playRef.current = { clips, joined, own, at };
  });
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const step = () => {
      const video = videoRef.current;
      if (!video) return;
      const ms = video.currentTime * 1000;
      const now = playRef.current;
      if (now.joined && now.at) {
        // Waiting for the next recording to load.
        if (pendingRef.current) {
          frame = requestAnimationFrame(step);
          return;
        }
        const { index, clip } = now.at;
        // A clip that keeps its recording's end may never reach `endMs`:
        // the video ends a little before, on its last frame.
        if (ms >= clip.endMs || video.ended) {
          const next = now.clips[index + 1] as Clip | undefined;
          if (!next) {
            video.pause();
            setCurrentMs(sequenceDuration(now.clips));
            return;
          }
          const start = clipStarts(now.clips)[index + 1];
          playRef.current = { ...now, at: { index: index + 1, clip: next, sourceMs: next.startMs } };
          setCurrentMs(start);
          if (next.source === loadedRef.current) {
            video.currentTime = next.startMs / 1000;
            if (video.paused) {
              try {
                void video.play()?.catch(() => setPlaying(false));
              } catch {
                setPlaying(false);
              }
            }
          } else {
            // The new recording plays from its clip's start once it loads.
            pendingRef.current = { sourceMs: next.startMs, play: true };
          }
        } else {
          setCurrentMs(toSequence(now.clips, index, ms));
        }
        frame = requestAnimationFrame(step);
        return;
      }
      if (ms >= endRef.current) {
        video.pause();
        video.currentTime = endRef.current / 1000;
        setCurrentMs(endRef.current);
        return;
      }
      setCurrentMs(ms);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const onMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    const source = video.dataset.source ?? own;
    const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setMeta((known) => ({ ...known, [source]: { durationMs: duration, width: video.videoWidth, height: video.videoHeight } }));
    }
    const first = loadedRef.current === null;
    loadedRef.current = source;
    const pending = pendingRef.current;
    pendingRef.current = null;
    const goTo = (ms: number) => {
      try {
        video.currentTime = ms / 1000;
      } catch {
        // Not seekable yet: it opens at the start.
      }
    };
    if (pending) {
      goTo(pending.sourceMs);
      if (pending.play) {
        try {
          void video.play()?.catch(() => setPlaying(false));
        } catch {
          setPlaying(false);
        }
      }
      return;
    }
    if (first && !joined && source === own) {
      // Opens at the start of the trimmed stretch.
      const start = trimOf(edits, duration).startMs;
      if (start > 0) seek(start);
    } else if (at && at.clip.source === source) {
      goTo(at.sourceMs);
    }
  };

  // Space plays and pauses, unless a control has the keyboard. Ctrl/⌘ Z
  // undoes, and Ctrl/⌘ Shift Z or Ctrl Y redoes, unless a field has the text.
  // Alt and the arrow keys move the selected clip; Delete removes it.
  const keysRef = useRef({ toggle, undoEdit, redoEdit, moveSelectedClip, removeSelectedClip, hasClip: false });
  useEffect(() => {
    keysRef.current = { toggle, undoEdit, redoEdit, moveSelectedClip, removeSelectedClip, hasClip: selectedClip !== null && !selectedZoom && !exporting };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey && (key === "z" || key === "y")) {
        if (isEditingText(event.target)) return;
        event.preventDefault();
        if (key === "y" || event.shiftKey) keysRef.current.redoEdit();
        else keysRef.current.undoEdit();
        return;
      }
      if (keysRef.current.hasClip && !mod && !isTyping(event.target)) {
        if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          keysRef.current.moveSelectedClip(event.key === "ArrowLeft" ? -1 : 1);
          return;
        }
        if (!event.altKey && (event.key === "Delete" || event.key === "Backspace")) {
          event.preventDefault();
          keysRef.current.removeSelectedClip();
          return;
        }
      }
      if (event.key !== " " || isTyping(event.target)) return;
      event.preventDefault();
      keysRef.current.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A click outside the backdrop panel closes it.
  useEffect(() => {
    if (!backdropOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !backdropRef.current?.contains(event.target)) setBackdropOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [backdropOpen]);

  // --- Backdrop -----------------------------------------------------------

  const sources = useCallback(
    (): BackdropSources => {
      const video = videoRef.current;
      return {
        capture: video && currentMeta ? { image: video, area: { x: 0, y: 0, width: currentMeta.width, height: currentMeta.height } } : null,
        image: backdropImageEl,
      };
    },
    [currentMeta, backdropImageEl],
  );

  // The preview paints the backdrop as the export does; the video plays on top.
  const blurTick = backdrop?.fill === BACKDROP_FILLS.blur ? frameTick : 0;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout || !backdrop) return;
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    try {
      paintUnderlay(ctx, layout, backdrop, sources());
    } catch {
      // A frame that cannot be drawn yet leaves the fill under it.
    }
  }, [layout, backdrop, sources, blurTick]);

  const savePreset = async () => {
    const current = edits.backdrop;
    if (!current || !presets.presetsRef.current || presets.presetsRef.current.length >= MAX_BACKDROP_PRESETS) return;
    let saved = current;
    if (current.fill === BACKDROP_FILLS.image && current.image) {
      try {
        saved = { ...current, image: await saveBackdropPresetImage(current.image) };
      } catch (err) {
        setMessage(`Could not save the preset: ${errorText(err)}`);
        return;
      }
    }
    const id = newId();
    presets.change((list) => (list.length >= MAX_BACKDROP_PRESETS ? list : [...list, { id, name: presetName(list), backdrop: saved }]));
    if (saved !== current) commitBackdrop(saved);
  };

  // --- Export -------------------------------------------------------------

  const exportNow = async () => {
    if (!videoSize || !layout || exporting || !canExport) return;
    pause();
    setMessage(null);
    setProgress({ done: 0, total: 0 });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onExportProgress(setProgress).catch(() => null);
      const shape = recordingLayout(videoSize, edits.backdrop);
      const layers = edits.backdrop ? await exportLayers(shape, edits.backdrop, sources()) : null;
      const owners = zoomOwners(savedClips, allZooms, own);
      const exportClips = savedClips.map((clip, index): ExportClip => {
        const size = meta[clip.source];
        const box = clip.source === own ? { x: 0, y: 0, width: shape.videoWidth, height: shape.videoHeight } : fitInside(size.width, size.height, shape.videoWidth, shape.videoHeight);
        return {
          source: clip.source,
          startMs: clip.startMs,
          endMs: clip.endMs,
          sourceWidth: size.width,
          sourceHeight: size.height,
          ...box,
          zooms: (joined ? zoomsIn(allZooms, clip, own).filter((zoom) => owners.get(zoom.id) === index) : allZooms.filter((zoom) => zoomOnSource(zoom, own, own))).map((zoom) => {
            const sent = { ...zoom };
            delete sent.source;
            return sent;
          }),
        };
      });
      const saved = await exportRecording(
        {
          clips: exportClips,
          width: shape.width,
          height: shape.height,
          x: shape.x,
          y: shape.y,
          videoWidth: shape.videoWidth,
          videoHeight: shape.videoHeight,
          backdropBytes: 0,
        },
        layers,
      );
      setMessage(`Exported ${fileName(saved)}`);
    } catch (err) {
      setMessage(`Export failed: ${errorText(err)}`);
    } finally {
      unlisten?.();
      setProgress(null);
    }
  };

  if (loadError) {
    return (
      <main className="editor recording-editor">
        <p className="recording-error" role="alert">
          Could not open the recording: {loadError}
        </p>
      </main>
    );
  }

  // The video's place on the preview, as shares of the output.
  const share = (part: number, whole: number) => `${(part / whole) * 100}%`;
  const clipMs = joined ? sequenceMs : trim.endMs - trim.startMs;
  const fit =
    layout && currentMeta && currentSource !== own ? fitInside(currentMeta.width, currentMeta.height, layout.videoWidth, layout.videoHeight) : null;
  const fitStyle = fit && layout ? { left: share(fit.x, layout.videoWidth), top: share(fit.y, layout.videoHeight), width: share(fit.width, layout.videoWidth), height: share(fit.height, layout.videoHeight) } : { inset: 0 };
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const status = exporting ? `Exporting… ${percent}%` : (message ?? saveText(saveStatus));
  // While an area zoom is chosen, the whole frame shows with the area on it.
  const picking = selectedZoom?.focus.kind === "area" && !playing && !exporting;
  // The view comes from the current clip's zooms, in its recording's time.
  const currentOffset = at ? spanOf(clips, own, at.index, durationMs).offset : 0;
  const currentZooms = zooms
    .filter((zoom) => !joined || (shown.owner.get(zoom.id) ?? positionIn(clips, own, zoom.startMs)?.index) === at?.index)
    .map((zoom) => ({ ...zoom, startMs: zoom.startMs - currentOffset, endMs: zoom.endMs - currentOffset }));
  const view = picking ? FULL_VIEW : viewAt(currentZooms, at?.sourceMs ?? currentMs, cursor);
  const frameStyle = layout
    ? {
        left: share(layout.x, layout.width),
        top: share(layout.y, layout.height),
        width: share(layout.videoWidth, layout.width),
        height: share(layout.videoHeight, layout.height),
        borderRadius: `${share(layout.radius, layout.videoWidth)} / ${share(layout.radius, layout.videoHeight)}`,
      }
    : undefined;

  return (
    <main className="editor recording-editor">
      <header className="editor-topbar">
        <div className="bar-group">
          <button type="button" className="icon-button" onClick={undoEdit} disabled={!canUndo(history) || exporting} aria-label="Undo" title="Undo (Ctrl+Z)">
            <UndoIcon />
          </button>
          <button type="button" className="icon-button" onClick={redoEdit} disabled={!canRedo(history) || exporting} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <RedoIcon />
          </button>
        </div>
        <div
          className="bar-group backdrop-anchor"
          ref={backdropRef}
          onKeyDown={(event) => {
            if (event.key === "Escape") setBackdropOpen(false);
          }}
        >
          <button
            type="button"
            className="text-button"
            aria-haspopup="dialog"
            aria-expanded={backdropOpen}
            data-on={backdrop ? "true" : undefined}
            disabled={exporting}
            onClick={() => {
              if (!backdropOpen) presets.refresh();
              setBackdropOpen(!backdropOpen);
            }}
          >
            <BackdropIcon />
            Backdrop
          </button>
          {backdropOpen && (
            <BackdropPanel
              backdrop={backdrop}
              start={presets.lastBackdrop}
              onPreview={setBackdropDraft}
              onCommit={commitBackdrop}
              onPickImage={chooseBackdropImage}
              presets={presets.presets}
              onSavePreset={() => void savePreset()}
              onPresetsChange={presets.change}
            />
          )}
        </div>
        <div className="bar-group">
          <button
            type="button"
            className="text-button"
            onClick={() => void addRecording()}
            disabled={!info || readOnly || exporting}
            title="Join a recording from the recordings folder after the clip under the playhead"
          >
            <AddIcon />
            Recording
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => addZoomAt(currentMs)}
            disabled={!canAddZoom || exporting}
            title={canAddZoom ? "Zoom in from the playhead" : "Move the playhead clear of the other zooms to add one"}
          >
            <ZoomInIcon />
            Zoom
          </button>
        </div>
        {selectedZoom && (
          <div className="bar-group zoom-controls" role="group" aria-label={zoomLabel(selectedZoom)}>
            <div className="bar-group segmented" role="group" aria-label="Zoom on">
              <button type="button" aria-pressed={selectedZoom.focus.kind === "area"} onClick={() => setZoomFocus(selectedZoom, "area")} disabled={exporting}>
                Area
              </button>
              <button
                type="button"
                aria-pressed={selectedZoom.focus.kind === "cursor"}
                onClick={() => setZoomFocus(selectedZoom, "cursor")}
                disabled={exporting || (!cursor && selectedZoom.focus.kind !== "cursor")}
                title={cursor ? "Follow the pointer, smoothed" : "This recording has no pointer track"}
              >
                Follow cursor
              </button>
            </div>
            <label className="zoom-scale">
              <span>Scale</span>
              <input
                type="range"
                aria-label="Zoom scale"
                min={MIN_ZOOM_SCALE}
                max={MAX_ZOOM_SCALE}
                step={ZOOM_SCALE_STEP}
                value={selectedZoom.scale}
                disabled={exporting}
                onChange={(event) => setZoomScale(selectedZoom, Number(event.target.value), false)}
                onPointerUp={() => setZoomScale(selectedZoom, selectedZoom.scale, true)}
                onKeyUp={() => setZoomScale(selectedZoom, selectedZoom.scale, true)}
              />
              <output>{selectedZoom.scale}×</output>
            </label>
            <button type="button" className="icon-button" aria-label="Delete zoom" title="Delete zoom (Delete)" onClick={() => deleteZoom(selectedZoom)} disabled={exporting}>
              <TrashIcon />
            </button>
          </div>
        )}
        <div className="bar-group end">
          <button type="button" className="primary" onClick={() => void exportNow()}
            disabled={!videoSize || exporting || !canExport}
            title={missingClip ? `${missingClip.source} is missing, so the sequence cannot be exported` : "Save the edited recording beside the original"}
          >
            <ExportIcon />
            {exporting ? "Exporting…" : "Export"}
          </button>
        </div>
      </header>
      <div className="recording-stage-area">
        <div
          className="recording-stage"
          data-testid="recording-stage"
          data-framed={backdrop ? "true" : undefined}
          style={layout ? ({ aspectRatio: `${layout.width} / ${layout.height}`, "--stage-ratio": layout.width / layout.height } as CSSProperties) : undefined}
        >
          {backdrop && <canvas ref={canvasRef} className="recording-backdrop" aria-hidden="true" />}
          <div className="recording-frame" style={frameStyle} data-joined={joined ? "true" : undefined}>
            <div className="recording-fit" style={fitStyle}>
            {src && (
              <video
                // A fresh element for each recording: WebKitGTK does not
                // always load a new blob into an element that played another.
                key={`${currentSource}\n${src}`}
                ref={videoRef}
                className="recording-video"
                data-source={currentSource}
                src={src}
                // A blob is the page's own; the scheme needs CORS for the backdrop's canvas.
                crossOrigin={src.startsWith("blob:") ? undefined : "anonymous"}
                preload="auto"
                playsInline
                style={{ transform: viewTransform(view) }}
                onLoadedMetadata={onMetadata}
                // Should loadedmetadata come and go unseen, the first frame
                // still hands the element its pending seek and play.
                onLoadedData={(event) => {
                  if (loadedRef.current !== event.currentTarget.dataset.source || pendingRef.current) onMetadata();
                }}
                onCanPlay={(event) => {
                  if (loadedRef.current !== event.currentTarget.dataset.source || pendingRef.current) onMetadata();
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => {
                  if (!handingOn()) setPlaying(false);
                }}
                onEnded={() => {
                  if (!handingOn()) setPlaying(false);
                }}
                onSeeked={() => setFrameTick((tick) => tick + 1)}
                onTimeUpdate={() => {
                  if (playing || pendingRef.current) return;
                  const ms = (videoRef.current?.currentTime ?? 0) * 1000;
                  setCurrentMs(joined && at ? toSequence(clips, at.index, ms) : ms);
                }}
                onError={() => setMessage("The recording cannot be played.")}
                onClick={toggle}
              />
            )}
            {picking && selectedZoom?.focus.kind === "area" && (
              <ZoomAreaPicker
                scale={selectedZoom.scale}
                x={selectedZoom.focus.x}
                y={selectedZoom.focus.y}
                onPreview={(x, y) => setZoomArea(selectedZoom, x, y, false)}
                onCommit={(x, y) => setZoomArea(selectedZoom, x, y, true)}
              />
            )}
            </div>
          </div>
        </div>
      </div>
      <div className="recording-controls">
        <button type="button" className="icon-button" onClick={toggle} disabled={!videoSize} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="recording-time" aria-label="Time">
          {formatTime(currentMs)} / {formatTime(timelineDuration)}
        </span>
        <Timeline
          durationMs={timelineDuration}
          trimmable={!joined}
          trim={trim}
          currentMs={currentMs}
          onSeek={seek}
          onTrimPreview={(next) => {
            setTrimDraft(next);
            // The frame at the handle shows while it moves.
            seek(next.startMs !== trim.startMs ? next.startMs : next.endMs);
          }}
          onTrimCommit={commitTrim}
        >
          {joined && (
            <ClipTrack
              clips={clips}
              durationMs={sequenceMs}
              sourceDuration={(source) => meta[source]?.durationMs ?? 0}
              missing={missing}
              selectedId={selectedClip?.id ?? null}
              onSelect={(id) => {
                setSelectedClipId(id);
                setSelectedZoomId(null);
              }}
              onTrimPreview={setClipDraft}
              onTrimCommit={(next) => {
                commitClips(next);
                const pos = at ? next.findIndex((clip) => clip.id === at.clip.id) : -1;
                if (pos >= 0 && at) seek(timelineMs(next, own, pos, at.sourceMs), next);
              }}
              onMove={(id, to) => {
                const next = moveClip(clips, id, to);
                if (next === clips) return;
                commitClips(next);
                const index = next.findIndex((clip) => clip.id === id);
                seek(timelineMs(next, own, index, next[index].startMs), next);
              }}
            />
          )}
          <ZoomTrack
            durationMs={timelineDuration}
            zooms={zooms}
            selectedId={selectedZoom?.id ?? null}
            onSelect={(id) => {
              setSelectedZoomId(id);
              if (id) setSelectedClipId(null);
            }}
            onPreview={setZoomDraft}
            onCommit={commitZooms}
            onAdd={addZoomAt}
            onSeek={(ms) => seek(Math.min(Math.max(ms, trim.startMs), trim.endMs))}
          />
        </Timeline>
      </div>
      {exporting && (
        <div className="recording-progress" role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div style={{ width: `${percent}%` }} />
        </div>
      )}
      <footer className="editor-status">
        <span>{info?.fileName ?? "Loading…"}</span>
        {durationMs > 0 && (joined ? <span>{clips.length} clips, {formatTime(clipMs)}</span> : <span>Clip {formatTime(clipMs)}</span>)}
        {info && <SoundSources audio={info.audio} />}
        {layout && (
          <span>
            Output {layout.width}×{layout.height}
          </span>
        )}
        <span className="status-message" role="status">
          {status}
        </span>
      </footer>
    </main>
  );
}
