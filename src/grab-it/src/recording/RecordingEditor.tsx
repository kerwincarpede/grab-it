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
import { exportRecording, fetchRecording, onExportProgress, playsFromBlob, recordingInfo, saveEdits, videoSrc, type AudioKind, type ExportProgress, type RecordingInfo } from "./api";
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

/**
 * The URL the video plays `path` from: the grab-it-video scheme itself, or
 * on Linux a blob of the file fetched from it, revoked when the path
 * changes or the editor closes. Null while the blob is on its way.
 */
function usePlayableSrc(path: string | null, onError: (message: string) => void): string | null {
  const blob = playsFromBlob();
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!path || !blob) return;
    let url: string | null = null;
    let cancelled = false;
    fetchRecording(videoSrc(path))
      .then((data) => {
        if (cancelled) return;
        url = URL.createObjectURL(data);
        setLoaded({ path, url });
      })
      .catch((err: unknown) => !cancelled && onError(`The recording cannot be played: ${errorText(err)}`));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, blob, onError]);
  if (!path) return null;
  if (!blob) return videoSrc(path);
  return loaded && loaded.path === path ? loaded.url : null;
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
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [durationMs, setDurationMs] = useState(0);
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
  const src = usePlayableSrc(info?.path ?? null, setMessage);

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

  const backdrop = backdropDraft !== undefined ? backdropDraft : (edits.backdrop ?? null);
  const savedTrim = trimOf(edits, durationMs);
  const zooms = zoomDraft ?? edits.zooms ?? [];
  const selectedZoom = zooms.find((zoom) => zoom.id === selectedZoomId) ?? null;
  const cursor = info?.cursor ?? null;
  const trim = trimDraft ?? savedTrim;
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

  const seek = (ms: number) => {
    const video = videoRef.current;
    setCurrentMs(ms);
    try {
      if (video) video.currentTime = ms / 1000;
    } catch {
      // Not seekable yet: it opens at the start.
    }
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
    setHistory(next);
    save(next.present);
    if (durationMs > 0) {
      const kept = trimOf(next.present, durationMs);
      seek(Math.min(Math.max(currentMs, kept.startMs), kept.endMs));
    }
  };

  const undoEdit = () => stepHistory(undo(history));
  const redoEdit = () => stepHistory(redo(history));

  const commitBackdrop = (next: Backdrop | null) => {
    setBackdropDraft(undefined);
    commitEdits({ ...edits, backdrop: next });
  };

  // --- Zooms --------------------------------------------------------------

  const commitZooms = (next: Zoom[]) => {
    setZoomDraft(null);
    commitEdits({ ...edits, zooms: next });
  };

  const canAddZoom = durationMs > 0 && addZoom(zooms, currentMs, durationMs) !== null;

  const addZoomAt = (ms: number) => {
    const added = addZoom(zooms, ms, durationMs);
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
    const [x, y] = clampCentre(cursorAt(cursor, zoom.startMs) ?? [0.5, 0.5], zoom.scale);
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

  const pause = () => videoRef.current?.pause();

  const play = () => {
    const video = videoRef.current;
    if (!video) return;
    // From the trimmed start when at (or past) the trimmed end.
    const at = video.currentTime * 1000;
    if (at < trim.startMs || at >= trim.endMs - 50) seek(trim.startMs);
    try {
      void video.play()?.catch(() => setPlaying(false));
    } catch {
      setPlaying(false);
    }
  };

  const toggle = () => (playing ? pause() : play());

  // While playing, the playhead follows every frame and stops at the trimmed end.
  const endRef = useRef(trim.endMs);
  useEffect(() => {
    endRef.current = trim.endMs;
  });
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const step = () => {
      const video = videoRef.current;
      if (!video) return;
      const ms = video.currentTime * 1000;
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
    if (video.videoWidth > 0 && video.videoHeight > 0) setVideoSize({ width: video.videoWidth, height: video.videoHeight });
    const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    setDurationMs(duration);
    // Opens at the start of the trimmed stretch.
    const start = trimOf(edits, duration).startMs;
    if (start > 0) seek(start);
  };

  // Space plays and pauses, unless a control has the keyboard. Ctrl/⌘ Z
  // undoes, and Ctrl/⌘ Shift Z or Ctrl Y redoes, unless a field has the text.
  const keysRef = useRef({ toggle, undoEdit, redoEdit });
  useEffect(() => {
    keysRef.current = { toggle, undoEdit, redoEdit };
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
        capture: video && videoSize ? { image: video, area: { x: 0, y: 0, width: videoSize.width, height: videoSize.height } } : null,
        image: backdropImageEl,
      };
    },
    [videoSize, backdropImageEl],
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
    if (!videoSize || !layout || exporting) return;
    pause();
    setMessage(null);
    setProgress({ done: 0, total: 0 });
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onExportProgress(setProgress).catch(() => null);
      const shape = recordingLayout(videoSize, edits.backdrop);
      const layers = edits.backdrop ? await exportLayers(shape, edits.backdrop, sources()) : null;
      const saved = await exportRecording(
        {
          startMs: savedTrim.startMs,
          endMs: savedTrim.endMs,
          width: shape.width,
          height: shape.height,
          x: shape.x,
          y: shape.y,
          videoWidth: shape.videoWidth,
          videoHeight: shape.videoHeight,
          backdropBytes: 0,
          zooms: edits.zooms ?? [],
          sourceWidth: videoSize.width,
          sourceHeight: videoSize.height,
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

  const clipMs = trim.endMs - trim.startMs;
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const status = exporting ? `Exporting… ${percent}%` : (message ?? saveText(saveStatus));
  // The video's place on the preview, as shares of the output.
  const share = (part: number, whole: number) => `${(part / whole) * 100}%`;
  // While an area zoom is chosen, the whole frame shows with the area on it.
  const picking = selectedZoom?.focus.kind === "area" && !playing && !exporting;
  const view = picking ? FULL_VIEW : viewAt(zooms, currentMs, cursor);
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
          <button type="button" className="primary" onClick={() => void exportNow()} disabled={!videoSize || exporting} title="Save the edited recording beside the original">
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
          <div className="recording-frame" style={frameStyle}>
            {src && (
              <video
                ref={videoRef}
                className="recording-video"
                src={src}
                crossOrigin="anonymous"
                preload="auto"
                playsInline
                style={{ transform: viewTransform(view) }}
                onLoadedMetadata={onMetadata}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onSeeked={() => setFrameTick((tick) => tick + 1)}
                onTimeUpdate={() => !playing && setCurrentMs((videoRef.current?.currentTime ?? 0) * 1000)}
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
      <div className="recording-controls">
        <button type="button" className="icon-button" onClick={toggle} disabled={!videoSize} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="recording-time" aria-label="Time">
          {formatTime(currentMs)} / {formatTime(durationMs)}
        </span>
        <Timeline
          durationMs={durationMs}
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
          <ZoomTrack
            durationMs={durationMs}
            zooms={zooms}
            selectedId={selectedZoom?.id ?? null}
            onSelect={setSelectedZoomId}
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
        {durationMs > 0 && <span>Clip {formatTime(clipMs)}</span>}
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
