import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "../editor/editor.css";
import "./recording.css";
import { MAX_BACKDROP_PRESETS } from "../settings/api";
import { chooseBackdropImage, saveBackdropPresetImage } from "../editor/api";
import BackdropPanel from "../editor/BackdropPanel";
import { BackdropIcon, ExportIcon } from "../editor/icons";
import { BACKDROP_FILLS, type Backdrop } from "../editor/model";
import { presetName } from "../editor/preferences";
import { newId } from "../editor/tools";
import { useBackdropImage } from "../editor/useBackdropImage";
import type { BackdropSources } from "../editor/flatten";
import { exportRecording, onExportProgress, recordingInfo, saveEdits, videoSrc, type ExportProgress, type RecordingInfo } from "./api";
import { clampTrim, emptyEdits, formatTime, isWhole, parseEdits, serializeEdits, trimOf, type RecordingEdits, type Trim } from "./edits";
import { exportLayers, paintUnderlay, recordingLayout } from "./layout";
import { useBackdropPresets } from "./useBackdropPresets";
import Timeline from "./Timeline";

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
 * timeline to trim its start and end, and exports the result as a new MP4
 * beside it. Edits are kept in `<recording>.edits.json` as they are made;
 * the recording itself is never changed.
 */
export default function RecordingEditor() {
  const [info, setInfo] = useState<RecordingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<RecordingEdits>(emptyEdits);
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
          setEdits(parseEdits(loaded.edits));
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
  const trim = trimDraft ?? savedTrim;
  const layout = useMemo(() => (videoSize ? recordingLayout(videoSize, backdrop) : null), [videoSize, backdrop]);
  const backdropImageEl = useBackdropImage(backdrop?.fill === BACKDROP_FILLS.image ? (backdrop.image ?? null) : null);

  const commitEdits = useCallback(
    (next: RecordingEdits) => {
      setEdits(next);
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

  const commitBackdrop = (next: Backdrop | null) => {
    setBackdropDraft(undefined);
    commitEdits({ ...edits, backdrop: next });
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

  // Space plays and pauses, unless a control has the keyboard.
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " || isTyping(event.target)) return;
      event.preventDefault();
      toggleRef.current();
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
  const videoStyle = layout
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
          {info && (
            <video
              ref={videoRef}
              className="recording-video"
              src={videoSrc(info.path)}
              crossOrigin="anonymous"
              preload="auto"
              playsInline
              style={videoStyle}
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
        />
      </div>
      {exporting && (
        <div className="recording-progress" role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div style={{ width: `${percent}%` }} />
        </div>
      )}
      <footer className="editor-status">
        <span>{info?.fileName ?? "Loading…"}</span>
        {durationMs > 0 && <span>Clip {formatTime(clipMs)}</span>}
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
