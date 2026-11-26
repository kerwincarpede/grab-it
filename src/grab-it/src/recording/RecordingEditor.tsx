import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "../editor/editor.css";
import "./recording.css";
import { NoiseIcon } from "../app/icons";
import { MAX_BACKDROP_PRESETS } from "../settings/api";
import { chooseBackdropImage, saveBackdropPresetImage } from "../editor/api";
import BackdropPanel from "../editor/BackdropPanel";
import { BackdropIcon, CopyIcon, ExportIcon, FitIcon, RedoIcon, TrashIcon, UndoIcon, ZoomInIcon, ZoomOutIcon } from "../editor/icons";
import { canRedo, canUndo, commit, initHistory, redo, undo, type History } from "../editor/history";
import { BACKDROP_FILLS, type Backdrop } from "../editor/model";
import { presetName } from "../editor/preferences";
import { newId } from "../editor/tools";
import { useBackdropImage } from "../editor/useBackdropImage";
import type { BackdropSources } from "../editor/flatten";
import {
  cancelExport,
  cancelTranscribe,
  chooseSubtitlesFile,
  exportRecording,
  onExportProgress,
  onTranscribeProgress,
  recordingInfo,
  recordingPickSource,
  recordingSource,
  recordingTranscribe,
  recordingTranscript,
  saveEdits,
  saveSubtitles,
  transcribeModel,
  type AudioKind,
  type ExportEntry,
  type ExportOverlayImage,
  type ExportProgress,
  type RecordingInfo,
  type RecordingSource,
  type TranscribeModel,
  type TranscribeProgress,
} from "./api";
import {
  canRemove,
  clipLength,
  clipStarts,
  clipsOf,
  duplicateClip,
  fitInside,
  insertClip,
  isGap,
  movedIndex,
  leaveGap,
  moveClip,
  newClipId,
  sequenceDuration,
  tagZoom,
  toSequence,
  toSource,
  zoomOnSource,
  zoomOwners,
  zoomsIn,
  type Clip,
  type ClipAt,
} from "./clips";
import ClipTrack from "./ClipTrack";
import CaptionPreview from "./CaptionPreview";
import CaptionTrack, { type CueSpan } from "./CaptionTrack";
import {
  CAPTION_LOOKS,
  CAPTION_POSITIONS,
  CAPTION_SIZES,
  cueOnSource,
  cuePng,
  cueShowings,
  cuesFromTranscript,
  DEFAULT_CUE_MS,
  emptyCaptions,
  MIN_CUE_MS,
  removeCue,
  replaceCue,
  showingAt,
  sortCues,
  styleOf,
  subtitleCues,
  tagCue,
  newCueId,
  withStyle,
  type Captions,
  type CaptionStyle,
  type Cue,
  type CueShowing,
} from "./captions";
import SuggestEditsPanel, { type ShownCuts } from "./SuggestEditsPanel";
import TrackAudio from "./TrackAudio";
import TrackRows from "./TrackRows";
import { addTrack, canSplitAt, clipPlaces, exportAudio, flattenPicture, hasOverlay, isLockedClip, isMain, isRefusal, linkClips, lockTrack, mainTrack, moveInTime, needsTracks, placeRecording, reconcile, removeTrack, renameTrack, rippleDelete, shiftUnlinked, splitAt, timelineOf, trackOf, unlinkClips, withTimeline, type Timeline as Tracks, type TrackKind } from "./tracks";
import RecordingVideo from "./RecordingVideo";
import { chooseRecording, probeVideo, type SourceMeta } from "./sources";
import { clampTrim, emptyEdits, formatTime, isWhole, parseEdits, serializeEdits, trimOf, type RecordingEdits, type Trim } from "./edits";
import { exportLayers, paintUnderlay, recordingLayout } from "./layout";
import { useBackdropPresets } from "./useBackdropPresets";
import Timeline, { type TimelineView } from "./Timeline";
import { maxZoom, stepScale, zoomFor, type TimelineScale } from "./timelineZoom";
import { isMacPlatform } from "../settings/accelerator";
import ZoomAreaPicker from "./ZoomAreaPicker";
import ZoomTrack from "./ZoomTrack";
import WaveformLanes from "./WaveformLanes";
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

/** Why an edit was refused during a preview of suggested cuts. */
const PREVIEW_BLOCKS_EDITS = "Stop the preview or apply the suggested cuts before editing.";

/** The error text `recording_transcribe` and a page-side cancel stop with. */
const TRANSCRIBE_CANCELLED = "Transcribing cancelled";
const errorText = (err: unknown) => String(err instanceof Error ? err.message : err);
/** The Captions panel's style choices, one row each. */
const CAPTION_STYLE_CONTROLS: { label: string; key: keyof CaptionStyle; options: { value: string; label: string }[] }[] = [
  { label: "Look", key: "look", options: CAPTION_LOOKS },
  { label: "Size", key: "size", options: CAPTION_SIZES },
  { label: "Position", key: "position", options: CAPTION_POSITIONS },
];

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

const SplitIcon = () => (
  <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M12 3v18M4 8h5v8H4M20 8h-5v8h5" />
  </svg>
);

const GapIcon = () => (
  <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M3 7h4v10H3M21 7h-4v10h4" />
    <path d="M10 12h4" strokeDasharray="2 2" />
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

/** The wheel gesture that zooms the timeline, as the platform names its key. */
const ZOOM_WHEEL = isMacPlatform() ? "⌘ + scroll" : "Ctrl + scroll";

/** Whether `clips` is more than one clip of the recording `own`: then the timeline is the joined sequence's. */
/**
 * The stretch of one recording `edits` keep: with tracks the sidecar holds
 * it as Video 1's one clip, not as `trim`.
 */
function keptOf(edits: RecordingEdits, durationMs: number): Trim {
  const only = edits.tracks && edits.clips?.length === 1 ? edits.clips[0] : null;
  return only && !isGap(only) ? { startMs: only.startMs, endMs: only.endMs } : trimOf(edits, durationMs);
}

const isJoined = (clips: Clip[], own: string) => clips.length > 1 || (clips.length === 1 && clips[0].source !== own);

/**
 * Where timeline time `ms` falls. Joined, the timeline is the sequence;
 * otherwise it is the opened recording's own time, cut by its trim.
 * `joinedView` holds the timeline as the sequence even for one clip of
 * the opened recording, as other video tracks over it do.
 */
function positionIn(clips: Clip[], own: string, ms: number, joinedView = false): ClipAt | null {
  if (clips.length === 0) return null;
  if (!joinedView && !isJoined(clips, own)) return { index: 0, clip: clips[0], sourceMs: ms };
  return toSource(clips, ms);
}

/** The timeline time of `sourceMs` in clip `index`. */
function timelineMs(clips: Clip[], own: string, index: number, sourceMs: number, joinedView = false): number {
  return joinedView || isJoined(clips, own) ? toSequence(clips, index, sourceMs) : sourceMs;
}

/** How far clip `index` is shifted onto the timeline, and the stretch it takes there. */
function spanOf(clips: Clip[], own: string, index: number, ownDurationMs: number, joinedView = false): { offset: number; low: number; high: number } {
  if (!joinedView && !isJoined(clips, own)) return { offset: 0, low: 0, high: ownDurationMs };
  const start = clipStarts(clips)[index] ?? 0;
  const clip = clips[index];
  return { offset: start - clip.startMs, low: start, high: start + clipLength(clip) };
}

/** The recording of clip `index`, or over a gap of the nearest clip before it, else after it. */
function sourceNear(clips: Clip[], index: number): string | null {
  for (let i = index; i >= 0; i--) if (!isGap(clips[i])) return clips[i].source;
  for (let i = index + 1; i < clips.length; i++) if (!isGap(clips[i])) return clips[i].source;
  return null;
}

/** Why an edit of a clip on a locked track was refused. */
const LOCKED_CLIP = "That clip's track is locked. Unlock it first.";

/** What Remove background noise does, on the top bar. */
const NOISE_USE = "Remove background noise from the microphone when exporting. The preview plays as recorded.";
/** Why Remove background noise is off for this sequence. */
const NOISE_UNAVAILABLE = "Only newer recordings with a microphone can remove background noise";

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
  const [suggestOpen, setSuggestOpen] = useState(false);
  /**
   * The sequence with the suggested cuts, while Suggest edits previews
   * them. Nothing is saved meanwhile: every edit waits until the preview
   * ends, and only Apply keeps the cuts.
   */
  const [suggestPreview, setSuggestPreview] = useState<Clip[] | null>(null);
  /**
   * Where a preview of one suggested cut stops on its own: `endMs` of
   * `clips`, which holds only while `clips` is the preview playing.
   */
  const [previewStop, setPreviewStop] = useState<{ clips: Clip[]; endMs: number; returnMs?: number } | null>(null);
  /** Suggest edits' proposals, hatched on the clip track while its panel is open. */
  const [shownCuts, setShownCuts] = useState<ShownCuts | null>(null);
  /** A proposal clicked on the clip track, for Suggest edits to bring into focus. */
  const [cutFocusRequest, setCutFocusRequest] = useState<{ id: string } | null>(null);
  /** The tracks as the previewed cuts leave them, beside `suggestPreview`. */
  const [suggestTracks, setSuggestTracks] = useState<Tracks["tracks"] | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  /** While playing over a gap: when its clock started and the playhead then. */
  const gapClockRef = useRef<{ at: number; ms: number } | null>(null);
  /** Whether playback is going through a gap, so the paused video is not a stop. */
  const throughGapRef = useRef(false);
  /** Where to put the video once the recording it switches to has loaded. */
  const pendingRef = useRef<{ source: string; sourceMs: number; play: boolean } | null>(null);
  /** The recording whose position the player on show has taken. */
  const loadedRef = useRef<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** The timeline's zoom in pixels a second, kept only while the editor is open; null fits it. */
  const [timelineScale, setTimelineScale] = useState<TimelineScale>(null);
  /** The stretch of the timeline in view, which the waveforms draw; its width bounds the zoom. */
  const [timelineView, setTimelineView] = useState<TimelineView | null>(null);
  const timelineWidth = timelineView?.width ?? 0;
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
  /** A caption still being dragged; null when none is. */
  const [captionDraft, setCaptionDraft] = useState<CueSpan | null>(null);
  /** The selected showing of a cue: the cue and the clip it shows in. */
  const [selectedCueKey, setSelectedCueKey] = useState<string | null>(null);
  /** The selected cue's text while it is typed, saved when the field is left. */
  const [cueTextDraft, setCueTextDraft] = useState<string | null>(null);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const captionsRef = useRef<HTMLDivElement>(null);
  /** Transcribing: how far it has got; null when it is not. */
  const [transcribing, setTranscribing] = useState<TranscribeProgress | null>(null);
  const [cancellingTranscribe, setCancellingTranscribe] = useState(false);
  /** Transcribing again waits for this confirmation, as it replaces the cues. */
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [captionsMessage, setCaptionsMessage] = useState<string | null>(null);
  /** The speech model's state, asked for when the popover opens. */
  const [model, setModel] = useState<TranscribeModel | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
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

  const own = info?.source ?? "";
  const ownMeta = meta[own] as SourceMeta | undefined;
  /** The opened recording's length; it sets the output's size and frame rate whatever the order. */
  const durationMs = ownMeta?.durationMs ?? 0;
  const videoSize = useMemo(() => (ownMeta ? { width: ownMeta.width, height: ownMeta.height } : null), [ownMeta]);
  const backdrop = backdropDraft !== undefined ? backdropDraft : (edits.backdrop ?? null);
  /** Whether recording `source` has sound; one not yet probed is taken to. */
  const hasAudio = useCallback(
    (source: string) => (source === own ? (info?.audio.length ?? 0) > 0 : (sourceInfo[source]?.hasAudio ?? true)),
    [own, info, sourceInfo],
  );
  const sequenceClips = useMemo(() => clipsOf(edits, own, durationMs), [edits, own, durationMs]);
  /** Every track (see tracks.ts); its `main` is the saved sequence, links included. */
  const tracks = useMemo(() => timelineOf(edits, sequenceClips, hasAudio), [edits, sequenceClips, hasAudio]);
  const savedClips = tracks.main;
  /**
   * The stretch of one recording kept: with tracks the sidecar holds it as
   * Video 1's one clip, not as `trim`.
   */
  const savedTrim = keptOf(edits, durationMs);
  /** Whether the sound is arranged apart from the pictures, so it plays from the audio tracks. */
  const ownSound = needsTracks(tracks, hasAudio);
  /** The tracks on show: while suggested cuts are previewed, as they leave them. */
  const shownTracks: Tracks = useMemo(() => (suggestPreview && suggestTracks ? { main: suggestPreview, tracks: suggestTracks } : tracks), [suggestPreview, suggestTracks, tracks]);
  /** Clips chosen with Shift-click besides the selected clip, for Link. */
  const [trackSelection, setTrackSelection] = useState<ReadonlySet<string>>(() => new Set());
  /** The extra video track chosen by clicking its name, for Add recording. */
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const clips = clipDraft ?? suggestPreview ?? savedClips;
  /** Whether another video track holds a clip: the timeline is then the sequence, even for one clip of the opened recording. */
  const overlay = hasOverlay(shownTracks);
  const joined = overlay || isJoined(clips, own);
  const sequenceMs = sequenceDuration(clips);
  /** The picture `list` (a main sequence) makes with the video tracks of `timeline`, the highest winning (see tracks.ts). */
  const pictureOf = (list: Clip[], timeline: Tracks = shownTracks) => (hasOverlay(timeline) ? flattenPicture({ ...timeline, main: list }) : list);
  /** What the preview plays: the flattened picture, switching recording at each change. */
  const picture = useMemo(() => (overlay ? flattenPicture({ ...shownTracks, main: clips }) : clips), [overlay, shownTracks, clips]);
  /** The timeline's length: the sequence, or the picture when another video track runs past it. */
  const timelineDuration = joined ? Math.max(sequenceMs, sequenceDuration(picture)) : durationMs;
  const at = positionIn(clips, own, currentMs, overlay);
  const shownAt = picture === clips ? at : positionIn(picture, own, currentMs, overlay);
  /** Over a gap nothing plays: the video box is black and the sound silent. */
  const onGap = shownAt ? isGap(shownAt.clip) : false;
  // Over a gap the player of the nearest clip stays on show, hidden, so it is ready.
  const currentSource = shownAt ? (sourceNear(picture, shownAt.index) ?? own) : own;
  const pathOf = (source: string): string | null => (!info ? null : source === own ? info.path : (sourceInfo[source]?.path ?? null));
  // Keep the DOM order stable even when the user reorders clips. Moving a
  // playing element in the DOM can reset its media pipeline in WebKitGTK.
  const previewSources = useMemo(
    () => [...new Set([...clips.filter((clip) => !isGap(clip)), ...tracks.tracks.flatMap((track) => (track.kind === "video" ? track.clips : []))].map((clip) => clip.source))].sort(),
    [clips, tracks],
  );
  const plannedAudio = useMemo(() => {
    const endMs = sequenceDuration(flattenPicture(tracks));
    return ownSound ? exportAudio(tracks).filter((clip) => clip.atMs < endMs) : null;
  }, [ownSound, tracks]);
  const audioSources = useMemo(() => [...new Set(plannedAudio?.map((clip) => clip.source))], [plannedAudio]);
  const currentMeta = meta[currentSource] as SourceMeta | undefined;
  const cursorOf = (source: string) => (source === own ? (info?.cursor ?? null) : (sourceInfo[source]?.cursor ?? null));
  const cursor = cursorOf(currentSource);
  const selectedClip = joined ? (clips.find((clip) => clip.id === selectedClipId) ?? null) : null;
  const missingSource = previewSources.find((source) => missing.has(source)) ?? audioSources.find((source) => missing.has(source));
  /** Recording `source`'s sound sources by kind, or null until known. */
  const audioOf = (source: string) => (source === own ? (info?.audio ?? null) : (sourceInfo[source]?.audio ?? null));
  /** Whether the sound sidecar of recording `source` keeps its microphone apart. */
  const separateMicrophone = (source: string) => (source === own ? (info?.separateMicrophone ?? false) : (sourceInfo[source]?.separateMicrophone ?? false));
  /** Noise can be removed when a recording in the mix keeps its microphone apart. */
  const canRemoveNoise = (plannedAudio ? audioSources : previewSources).some(separateMicrophone);
  /** Until it is changed, the export follows how the opened recording was made. */
  const removeNoise = edits.removeNoise ?? info?.removeNoise ?? false;
  // Proposals are hatched while Suggest edits is open, on the sequence they were proposed against.
  const hatchedCuts = suggestOpen && !suggestPreview && !clipDraft && shownCuts ? shownCuts.cuts : [];
  /** Every clip's recording is there and its size known. */
  const canExport = !suggestPreview && !missingSource && previewSources.every((source) => meta[source] !== undefined) && audioSources.every((source) => pathOf(source) !== null);

  // Zooms keep their recording's time; the timeline shows each on its clip.
  const allZooms = useMemo(() => edits.zooms ?? [], [edits.zooms]);
  const shown = useMemo(() => {
    const list: Zoom[] = [];
    const owner = new Map<string, number>();
    clips.forEach((clip, index) => {
      const { offset, low, high } = spanOf(clips, own, index, durationMs, overlay);
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
  }, [clips, own, durationMs, joined, overlay, allZooms]);
  const zooms = zoomDraft ?? shown.list;
  const selectedZoom = zooms.find((zoom) => zoom.id === selectedZoomId) ?? null;

  // Cues keep their recording's time; each shows in every clip playing it.
  const captions: Captions = useMemo(() => edits.captions ?? emptyCaptions(), [edits.captions]);
  const captionStyle: CaptionStyle = styleOf(edits.captions);
  const savedShowings = useMemo(() => cueShowings(captions.cues, clips, own, joined), [captions.cues, clips, own, joined]);
  const showings = captionDraft
    ? savedShowings.map((each) => (each.key === captionDraft.key ? { ...each, startMs: captionDraft.startMs, endMs: captionDraft.endMs } : each))
    : savedShowings;
  const selectedShowing = showings.find((each) => each.key === selectedCueKey) ?? null;
  const playheadCue = showingAt(showings, currentMs);
  /** Recordings the sequence plays, each transcribed once. */
  const sequenceSources = [...new Set(clips.filter((clip) => !isGap(clip)).map((clip) => clip.source))];
  // A preview that leaves the opened recording one clip plays that clip as its trim.
  const trim = joined ? { startMs: 0, endMs: timelineDuration } : suggestPreview ? { startMs: clips[0].startMs, endMs: clips[0].endMs } : (trimDraft ?? savedTrim);
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

  /**
   * One undo entry; an edit that leaves the sidecar as it was adds none.
   * While suggested cuts are previewed, edits are refused, since they
   * would be made on the unapproved cuts; Apply alone passes `applying`.
   */
  const commitEdits = useCallback(
    (next: RecordingEdits, applying = false) => {
      if (suggestPreview && !applying) {
        setMessage(PREVIEW_BLOCKS_EDITS);
        return;
      }
      if (JSON.stringify(serializeEdits(next)) === JSON.stringify(serializeEdits(history.present))) return;
      setHistory(commit(history, next));
      save(next);
    },
    [history, save, suggestPreview],
  );

  /** Moves the playhead to timeline time `ms` of `list`, switching recording when it must. */
  /** `timeline` is the one just committed or previewed, whose other video tracks `list` plays under. */
  const seek = (ms: number, list: Clip[] = clips, timeline?: Tracks) => {
    const video = videoRef.current;
    setCurrentMs(ms);
    const view = timeline ?? shownTracks;
    const pos = positionIn(list === clips && !timeline ? picture : pictureOf(list, view), own, ms, hasOverlay(view));
    if (!pos) return;
    if (isGap(pos.clip)) {
      // Nothing plays over a gap; when playing, its clock runs on to the next clip.
      pendingRef.current = null;
      gapClockRef.current = null;
      if (playing) {
        throughGapRef.current = true;
        video?.pause();
      }
      return;
    }
    // Leaving a gap while playing starts the video again.
    const resume = throughGapRef.current && playing;
    throughGapRef.current = false;
    gapClockRef.current = null;
    if (video && loadedRef.current === pos.clip.source && video.dataset.source === pos.clip.source) {
      pendingRef.current = null;
      try {
        video.currentTime = pos.sourceMs / 1000;
      } catch {
        // Not seekable yet: it opens at the start.
      }
      if (resume && video.paused) {
        try {
          void video.play()?.catch(() => setPlaying(false));
        } catch {
          setPlaying(false);
        }
      }
    } else {
      pendingRef.current = { source: pos.clip.source, sourceMs: pos.sourceMs, play: pendingRef.current?.play ?? playing };
    }
  };

  // --- Clips --------------------------------------------------------------

  // The mounted previews supply their own metadata. If the opened recording
  // has no clips, its size is still needed for the output canvas.
  useEffect(() => {
    if (!info) return;
    for (const source of new Set([...previewSources, ...audioSources])) {
      if (source === own || requested.current.has(source)) continue;
      requested.current.add(source);
      recordingSource(source)
        .then((found) => setSourceInfo((known) => ({ ...known, [source]: found })))
        .catch(() => setMissing((gone) => new Set(gone).add(source)));
    }
    if (!previewSources.includes(own) && !ownMeta && !requested.current.has(own)) {
      requested.current.add(own);
      probeVideo(info.path)
        .then((learned) => setMeta((known) => ({ ...known, [own]: learned })))
        .catch(() => setMissing((gone) => new Set(gone).add(own)));
    }
  }, [info, previewSources, audioSources, own, ownMeta]);

  /** Keeps `next` as every track: one undo entry. `sound` answers for recordings not yet probed. */
  const commitTracks = (next: Tracks, applying = false, sound: (source: string) => boolean = hasAudio) => {
    setClipDraft(null);
    commitEdits(withTimeline(edits, next, own, durationMs, sound), applying);
  };

  /**
   * `next` as the sequence with its linked sound following it, trims
   * clamped together; null, with a message, when it cannot be.
   */
  const reconciled = (next: Clip[], sound: (source: string) => boolean = hasAudio): Tracks | null => {
    if (mainTrack(tracks).locked) {
      setClipDraft(null);
      setMessage(`${mainTrack(tracks).name} is locked. Unlock it to change its clips.`);
      return null;
    }
    const result = reconcile(tracks, next, sound, undefined, (source) => meta[source]?.durationMs ?? 0);
    if (!result) {
      setClipDraft(null);
      setMessage("That would put linked sound over another clip on its track. Unlink or move it first.");
      return null;
    }
    // Linked clips on a locked track must stay as they are.
    const lockedChanged = result.tracks.some((track) => {
      const before = tracks.tracks.find((each) => each.id === track.id);
      return (track.locked || before?.locked) && JSON.stringify(track.clips) !== JSON.stringify(before?.clips);
    });
    if (lockedChanged) {
      setClipDraft(null);
      setMessage("That would change linked clips on a locked track. Unlock it or unlink them first.");
      return null;
    }
    return result;
  };

  /** Keeps `next` as the sequence, its linked sound following it: one undo entry. */
  const commitClips = (next: Clip[], applying = false, sound: (source: string) => boolean = hasAudio) => {
    const result = reconciled(next, sound);
    if (result) commitTracks(result, applying, sound);
  };

  /** The clips selected for Link and Unlink: the selected clip and those Shift-clicked. */
  // One recording has no clip row: its picture counts as chosen with any sound clip.
  const ownPicture = !joined && savedClips.length === 1 ? savedClips[0].id : null;
  const chosenIds = useMemo(
    () => new Set([...trackSelection, ...(selectedClipId ? [selectedClipId] : []), ...(ownPicture && trackSelection.size > 0 ? [ownPicture] : [])]),
    [trackSelection, selectedClipId, ownPicture],
  );
  const canLink = chosenIds.size >= 2;
  const canUnlink = [...tracks.main, ...tracks.tracks.flatMap((track) => track.clips)].some((clip) => chosenIds.has(clip.id) && clip.link);
  const linkChosen = () => {
    if ([...chosenIds].some((id) => isLockedClip(tracks, id))) {
      setMessage(LOCKED_CLIP);
      return;
    }
    const next = linkClips(tracks, chosenIds);
    if (next) commitTracks(next);
    else setMessage("Link needs two or more clips, at most one of them on Video 1, that can line up without overlapping another clip.");
  };
  const unlinkChosen = () => {
    if ([...chosenIds].some((id) => isLockedClip(tracks, id))) setMessage(LOCKED_CLIP);
    else commitTracks(unlinkClips(tracks, chosenIds));
  };
  /** Moves a clip off Video 1, with its links, to start at sequence time `atMs`. */
  const moveTrackClip = (id: string, atMs: number, toTrack?: string) => {
    // The timeline ends with the later of Video 1's end and the last overlay clip's.
    const endMs = Math.max(sequenceDuration(savedClips), sequenceDuration(flattenPicture(tracks)));
    const next = moveInTime(tracks, id, atMs, toTrack, endMs);
    if (isRefusal(next)) setMessage(next.refused);
    else commitTracks(next);
  };

  /** Adds an empty track of `kind`: a video track on top, an audio track last. */
  const addTrackOf = (kind: TrackKind) => {
    const added = addTrack(tracks, kind);
    commitTracks(added.timeline);
    if (kind === "video") setSelectedTrackId(added.id);
  };
  const removeTrackById = (id: string) => {
    const next = removeTrack(tracks, id);
    if (isRefusal(next)) setMessage(next.refused);
    else {
      commitTracks(next);
      if (selectedTrackId === id) setSelectedTrackId(null);
    }
  };
  /** The extra video track Add recording places onto: the one chosen, or that of the selected clip. */
  const targetTrack = (() => {
    const chosen = selectedTrackId ?? (trackSelection.size === 1 ? trackOf(tracks, [...trackSelection][0])?.id : undefined);
    const track = tracks.tracks.find((each) => each.id === chosen);
    return track && track.kind === "video" && !isMain(track) ? track : null;
  })();

  /**
   * Ends a preview of suggested cuts, back to the saved sequence: at
   * `toMs` of it when given. Playback stops with it, so the sequence
   * without the cuts never plays on unasked.
   */
  const endSuggestPreview = (toMs?: number) => {
    if (!suggestPreview) return;
    pause();
    setSuggestPreview(null);
    setMessage(null);
    seek(toMs ?? Math.min(currentMs, Math.max(sequenceDuration(savedClips), sequenceDuration(pictureOf(savedClips, tracks)))), savedClips, tracks);
    // `seek` still sees the playing from before the pause: a recording it
    // has to load, or a gap it lands in, must not set playback off again.
    if (pendingRef.current) pendingRef.current.play = false;
    throughGapRef.current = false;
  };

  const closeSuggestions = () => {
    endSuggestPreview();
    setSuggestOpen(false);
    setCutFocusRequest(null);
  };

  const latestRef = useRef({ clips, at, commitClips, seek, meta, tracks, targetTrack, commitTracks, hasAudio, playheadMs: 0 });
  useEffect(() => {
    latestRef.current = { clips, at, commitClips, seek, meta, tracks, targetTrack, commitTracks, hasAudio, playheadMs: joined ? currentMs : currentMs - trim.startMs };
  });

  /** Asks for a recording in the recordings folder and joins it after the clip under the playhead. */
  const addRecording = async () => {
    if (!info || exporting) return;
    let picked: string | null;
    try {
      picked = await chooseRecording(info.recordingsFolder);
    } catch (err) {
      setMessage(`Could not choose a recording: ${errorText(err)}`);
      return;
    }
    if (!picked) return;
    try {
      const found = await recordingPickSource(picked);
      const name = found.source;
      const learned = latestRef.current.meta[name] ?? (await probeVideo(found.path));
      if (name !== own) setSourceInfo((known) => ({ ...known, [name]: found }));
      setMeta((known) => ({ ...known, [name]: learned }));
      requested.current.add(name);
      setMissing((gone) => {
        if (!gone.has(name)) return gone;
        const left = new Set(gone);
        left.delete(name);
        return left;
      });
      const latest = latestRef.current;
      if (latest.targetTrack) {
        const placed = placeRecording(latest.tracks, latest.targetTrack.id, { source: name, startMs: 0, endMs: learned.durationMs }, latest.playheadMs, latest.hasAudio);
        if (isRefusal(placed)) setMessage(placed.refused);
        else {
          latest.commitTracks(placed.timeline);
          // One recording's own time becomes sequence time under the overlay: the playhead keeps its place.
          latest.seek(latest.playheadMs, latest.clips, placed.timeline);
          setTrackSelection(new Set([placed.id]));
          setSelectedClipId(null);
          setSelectedZoomId(null);
          setMessage(null);
        }
        return;
      }
      const after = latest.at?.index ?? latest.clips.length - 1;
      const clip: Clip = { id: newClipId(), source: name, startMs: 0, endMs: learned.durationMs };
      const next = insertClip(latest.clips, after, clip);
      // `sourceInfo` is not updated yet: the probe says whether it has sound.
      latest.commitClips(next, false, (source) => (source === name ? found.hasAudio : latest.hasAudio(source)));
      setSelectedClipId(clip.id);
      setSelectedZoomId(null);
      setMessage(null);
      latest.seek(timelineMs(next, own, after + 1, 0, overlay), next);
    } catch (err) {
      setMessage(`Could not add ${fileName(picked)}: ${errorText(err)}`);
    }
  };

  const moveSelectedClip = (by: number) => {
    if (!selectedClip) return;
    const from = clips.findIndex((clip) => clip.id === selectedClip.id);
    const next = moveClip(clips, selectedClip.id, from + by);
    if (next === clips) return;
    commitClips(next);
    const index = movedIndex(next, selectedClip.id, from + by);
    setSelectedClipId(next[index].id);
    seek(timelineMs(next, own, index, next[index].startMs, overlay), next);
  };

  /** Deletes the selected clip or gap and closes the stretch it took (a ripple delete). */
  const removeSelectedClip = () => {
    if (!selectedClip || !canRemove(clips, selectedClip.id)) return;
    const index = clips.findIndex((clip) => clip.id === selectedClip.id);
    const start = clipStarts(clips)[index];
    const rippled = rippleDelete(tracks, selectedClip.id);
    if (isRefusal(rippled)) {
      setMessage(rippled.refused);
      return;
    }
    const next = rippled.main;
    commitTracks(rippled);
    setSelectedClipId(null);
    // The playhead goes to where the removed stretch was, now the start of what followed it.
    const pos = toSource(next, Math.min(start, sequenceDuration(next)));
    if (pos) seek(timelineMs(next, own, pos.index, pos.sourceMs, hasOverlay(rippled)), next, rippled);
  };

  /** Deletes the selected clip and leaves a gap of its length; on a gap, closes it. */
  const leaveGapForSelected = () => {
    if (!selectedClip || !canRemove(clips, selectedClip.id)) return;
    if (isGap(selectedClip)) {
      removeSelectedClip();
      return;
    }
    const gapId = newClipId();
    const next = leaveGap(clips, selectedClip.id, gapId);
    if (next === clips) return;
    commitClips(next);
    // A gap merged into one before it keeps that one's id.
    const gap = next.find((clip) => clip.id === gapId) ?? toSource(next, currentMs)?.clip;
    setSelectedClipId(gap && isGap(gap) ? gap.id : null);
  };

  /** Copies the selected clip right after itself, and selects the copy. */
  const duplicateSelectedClip = () => {
    if (!selectedClip || isGap(selectedClip)) return;
    const copyId = newClipId();
    const next = duplicateClip(clips, selectedClip.id, copyId);
    if (next === clips) return;
    commitClips(next);
    setSelectedClipId(copyId);
    setSelectedZoomId(null);
    const index = next.findIndex((clip) => clip.id === copyId);
    seek(timelineMs(next, own, index, next[index].startMs, overlay), next);
  };

  /** The playhead in sequence time, as the tracks place clips. */
  const playheadSeqMs = joined || !at ? currentMs : toSequence(clips, at.index, at.sourceMs);
  /** The clip Split cuts with its links; none cuts every unlocked track. */
  const splitChosen = selectedClipId ?? [...trackSelection][0] ?? undefined;
  /**
   * What Split cuts with its links: a selected clip under the playhead, else
   * with another clip selected the Video 1 clip under the playhead; with
   * nothing selected, every unlocked track's clip there (undefined).
   */
  const splitTarget = !splitChosen
    ? undefined
    : clipPlaces(tracks).some((place) => place.id === splitChosen && place.atMs < playheadSeqMs && place.endMs > playheadSeqMs)
      ? splitChosen
      : at && !isGap(at.clip)
        ? at.clip.id
        : undefined;
  /** Whether Split cuts something: a clip under the playhead on any unlocked track (or the chosen one), each part long enough. */
  const canSplitHere = !exporting && durationMs > 0 && canSplitAt(tracks, playheadSeqMs, splitTarget);

  /** Splits the chosen group, or every eligible group, at the playhead. */
  const splitAtPlayhead = () => {
    if (!canSplitHere) return;
    const next = splitAt(tracks, playheadSeqMs, splitTarget);
    commitTracks(next);
    // The playhead moves onto the second part only when the picture was split.
    if (at && next.main.length > tracks.main.length) seek(timelineMs(next.main, own, at.index + 1, at.sourceMs, overlay), next.main, next);
  };

  const commitTrim = (next: Trim) => {
    setTrimDraft(null);
    const fitted = clampTrim(next, durationMs);
    if (edits.tracks) {
      // Unlinked sound keeps playing at the same moment of the recording.
      const result = reconciled([{ ...savedClips[0], ...fitted }]);
      if (result) commitTracks(shiftUnlinked(result, result.main[0].startMs - savedClips[0].startMs));
    }
    else commitEdits({ ...edits, trim: isWhole(fitted, durationMs) ? null : fitted });
    seek(Math.min(Math.max(currentMs, fitted.startMs), fitted.endMs));
  };

  // --- Undo ---------------------------------------------------------------

  /** Moves to `next` in the history, saves what it holds and keeps the playhead inside its trim. */
  const stepHistory = (next: History<RecordingEdits>) => {
    if (next === history || exporting) return;
    // Undo and redo end a preview of suggested cuts first.
    setSuggestPreview(null);
    setMessage(null);
    setTrimDraft(null);
    setBackdropDraft(undefined);
    setZoomDraft(null);
    setClipDraft(null);
    setHistory(next);
    save(next.present);
    if (durationMs > 0) {
      const nextClips = clipsOf(next.present, own, durationMs);
      const nextTracks = timelineOf(next.present, nextClips, hasAudio);
      const nextOverlay = hasOverlay(nextTracks);
      if (isJoined(nextClips, own) || nextOverlay) {
        // The playhead stays where it was in the clip it was on, else goes to the start.
        const index = at ? nextClips.findIndex((clip) => clip.id === at.clip.id) : -1;
        if (index >= 0 && at) seek(timelineMs(nextClips, own, index, at.sourceMs, nextOverlay), nextClips, nextTracks);
        else seek(timelineMs(nextClips, own, 0, nextClips[0].startMs, nextOverlay), nextClips, nextTracks);
      } else {
        // In the opened recording's own time: from a sequence, where the playhead was in its recording.
        const kept = keptOf(next.present, durationMs);
        const ms = !joined ? currentMs : at && !isGap(at.clip) && at.clip.source === own ? at.sourceMs : nextClips[0].startMs;
        seek(Math.min(Math.max(ms, kept.startMs), kept.endMs), nextClips, nextTracks);
      }
    }
  };

  const undoEdit = () => stepHistory(undo(history));
  const redoEdit = () => stepHistory(redo(history));

  const toggleRemoveNoise = () => {
    if (exporting || !canRemoveNoise) return;
    commitEdits({ ...edits, removeNoise: !removeNoise });
  };

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
      const index = shown.owner.get(zoom.id) ?? positionIn(clips, own, zoom.startMs, overlay)?.index ?? 0;
      const clip = clips[index];
      // A gap shows nothing to zoom on.
      if (isGap(clip)) return [];
      const { offset, low, high } = spanOf(clips, own, index, durationMs, overlay);
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

  const canAddZoom = timelineDuration > 0 && !onGap && addZoom(zooms, currentMs, timelineDuration) !== null;

  const addZoomAt = (ms: number) => {
    const target = positionIn(clips, own, ms, overlay);
    const added = target && isGap(target.clip) ? null : addZoom(zooms, ms, timelineDuration);
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
    const { offset } = spanOf(clips, own, index, durationMs, overlay);
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
    throughGapRef.current = false;
    gapClockRef.current = null;
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
    if (throughGapRef.current) return true;
    if (!now.joined || !now.at || !video) return false;
    if (pendingRef.current) return pendingRef.current.play;
    return now.at.index < now.clips.length - 1 && (video.ended || video.currentTime * 1000 >= now.at.clip.endMs);
  };

  const startVideo = useCallback((video: HTMLVideoElement) => {
    const failed = () => {
      if (video === videoRef.current) setPlaying(false);
    };
    try {
      void video.play()?.catch(failed);
    } catch {
      failed();
    }
  }, []);

  const play = () => {
    const video = videoRef.current;
    if (joined) {
      // From the first clip when at (or past) the end of the last.
      const from = currentMs >= timelineDuration - 50 ? 0 : currentMs;
      if (from !== currentMs) seek(0);
      // Over a gap the playhead runs on its own clock; the video waits for the next clip.
      const pos = positionIn(picture, own, from, overlay);
      if (pos && isGap(pos.clip)) {
        throughGapRef.current = true;
        gapClockRef.current = null;
        setPlaying(true);
        return;
      }
      if (pendingRef.current) {
        pendingRef.current.play = true;
        return;
      }
    } else if (video) {
      // From the trimmed start when at (or past) the trimmed end.
      const now = video.currentTime * 1000;
      if (now < trim.startMs || now >= trim.endMs - 50) seek(trim.startMs);
    }
    if (video) startVideo(video);
  };

  const toggle = () => (playing ? pause() : play());

  /**
   * Starts the video at timeline time `ms` of `list`, where `seek` has just
   * put it, before `list` is on show: a preview of one cut plays at once.
   */
  /** Starts playback from `ms` of `list`, played under the other video tracks of `timeline` when given. */
  const playFrom = (list: Clip[], ms: number, timeline?: Tracks) => {
    if (playing) return;
    const pos = timeline ? positionIn(pictureOf(list, timeline), own, ms, hasOverlay(timeline)) : positionIn(list, own, ms);
    if (pos && isGap(pos.clip)) {
      throughGapRef.current = true;
      gapClockRef.current = null;
      setPlaying(true);
    } else if (pendingRef.current) {
      pendingRef.current.play = true;
    } else if (videoRef.current) {
      startVideo(videoRef.current);
    }
  };

  // A preview of one suggested cut ends itself once the playhead passes a little after the cut.
  const stopAt = previewStop && previewStop.clips === suggestPreview ? previewStop.endMs : null;
  const stopReturnMs = previewStop?.returnMs;
  const stopRef = useRef<{ atMs: number; end: () => void } | null>(null);

  // While playing, the playhead follows every frame and stops at the trimmed end.
  // Joined, it goes on to the next clip at each clip's end, switching recording when it must.
  const endRef = useRef(trim.endMs);
  const playRef = useRef({ clips: picture, joined, own, at: shownAt, ms: currentMs });
  useEffect(() => {
    endRef.current = trim.endMs;
    playRef.current = { clips: picture, joined, own, at: shownAt, ms: currentMs };
    stopRef.current =
      stopAt === null
        ? null
        : {
            atMs: stopAt,
            // The playhead stays on the moment it stopped at, in the sequence as saved.
            end: () => endSuggestPreview(stopReturnMs),
          };
  });
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    /** Goes on from clip `index` to the one after it, which starts at sequence time `start`. */
    const enter = (video: HTMLVideoElement | null, index: number, start: number): boolean => {
      const now = playRef.current;
      const next = now.clips[index + 1] as Clip | undefined;
      if (!next) {
        throughGapRef.current = false;
        gapClockRef.current = null;
        video?.pause();
        setCurrentMs(sequenceDuration(now.clips));
        setPlaying(false);
        stopRef.current?.end();
        return false;
      }
      playRef.current = { ...now, at: { index: index + 1, clip: next, sourceMs: next.startMs }, ms: start };
      setCurrentMs(start);
      if (isGap(next)) {
        // Silence and a black box until the next clip: the video waits, paused.
        throughGapRef.current = true;
        gapClockRef.current = { at: performance.now(), ms: start };
        video?.pause();
        return true;
      }
      throughGapRef.current = false;
      gapClockRef.current = null;
      if (video && next.source === loadedRef.current) {
        video.currentTime = next.startMs / 1000;
        if (video.paused) startVideo(video);
      } else {
        // The new recording plays from its clip's start once it loads.
        pendingRef.current = { source: next.source, sourceMs: next.startMs, play: true };
      }
      return true;
    };
    const step = () => {
      const stop = stopRef.current;
      if (stop && playRef.current.ms >= stop.atMs) {
        stop.end();
        return;
      }
      const video = videoRef.current;
      const gapNow = playRef.current;
      if (gapNow.joined && gapNow.at && isGap(gapNow.at.clip)) {
        // A gap plays on the frame clock, from wherever the playhead is in it.
        // A clip that has just become a gap under the playhead stops its video.
        if (video && !video.paused) {
          throughGapRef.current = true;
          video.pause();
        }
        const time = performance.now();
        const clock = gapClockRef.current && gapClockRef.current.ms <= gapNow.ms ? gapClockRef.current : { at: time, ms: gapNow.ms };
        gapClockRef.current = clock;
        const ms = clock.ms + (time - clock.at);
        const start = clipStarts(gapNow.clips)[gapNow.at.index];
        const end = start + clipLength(gapNow.at.clip);
        if (ms < end) {
          playRef.current = { ...gapNow, ms };
          setCurrentMs(ms);
        } else if (!enter(video, gapNow.at.index, end)) {
          return;
        }
        frame = requestAnimationFrame(step);
        return;
      }
      if (!video) {
        frame = requestAnimationFrame(step);
        return;
      }
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
          if (index === now.clips.length - 1) {
            video.pause();
            setCurrentMs(sequenceDuration(now.clips));
            // A cut's own preview that runs out before its stop ends here.
            stopRef.current?.end();
            return;
          }
          if (!enter(video, index, clipStarts(now.clips)[index + 1])) return;
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
        stopRef.current?.end();
        return;
      }
      setCurrentMs(ms);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, startVideo]);

  const onVideoFailure = useCallback((source: string, message: string) => {
    setMissing((gone) => new Set(gone).add(source));
    setMessage(message);
    if (videoRef.current?.dataset.source === source || pendingRef.current?.source === source) {
      pendingRef.current = null;
      setPlaying(false);
    }
  }, []);

  const onMediaReady = (video: HTMLVideoElement) => {
    const source = video.dataset.source ?? own;
    const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    const known = meta[source];
    const { videoWidth: width, videoHeight: height } = video;
    if (duration > 0 && width > 0 && height > 0 && (known?.durationMs !== duration || known.width !== width || known.height !== height)) {
      setMeta((previous) => ({ ...previous, [source]: { durationMs: duration, width, height } }));
    }
    if (video !== videoRef.current) return;
    const pending = pendingRef.current;
    if (pending && pending.source !== source) return;
    if (!pending && loadedRef.current === source) return;
    loadedRef.current = source;
    pendingRef.current = null;
    const sourceMs = pending?.sourceMs ?? (joined ? shownAt?.sourceMs ?? 0 : keptOf(edits, duration).startMs);
    try {
      video.currentTime = sourceMs / 1000;
    } catch {
      // The first frame or canplay event retries a seek rejected during metadata loading.
      pendingRef.current = { source, sourceMs, play: pending?.play ?? false };
      return;
    }
    if (!pending && !joined) setCurrentMs(sourceMs);
    if (pending?.play) startVideo(video);
  };

  // Space plays and pauses, unless a control has the keyboard. Ctrl/⌘ Z
  // undoes, and Ctrl/⌘ Shift Z or Ctrl Y redoes, unless a field has the text.
  // Alt and the arrow keys move the selected clip; Delete removes it and
  // Shift Delete leaves a gap. S splits at the playhead; Ctrl/⌘ D duplicates.
  // Esc ends a preview of suggested cuts, unless a field or dialog has it.
  const keysRef = useRef({
    toggle,
    undoEdit,
    redoEdit,
    moveSelectedClip,
    removeSelectedClip,
    leaveGapForSelected,
    duplicateSelectedClip,
    splitAtPlayhead,
    endSuggestPreview,
    hasClip: false,
    previewing: false,
    dialogOpen: false,
  });
  useEffect(() => {
    keysRef.current = {
      toggle,
      undoEdit,
      redoEdit,
      moveSelectedClip,
      removeSelectedClip,
      leaveGapForSelected,
      duplicateSelectedClip,
      splitAtPlayhead,
      endSuggestPreview,
      hasClip: selectedClip !== null && !selectedZoom && !selectedShowing && !exporting,
      previewing: suggestPreview !== null,
      dialogOpen: backdropOpen || captionsOpen,
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (event.key === "Escape" && keysRef.current.previewing && !keysRef.current.dialogOpen && !event.defaultPrevented && !isEditingText(event.target)) {
        const inDialog = event.target instanceof Element && event.target.closest('[role="dialog"]') !== null;
        if (!inDialog) {
          event.preventDefault();
          keysRef.current.endSuggestPreview();
          return;
        }
      }
      if (mod && !event.altKey && (key === "z" || key === "y")) {
        if (isEditingText(event.target)) return;
        event.preventDefault();
        if (key === "y" || event.shiftKey) keysRef.current.redoEdit();
        else keysRef.current.undoEdit();
        return;
      }
      if (mod && !event.altKey && !event.shiftKey && key === "d" && keysRef.current.hasClip && !isTyping(event.target)) {
        event.preventDefault();
        keysRef.current.duplicateSelectedClip();
        return;
      }
      if (!mod && !event.altKey && !event.shiftKey && key === "s" && !isTyping(event.target)) {
        event.preventDefault();
        keysRef.current.splitAtPlayhead();
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
          if (event.shiftKey) keysRef.current.leaveGapForSelected();
          else keysRef.current.removeSelectedClip();
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

  // A click outside the captions panel closes it.
  useEffect(() => {
    if (!captionsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !captionsRef.current?.contains(event.target)) setCaptionsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [captionsOpen]);

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

  // --- Captions -----------------------------------------------------------

  const commitCaptions = (next: Captions) => commitEdits({ ...edits, captions: { ...next, cues: sortCues(next.cues) } });

  /** Where showing `key` may reach on the timeline: its clip. */
  const cueRoom = (key: string) => {
    const showing = savedShowings.find((each) => each.key === key);
    if (!showing) return { low: 0, high: timelineDuration };
    const clip = spanOf(clips, own, showing.index, durationMs);
    // Cues never overlap by hand: a showing stops at its neighbours in the same clip.
    let low = clip.low;
    let high = clip.high;
    for (const other of savedShowings) {
      if (other.key === key || other.index !== showing.index || other.cue.id === showing.cue.id) continue;
      if (other.endMs <= showing.startMs) low = Math.max(low, other.endMs);
      else if (other.startMs >= showing.endMs) high = Math.min(high, other.startMs);
    }
    return { low, high };
  };

  /**
   * Keeps a showing's new place, moving its cue in its recording's time.
   * A showing may be clipped to its clip, so a move shifts the whole cue by
   * the same amount and a resize changes only the edge that was dragged:
   * the part of the cue hidden outside the clip is kept.
   */
  const commitCueSpan = (span: CueSpan) => {
    setCaptionDraft(null);
    const showing = savedShowings.find((each) => each.key === span.key);
    if (!showing) return;
    const startDelta = span.startMs - showing.startMs;
    const endDelta = span.endMs - showing.endMs;
    if (startDelta === 0 && endDelta === 0) return;
    const { offset } = spanOf(clips, own, showing.index, durationMs);
    const { cue } = showing;
    const next =
      startDelta === endDelta
        ? { ...cue, startMs: cue.startMs + startDelta, endMs: cue.endMs + endDelta }
        : {
            ...cue,
            startMs: startDelta === 0 ? cue.startMs : span.startMs - offset,
            endMs: endDelta === 0 ? cue.endMs : span.endMs - offset,
          };
    if (next.endMs <= next.startMs) return;
    commitCaptions({ ...captions, cues: replaceCue(captions.cues, next) });
  };

  const deleteShowing = (key: string) => {
    const showing = savedShowings.find((each) => each.key === key);
    if (!showing) return;
    setSelectedCueKey(null);
    setCueTextDraft(null);
    commitCaptions({ ...captions, cues: removeCue(captions.cues, showing.cue.id) });
  };

  /** Adds an empty cue at timeline time `ms`, on a clip and clear of the cues there. */
  const addCueAt = (ms: number) => {
    const target = positionIn(clips, own, ms);
    if (!target || isGap(target.clip)) {
      setMessage("Captions go on clips, not gaps.");
      return;
    }
    if (showings.some((each) => ms >= each.startMs && ms < each.endMs)) return;
    const { low, high } = spanOf(clips, own, target.index, durationMs);
    const next = Math.min(high, ...showings.filter((each) => each.index === target.index && each.startMs > ms).map((each) => each.startMs));
    const startMs = Math.max(low, Math.min(ms, next - MIN_CUE_MS));
    const endMs = Math.min(next, startMs + DEFAULT_CUE_MS);
    if (endMs - startMs < MIN_CUE_MS) {
      setMessage("There is no room for a caption there.");
      return;
    }
    const { offset } = spanOf(clips, own, target.index, durationMs);
    const cue: Cue = tagCue({ id: newCueId(), startMs: startMs - offset, endMs: endMs - offset, text: "" }, target.clip.source, own);
    commitCaptions({ ...captions, cues: [...captions.cues, cue] });
    const clip = clips[target.index];
    setSelectedCueKey(joined ? `${cue.id}@${clip.id}` : cue.id);
    setSelectedZoomId(null);
    setSelectedClipId(null);
    setCueTextDraft("");
  };

  /** Keeps the selected cue's typed text. */
  const commitCueText = (showing: CueShowing, text: string) => {
    setCueTextDraft(null);
    if (text === showing.cue.text) return;
    commitCaptions({ ...captions, cues: replaceCue(captions.cues, { ...showing.cue, text }) });
  };

  const toggleBurnIn = () => commitCaptions({ ...captions, burnIn: !captions.burnIn });

  const setCaptionStyle = (change: Partial<CaptionStyle>) => commitCaptions(withStyle(captions, change));

  /** The saved sequence's cues, in its exported time. */
  const savedSubtitles = useMemo(() => subtitleCues(captions.cues, savedClips, own), [captions.cues, savedClips, own]);

  /** Asks where, then saves the captions as SRT or WebVTT, chosen by the file's extension. */
  const saveSubtitlesNow = async () => {
    if (!info || savedSubtitles.length === 0) return;
    setCaptionsMessage(null);
    try {
      const path = await chooseSubtitlesFile(info.fileName);
      if (!path) return;
      await saveSubtitles(path, savedSubtitles);
      setCaptionsMessage(`Saved ${fileName(path)}`);
    } catch (err) {
      setCaptionsMessage(`Could not save subtitles: ${errorText(err)}`);
    }
  };

  /**
   * Puts in the cues of the recordings in `done`, with the latest edits, for
   * when transcribing ends after other edits. With `all`, every other cue
   * goes; otherwise only `done`'s recordings' cues are replaced.
   */
  const replaceCuesRef = useRef<(cues: Cue[], done: string[], all: boolean) => void>(() => undefined);
  useEffect(() => {
    replaceCuesRef.current = (cues: Cue[], done: string[], all: boolean) => {
      const kept = all ? [] : captions.cues.filter((cue) => !done.some((source) => cueOnSource(cue, source, own)));
      commitCaptions({ ...captions, cues: [...kept, ...cues] });
    };
  });
  /** Set by Cancel, so a cancel between two recordings still stops the run. */
  const transcribeCancelledRef = useRef(false);

  /**
   * Transcribes every recording in the sequence that has no transcript yet,
   * reads the saved transcript of the rest, and replaces the cues with
   * theirs. Cues already there wait for `confirmed`. When cancelled or
   * failing part way, the recordings already done keep their new cues.
   */
  const transcribe = async (confirmed: boolean) => {
    if (transcribing || readOnly) return;
    if (captions.cues.length > 0 && !confirmed) {
      setConfirmReplace(true);
      return;
    }
    setConfirmReplace(false);
    setCaptionsMessage(null);
    transcribeCancelledRef.current = false;
    setTranscribing({ source: "", stage: "transcribe", done: 0, total: 0 });
    let unlisten: (() => void) | null = null;
    const cues: Cue[] = [];
    const done: string[] = [];
    try {
      unlisten = await onTranscribeProgress(setTranscribing).catch(() => null);
      const stopIfCancelled = () => {
        if (transcribeCancelledRef.current) throw new Error(TRANSCRIBE_CANCELLED);
      };
      for (const source of sequenceSources) {
        stopIfCancelled();
        let transcript = await recordingTranscript(source);
        if (!transcript) {
          stopIfCancelled();
          transcript = await recordingTranscribe(source);
        }
        // A recording's length cuts off any cue Whisper heard past its end.
        cues.push(...cuesFromTranscript(transcript, source, own, newCueId, meta[source]?.durationMs || undefined));
        done.push(source);
      }
      if (cues.length === 0) {
        setCaptionsMessage("No sound to transcribe. Double-click the caption row to add captions by hand.");
        return;
      }
      replaceCuesRef.current(cues, done, true);
      setCaptionsMessage(`Made ${cues.length} caption${cues.length === 1 ? "" : "s"}.`);
    } catch (err) {
      if (cues.length > 0) replaceCuesRef.current(cues, done, false);
      const reason = errorText(err);
      setCaptionsMessage(reason === TRANSCRIBE_CANCELLED ? reason : `Could not transcribe: ${reason}`);
    } finally {
      unlisten?.();
      setTranscribing(null);
      setCancellingTranscribe(false);
    }
  };

  const stopTranscribe = async () => {
    transcribeCancelledRef.current = true;
    setCancellingTranscribe(true);
    try {
      await cancelTranscribe();
    } catch (err) {
      setCaptionsMessage(`Could not cancel: ${errorText(err)}`);
      setCancellingTranscribe(false);
    }
  };

  /** Each showing's caption painted as a PNG over the export's video box. */
  const captionOverlays = async (shape: { x: number; y: number; videoWidth: number; videoHeight: number }): Promise<ExportOverlayImage[]> => {
    if (!captions.burnIn) return [];
    const overlays: ExportOverlayImage[] = [];
    // In the exported sequence's time: a lone trimmed recording is one clip from 0.
    for (const { cue, startMs, endMs } of cueShowings(captions.cues, savedClips, own, true)) {
      const painted = await cuePng(cue.text, captionStyle, shape.videoWidth, shape.videoHeight);
      if (!painted) continue;
      overlays.push({ startMs, endMs, x: shape.x + painted.box.x, y: shape.y + painted.box.y, width: painted.box.width, height: painted.box.height, png: painted.png });
    }
    return overlays;
  };

  // --- Export -------------------------------------------------------------

  const stopExport = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelExport();
    } catch (err) {
      setCancelError(`Could not cancel export: ${errorText(err)}`);
      setCancelling(false);
    }
  };

  const exportNow = async () => {
    if (!videoSize || !layout || exporting || !canExport) return;
    pause();
    setMessage(null);
    setCancelError(null);
    setProgress({ done: 0, total: 0 });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onExportProgress(setProgress).catch(() => null);
      const shape = recordingLayout(videoSize, edits.backdrop);
      const layers = edits.backdrop ? await exportLayers(shape, edits.backdrop, sources()) : null;
      // Every video track flattened: the highest with a clip shows (see tracks.ts).
      const picture = flattenPicture(tracks);
      const owners = zoomOwners(picture, allZooms, own);
      const exportClips = picture.map((clip, index): ExportEntry => {
        if (isGap(clip)) return { gapMs: clipLength(clip) };
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
      const overlays = await captionOverlays(shape);
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
          removeNoise,
          ...(plannedAudio ? { audio: plannedAudio } : {}),
        },
        layers,
        overlays,
      );
      setMessage(`Exported ${fileName(saved)}`);
    } catch (err) {
      const reason = errorText(err);
      setMessage(reason === "Export cancelled" ? reason : `Export failed: ${reason}`);
    } finally {
      setCancelling(false);
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
  const clipMs = joined ? timelineDuration : trim.endMs - trim.startMs;
  const fit =
    layout && currentMeta && currentSource !== own ? fitInside(currentMeta.width, currentMeta.height, layout.videoWidth, layout.videoHeight) : null;
  const fitStyle = fit && layout ? { left: share(fit.x, layout.videoWidth), top: share(fit.y, layout.videoHeight), width: share(fit.width, layout.videoWidth), height: share(fit.height, layout.videoHeight) } : { inset: 0 };
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const status = exporting ? `Exporting… ${percent}%` : (message ?? saveText(saveStatus));
  // While an area zoom is chosen, the whole frame shows with the area on it.
  const picking = selectedZoom?.focus.kind === "area" && !playing && !exporting;
  /** The timeline zoom as shown: never past what its length and width allow. */
  const zoomLimit = maxZoom(timelineDuration, timelineWidth);
  const shownZoom = zoomFor(timelineScale, timelineDuration, timelineWidth);
  // The view comes from the current clip's zooms, in its recording's time.
  const currentOffset = at ? spanOf(clips, own, at.index, durationMs, overlay).offset : 0;
  const currentZooms = zooms
    .filter((zoom) => !joined || (shown.owner.get(zoom.id) ?? positionIn(clips, own, zoom.startMs, overlay)?.index) === at?.index)
    .map((zoom) => ({ ...zoom, startMs: zoom.startMs - currentOffset, endMs: zoom.endMs - currentOffset }));
  // Under other video tracks the piece on show takes the zooms on its own recording, as the export gives it.
  const shownPiece = overlay && shownAt && !isGap(shownAt.clip) ? shownAt : null;
  const pieceZooms = shownPiece ? zoomsIn(allZooms, shownPiece.clip, own).filter((zoom) => zoomOwners(picture, allZooms, own).get(zoom.id) === shownPiece.index) : null;
  const view = picking ? FULL_VIEW : pieceZooms && shownPiece ? viewAt(pieceZooms, shownPiece.sourceMs, cursor) : viewAt(currentZooms, at?.sourceMs ?? currentMs, cursor);
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
        <div className="bar-group">
          <details className="track-menu">
            <summary className="text-button" title="Add a track">Track</summary>
            <div className="track-menu-items" role="menu">
              <button type="button" role="menuitem" className="text-button" disabled={readOnly || exporting} onClick={(event) => {
                  addTrackOf("video");
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}>
                Add video track
              </button>
              <button type="button" role="menuitem" className="text-button" disabled={readOnly || exporting} onClick={(event) => {
                  addTrackOf("audio");
                  event.currentTarget.closest("details")?.removeAttribute("open");
                }}>
                Add audio track
              </button>
            </div>
          </details>
          <button type="button" className="text-button" onClick={linkChosen} disabled={!canLink || exporting} title="Link the selected clips so they are edited together">
            Link
          </button>
          <button type="button" className="text-button" onClick={unlinkChosen} disabled={!canUnlink || exporting} title="Unlink the selected clips, so the sound can move on its own">
            Unlink
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
        <div
          className="bar-group backdrop-anchor"
          ref={captionsRef}
          onKeyDown={(event) => {
            if (event.key === "Escape") setCaptionsOpen(false);
          }}
        >
          <button
            type="button"
            className="text-button"
            aria-haspopup="dialog"
            aria-expanded={captionsOpen}
            data-on={captions.cues.length > 0 ? "true" : undefined}
            disabled={!info || exporting}
            onClick={() => {
              if (!captionsOpen) {
                transcribeModel()
                  .then(setModel)
                  .catch(() => setModel(null));
              }
              setCaptionsOpen(!captionsOpen);
            }}
          >
            Captions
          </button>
          {captionsOpen && (
            <section className="captions-panel" role="dialog" aria-label="Captions">
              {transcribing ? (
                <>
                  <p role="status">
                    {transcribing.stage === "download" ? "Downloading the speech model…" : "Transcribing…"}
                    {transcribing.total > 0 ? ` ${Math.round((transcribing.done / transcribing.total) * 100)}%` : ""}
                  </p>
                  <div
                    className="recording-progress"
                    role="progressbar"
                    aria-label="Transcribe progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={transcribing.total > 0 ? Math.round((transcribing.done / transcribing.total) * 100) : 0}
                  >
                    <div style={{ width: `${transcribing.total > 0 ? (transcribing.done / transcribing.total) * 100 : 0}%` }} />
                  </div>
                  <button type="button" className="text-button" disabled={cancellingTranscribe} onClick={() => void stopTranscribe()}>
                    {cancellingTranscribe ? "Cancelling…" : "Cancel"}
                  </button>
                </>
              ) : confirmReplace ? (
                <>
                  <p>Replace the {captions.cues.length} caption{captions.cues.length === 1 ? "" : "s"} with new ones? Your corrections are lost.</p>
                  <div className="captions-actions">
                    <button type="button" className="primary" onClick={() => void transcribe(true)}>
                      Replace captions
                    </button>
                    <button type="button" className="text-button" onClick={() => setConfirmReplace(false)}>
                      Keep them
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    Transcribes each recording in the sequence on this computer; nothing leaves it.
                    {model?.downloaded ? "" : ` First Grab-it downloads the speech model once${model ? `, ${Math.round(model.bytes / 1_000_000)} MB` : ""}.`}
                  </p>
                  <button type="button" className="primary" disabled={readOnly || sequenceSources.length === 0} onClick={() => void transcribe(false)}>
                    Transcribe
                  </button>
                </>
              )}
              {captionsMessage && <p role="status">{captionsMessage}</p>}
              <label>
                <input type="checkbox" checked={captions.burnIn} disabled={readOnly || exporting} onChange={toggleBurnIn} /> Burn in captions
              </label>
              {CAPTION_STYLE_CONTROLS.map(({ label, key, options }) => (
                <div className="captions-style" key={key}>
                  <span id={`caption-${key}`}>{label}</span>
                  <div className="bar-group segmented" role="group" aria-labelledby={`caption-${key}`}>
                    {options.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={captionStyle[key] === option.value}
                        disabled={readOnly || exporting}
                        onClick={() => setCaptionStyle({ [key]: option.value } as Partial<CaptionStyle>)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="text-button"
                disabled={savedSubtitles.length === 0 || exporting}
                title={savedSubtitles.length === 0 ? "Add captions to save them as subtitles" : "Save the captions as an SRT or WebVTT file"}
                onClick={() => void saveSubtitlesNow()}
              >
                Save subtitles…
              </button>
            </section>
          )}
        </div>
        <div className="bar-group">
          <button
            type="button"
            className="icon-button"
            aria-label="Remove background noise"
            aria-pressed={canRemoveNoise && removeNoise}
            disabled={!canRemoveNoise || exporting}
            title={canRemoveNoise ? NOISE_USE : NOISE_UNAVAILABLE}
            onClick={toggleRemoveNoise}
          >
            <NoiseIcon size={18} />
          </button>
        </div>
        <div className="bar-group">
          <button
            type="button"
            className="text-button"
            onClick={() => void addRecording()}
            disabled={!info || readOnly || exporting}
            title={targetTrack ? `Place a recording from the recordings folder on ${targetTrack.name} at the playhead` : "Join a recording from the recordings folder after the clip under the playhead"}
          >
            <AddIcon />
            Recording
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => addZoomAt(currentMs)}
            disabled={!canAddZoom || exporting}
            title={canAddZoom ? "Zoom in from the playhead" : onGap ? "Move the playhead onto a clip to add a zoom" : "Move the playhead clear of the other zooms to add one"}
          >
            <ZoomInIcon />
            Zoom
          </button>
          <button
            type="button"
            className="text-button"
            aria-expanded={suggestOpen}
            onClick={() => (suggestOpen ? closeSuggestions() : setSuggestOpen(true))}
            disabled={!info || readOnly || exporting || durationMs <= 0}
            title="Propose cuts where the recording pauses, to preview and apply together"
          >
            Suggest edits
          </button>
          <button
            type="button"
            className="text-button"
            onClick={splitAtPlayhead}
            disabled={!canSplitHere}
            title={canSplitHere ? "Split the clip at the playhead (S)" : "Move the playhead at least half a second inside a clip to split it"}
          >
            <SplitIcon />
            Split
          </button>
        </div>
        {selectedShowing && (
          <div className="bar-group caption-controls" role="group" aria-label="Caption">
            <input
              type="text"
              className="caption-text-field"
              aria-label="Caption text"
              placeholder="Type the caption"
              value={cueTextDraft ?? selectedShowing.cue.text}
              disabled={exporting || readOnly}
              onChange={(event) => setCueTextDraft(event.target.value)}
              onBlur={(event) => commitCueText(selectedShowing, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitCueText(selectedShowing, event.currentTarget.value);
                if (event.key === "Escape") setCueTextDraft(null);
              }}
            />
            <button type="button" className="icon-button" aria-label="Delete caption" title="Delete caption" onClick={() => deleteShowing(selectedShowing.key)} disabled={exporting}>
              <TrashIcon />
            </button>
          </div>
        )}
        {selectedClip && !selectedZoom && !selectedShowing && (
          <div className="bar-group" role="group" aria-label={isGap(selectedClip) ? "Gap" : `Clip ${selectedClip.source}`}>
            {!isGap(selectedClip) && (
              <button type="button" className="text-button" onClick={duplicateSelectedClip} disabled={exporting} title="Copy the clip right after itself (Ctrl+D)">
                <CopyIcon />
                Duplicate
              </button>
            )}
            <button
              type="button"
              className="text-button"
              onClick={removeSelectedClip}
              disabled={exporting || !canRemove(clips, selectedClip.id)}
              title={canRemove(clips, selectedClip.id) ? (isGap(selectedClip) ? "Close the gap (Delete)" : "Delete the clip and close the gap it leaves (Delete)") : "The last clip cannot be deleted"}
            >
              <TrashIcon />
              Delete
            </button>
            {!isGap(selectedClip) && (
              <button
                type="button"
                className="text-button"
                onClick={leaveGapForSelected}
                disabled={exporting || !canRemove(clips, selectedClip.id)}
                title={canRemove(clips, selectedClip.id) ? "Delete the clip and leave a gap of its length (Shift+Delete)" : "The last clip cannot be deleted"}
              >
                <GapIcon />
                Leave gap
              </button>
            )}
          </div>
        )}
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
            title={missingSource ? `${missingSource} is missing, so the sequence cannot be exported` : "Save the edited recording beside the original"}
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
            <div className="recording-fit" style={fitStyle} data-gap={onGap ? "true" : undefined} data-testid="recording-fit">
            {previewSources.map((source) => {
              const path = pathOf(source);
              if (!path) return null;
              const active = source === currentSource;
              return (
                <RecordingVideo
                  key={path}
                  path={path}
                  source={source}
                  active={active}
                  activeRef={videoRef}
                  silent={ownSound}
                  onReady={onMediaReady}
                  onFailure={onVideoFailure}
                  style={{ transform: viewTransform(view) }}
                  onPlay={active ? () => setPlaying(true) : undefined}
                  onPause={active ? () => { if (!handingOn()) setPlaying(false); } : undefined}
                  onEnded={active ? () => { if (!handingOn()) setPlaying(false); } : undefined}
                  onSeeked={active ? () => setFrameTick((tick) => tick + 1) : undefined}
                  onTimeUpdate={active ? (event) => {
                    if (playing || pendingRef.current || onGap) return;
                    const ms = event.currentTarget.currentTime * 1000;
                    setCurrentMs(joined && at ? toSequence(clips, at.index, ms) : ms);
                  } : undefined}
                  onClick={active ? toggle : undefined}
                />
              );
            })}
            {/* Sound plays on over gaps, as the export mixes it there. */}
            {ownSound && <TrackAudio clips={shownTracks.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.clips)} pathOf={pathOf} currentMs={joined ? currentMs : currentMs - trim.startMs} playing={playing} />}
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
            {playheadCue && layout && !onGap && playheadCue.cue.text.trim() && (
              <CaptionPreview text={playheadCue.cue.text} style={captionStyle} width={layout.videoWidth} height={layout.videoHeight} />
            )}
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
          scale={timelineScale}
          onScaleChange={setTimelineScale}
          follow={playing}
          onViewChange={setTimelineView}
        >
          <TrackRows
            placement="above"
            timeline={shownTracks}
            durationMs={timelineDuration}
            offsetMs={joined ? 0 : trim.startMs}
            currentMs={joined ? currentMs : currentMs - trim.startMs}
            selected={chosenIds}
            onSelect={(id, adding) => {
              setTrackSelection((chosen) => (adding ? new Set(chosen).add(id) : new Set([id])));
              if (!adding) setSelectedClipId(null);
              setSelectedZoomId(null);
            }}
            onMove={moveTrackClip}
            onRename={(id, name) => commitTracks(renameTrack(tracks, id, name))}
            onLock={(id, locked) => commitTracks(lockTrack(tracks, id, locked))}
            onRemove={removeTrackById}
            selectedTrackId={targetTrack?.id ?? null}
            onSelectTrack={(id) => setSelectedTrackId((was) => (was === id ? null : id))}
          />
          {(joined || (suggestOpen && !exporting)) && (
            <ClipTrack
              clips={clips}
              durationMs={timelineDuration}
              offsetMs={joined ? 0 : (clips[0]?.startMs ?? 0)}
              // A lone clip is trimmed with the timeline's handles; here it only carries the hatches.
              editable={joined}
              cuts={hatchedCuts}
              focusedCutId={shownCuts?.focusId ?? null}
              onFocusCut={(id) => setCutFocusRequest({ id })}
              sourceDuration={(source) => meta[source]?.durationMs ?? 0}
              missing={missing}
              selectedId={selectedClip?.id ?? null}
              onSelect={(id, adding) => {
                if (isLockedClip(tracks, id)) return;
                if (adding) {
                  setTrackSelection((chosen) => new Set(chosen).add(id));
                  return;
                }
                setSelectedClipId(id);
                setTrackSelection(new Set());
                setSelectedZoomId(null);
                setSelectedCueKey(null);
              }}
              onTrimPreview={setClipDraft}
              onTrimCommit={(next) => {
                commitClips(next);
                const pos = at ? next.findIndex((clip) => clip.id === at.clip.id) : -1;
                if (pos >= 0 && at) seek(timelineMs(next, own, pos, at.sourceMs, overlay), next);
              }}
              onMove={(id, to) => {
                const next = moveClip(clips, id, to);
                if (next === clips) return;
                commitClips(next);
                const index = movedIndex(next, id, to);
                setSelectedClipId(next[index].id);
                seek(timelineMs(next, own, index, next[index].startMs, overlay), next);
              }}
            />
          )}
          <TrackRows
            timeline={shownTracks}
            durationMs={timelineDuration}
            offsetMs={joined ? 0 : trim.startMs}
            endMs={sequenceDuration(savedClips)}
            currentMs={joined ? currentMs : currentMs - trim.startMs}
            selected={chosenIds}
            onSelect={(id, adding) => {
              setTrackSelection((chosen) => (adding ? new Set(chosen).add(id) : new Set([id])));
              if (!adding) setSelectedClipId(null);
              setSelectedZoomId(null);
            }}
            onMove={moveTrackClip}
            onRename={(id, name) => commitTracks(renameTrack(tracks, id, name))}
            onLock={(id, locked) => commitTracks(lockTrack(tracks, id, locked))}
            onRemove={removeTrackById}
            selectedTrackId={targetTrack?.id ?? null}
            onSelectTrack={(id) => setSelectedTrackId((was) => (was === id ? null : id))}
          />
          <ZoomTrack
            durationMs={timelineDuration}
            zooms={zooms}
            selectedId={selectedZoom?.id ?? null}
            onSelect={(id) => {
              setSelectedZoomId(id);
              if (id) {
                setSelectedClipId(null);
                setSelectedCueKey(null);
              }
            }}
            onPreview={setZoomDraft}
            onCommit={commitZooms}
            onAdd={addZoomAt}
            onSeek={(ms) => seek(Math.min(Math.max(ms, trim.startMs), trim.endMs))}
          />
          <CaptionTrack
            durationMs={timelineDuration}
            showings={showings}
            selectedKey={selectedShowing?.key ?? null}
            onSelect={(key) => {
              if (key !== selectedCueKey) setCueTextDraft(null);
              setSelectedCueKey(key);
              if (key) {
                setSelectedClipId(null);
                setSelectedZoomId(null);
              }
            }}
            room={cueRoom}
            onPreview={setCaptionDraft}
            onCommit={commitCueSpan}
            onDelete={deleteShowing}
            onAdd={addCueAt}
            onSeek={(ms) => seek(Math.min(Math.max(ms, trim.startMs), trim.endMs))}
          />
          <WaveformLanes
            clips={clips}
            joined={joined}
            durationMs={timelineDuration}
            trim={trim}
            audioOf={audioOf}
            nameOf={(kind) => SOURCE_NAMES[kind]}
            hintOf={(kind) => (kind === "mixed" ? MIXED_SOUND_HINT : undefined)}
            view={timelineView?.track ?? null}
            sound={ownSound ? shownTracks.tracks.filter((track) => track.kind === "audio").flatMap((track) => track.clips) : null}
            soundOffsetMs={joined ? 0 : trim.startMs}
            soundEndMs={sequenceDuration(savedClips)}
          />
        </Timeline>
        <div className="timeline-zoom" role="group" aria-label="Timeline zoom">
          <button
            type="button"
            className="icon-button"
            onClick={() => setTimelineScale(stepScale(timelineScale, -1, timelineDuration, timelineWidth))}
            disabled={shownZoom <= 1}
            aria-label="Zoom out"
            title={`Zoom the timeline out (${ZOOM_WHEEL})`}
          >
            <ZoomOutIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setTimelineScale(stepScale(timelineScale, 1, timelineDuration, timelineWidth))}
            disabled={shownZoom >= zoomLimit}
            aria-label="Zoom in"
            title={`Zoom the timeline in (${ZOOM_WHEEL})`}
          >
            <ZoomInIcon />
          </button>
          <button type="button" className="icon-button" onClick={() => setTimelineScale(null)} disabled={shownZoom <= 1} aria-label="Fit" title="Fit the whole timeline in view">
            <FitIcon />
          </button>
        </div>
      </div>
      {suggestOpen && info && !exporting && (
        <SuggestEditsPanel
          clips={savedClips}
          own={own}
          joined={isJoined(savedClips, own)}
          previewing={suggestPreview !== null}
          tracks={tracks.tracks}
          onPreview={(next, fromMs, endMs, returnMs, cutTracks) => {
            if (!next) {
              endSuggestPreview();
              return;
            }
            // The panel gives sequence time; a lone clip of the opened recording plays in its own time, unless other video tracks hold clips.
            const previewTracks: Tracks = cutTracks ? { main: next, tracks: cutTracks } : tracks;
            const previewJoined = isJoined(next, own) || hasOverlay(previewTracks);
            const onTimeline = (ms: number) => (previewJoined ? ms : next[0].startMs + ms);
            setClipDraft(null);
            setSuggestPreview(next);
            setSuggestTracks(cutTracks ?? null);
            // The stop never lies past the preview's end, where playback halts on its own.
            const lastMs = previewJoined ? Math.max(sequenceDuration(next), sequenceDuration(pictureOf(next, previewTracks))) : next[0].endMs;
            // The saved sequence's time, too, is the recording's own when it is a lone clip of it.
            const savedTimeline = (ms: number) => (isJoined(savedClips, own) || hasOverlay(tracks) ? ms : savedClips[0].startMs + ms);
            setPreviewStop(
              endMs === undefined ? null : { clips: next, endMs: Math.min(onTimeline(endMs), lastMs), returnMs: returnMs === undefined ? undefined : savedTimeline(returnMs) },
            );
            const from = onTimeline(fromMs ?? 0);
            seek(from, next, previewTracks);
            if (endMs !== undefined) playFrom(next, from, previewTracks);
          }}
          onShowCuts={setShownCuts}
          focusRequest={cutFocusRequest}
          onApply={(next, cutTracks) => {
            setSuggestPreview(null);
            setMessage(null);
            if (cutTracks) commitTracks({ main: next, tracks: cutTracks }, true);
            else commitClips(next, true);
            seek(Math.min(currentMs, sequenceDuration(next)), next, cutTracks ? { main: next, tracks: cutTracks } : tracks);
          }}
          onClose={closeSuggestions}
        />
      )}
      {exporting && (
        <section className="recording-export-panel" aria-label="Video export">
          <strong>Exporting… {percent}%</strong>
          <div className="recording-progress" role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div style={{ width: `${percent}%` }} />
          </div>
          <button type="button" className="text-button" disabled={!progress.total || cancelling} onClick={() => void stopExport()}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
          {cancelError && <span role="alert">{cancelError}</span>}
        </section>
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
