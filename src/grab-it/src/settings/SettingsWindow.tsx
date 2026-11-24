import { useEffect, useRef, useState } from "react";
import AgentsSection from "./AgentsSection";
import AiSection from "./AiSection";
import HotkeysSection from "./HotkeysSection";
import StorageSection from "./StorageSection";
import { isMacPlatform } from "./accelerator";
import { FolderIcon, PlayIcon } from "../app/icons";
import { hubActivity, onHubActivity } from "../hub/api";
import {
  AFTER_CAPTURE_CHOICES,
  DEFAULT_AI_PREFERENCES,
  DEFAULT_APPEARANCE,
  DEFAULT_RECORDING,
  DEFAULT_RETENTION,
  POPUP_CORNERS,
  RECORDING_AUDIO,
  RECORDING_COUNTDOWNS,
  RECORDING_FORMATS,
  RECORDING_FPS,
  RECORDING_QUALITIES,
  ffmpegStatus,
  WEBCAM_SHAPES,
  keystrokesHint as keystrokesHintFor,
  listCameras,
  rememberListing,
  listMicrophones,
  onFfmpegStatus,
  recordsMicrophone,
  recordsSystemSound,
  systemSoundAvailable,
  retryFfmpeg,
  setRecording,
  setRetention,
  type FfmpegStatus,
  type Camera,
  type Microphone,
  type RecordingAudio,
  type RecordingSettings,
  type Retention,
  type WebcamShape,
  POPUP_SECONDS,
  TEXT_SCALE,
  setAppearance,
  type Appearance,
  chooseFolder,
  getAutostart,
  getSettings,
  onAppearanceChanged,
  hasDock,
  SETTINGS_SECTIONS,
  setAgentAccess,
  previewCopySound,
  setCopySound,
  setCopySoundVolume,
  setAutoBackdrop,
  setShowPointer,
  setAutostart,
  setHotkeys,
  setPreferences,
  setSaveFolder,
  setSaveLayout,
  setShowInDock,
  setUpdateChannel,
  UPDATE_CHANNELS,
  type AiPreferences,
  type Hotkeys,
  type HotkeysUpdate,
  type Preferences,
  type SaveLayout,
  type Settings,
  type SettingsSection,
  type UpdateChannel,
} from "./api";

interface ScaleSliderProps {
  id: string;
  label: string;
  hint: string;
  value: number;
  disabled: boolean;
  /** Saves the value; a promise of false means it was not saved, and the slider returns to `value`. */
  onCommit: (percent: number) => void | Promise<boolean>;
  /** The percent range; text size's by default. */
  range?: { min: number; max: number; step: number };
  /** Shows a small and a large A at the ends, for text size. */
  letters?: boolean;
}

const SAVE_LAYOUT_OPTIONS = [
  {
    key: "byMonth",
    label: "Organise by month",
    hint: "Save new files in folders such as originals/2026-11 and recordings/2026-11.",
  },
  {
    key: "includeAppName",
    label: "Include app names in filenames",
    hint: "When Grab-it can identify the app, a name looks like 2026-11-24 14-32-08 – Firefox.png.",
  },
] as const;

/** The copy sound's volume slider: every whole percent from 0 to 100. */
const VOLUME_RANGE = { min: 0, max: 100, step: 1 };

/**
 * A percent slider, such as text size. It shows the value while dragging but
 * saves only on release, so the window does not rescale under the pointer
 * mid-drag and a volume change is saved once.
 */
function ScaleSlider({
  id,
  label,
  hint,
  value,
  disabled,
  onCommit,
  range = TEXT_SCALE,
  letters = true,
}: ScaleSliderProps) {
  // What is being dragged, tied to the saved value it started from: once a
  // new value is saved (or comes from elsewhere) the slider shows that.
  const [dragging, setDragging] = useState<{ from: number; to: number } | null>(null);
  const draft = dragging && dragging.from === value ? dragging.to : value;
  const setDraft = (to: number) => setDragging({ from: value, to });
  const commit = () => {
    if (draft === value) return;
    const attempt = { from: value, to: draft };
    void onCommit(draft)?.then((saved) => {
      // Shows the saved value again, unless another drag has started since.
      if (saved) return;
      setDragging((current) => (current?.from === attempt.from && current.to === attempt.to ? null : current));
    });
  };
  const fill = ((draft - range.min) * 100) / (range.max - range.min);
  return (
    <div className="row is-stacked">
      <span className="row-text">
        <label className="row-title" htmlFor={id}>
          {label}
        </label>
        <span className="row-hint">{hint}</span>
      </span>
      <span className="scale-slider">
        {letters && (
          <span className="scale-a scale-a-small" aria-hidden="true">
            A
          </span>
        )}
        <input
          id={id}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={draft}
          disabled={disabled}
          aria-valuetext={`${draft}%`}
          style={{ "--fill": `${fill}%` } as React.CSSProperties}
          onChange={(event) => setDraft(Number(event.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        {letters && (
          <span className="scale-a scale-a-large" aria-hidden="true">
            A
          </span>
        )}
        <span className="scale-value" data-for={id} aria-hidden="true">
          {draft}%
        </span>
      </span>
    </div>
  );
}

/** Whether MP4 can be recorded yet, with Retry when ffmpeg is not installed or getting it failed. */
function FfmpegRow({ status, onRetry }: { status: FfmpegStatus | null; onRetry: () => void }) {
  let detail: React.ReactNode;
  let failed = false;
  let progress: { value: number; max: number } | null = null;
  switch (status?.state) {
    case undefined:
      detail = "Checking…";
      break;
    case "missing":
      detail = "ffmpeg is set up the first time you record an MP4.";
      break;
    case "downloading": {
      const megabytes = (bytes: number) => (bytes / 1_048_576).toFixed(1);
      detail =
        status.total > 0
          ? `Downloading ffmpeg… ${Math.floor((status.downloaded * 100) / status.total)}%`
          : `Downloading ffmpeg… ${megabytes(status.downloaded)} MB`;
      if (status.total > 0) progress = { value: status.downloaded, max: status.total };
      break;
    }
    case "checking":
      detail = "Finding the best video encoder…";
      break;
    case "ready":
      detail = `Ready. Videos are encoded with ${status.encoder} by ${status.path}.`;
      break;
    case "notInstalled":
      detail = status.install ? (
        <>
          MP4 needs ffmpeg. Install it with <code className="ffmpeg-install">{status.install}</code>, then press
          Retry. Until then, recordings are saved as GIFs.
        </>
      ) : (
        "MP4 needs ffmpeg. Install it, then press Retry. Until then, recordings are saved as GIFs."
      );
      failed = true;
      break;
    case "failed":
      detail = `Could not set up ffmpeg: ${status.message}. Until it works, recordings are saved as GIFs.`;
      failed = true;
      break;
  }
  return (
    <div className="row" data-testid="ffmpeg-status">
      <span className="row-text">
        <span className="row-title">Video encoder</span>
        <span className={failed ? "row-hint ffmpeg-failed" : "row-hint"} aria-live="polite">
          {detail}
        </span>
        {progress && <progress aria-label="ffmpeg download" max={progress.max} value={progress.value} />}
      </span>
      {failed && (
        <button type="button" className="pill" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

type Status =
  | { kind: "idle" }
  | { kind: "saved" }
  | { kind: "preferences-saved" }
  | { kind: "hotkeys-saved"; warnings: string[] }
  | { kind: "error"; message: string };

interface SettingsWindowProps {
  /** One page of Settings, as the Grab-it window shows it; all of them without. */
  section?: SettingsSection;
}

function SettingsWindow({ section }: SettingsWindowProps = {}) {
  const shows = (page: SettingsSection) => section === undefined || section === page;
  const title = section === undefined ? "Settings" : SETTINGS_SECTIONS.find((page) => page.id === (section === "agents" ? "ai" : section))?.title;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [recordingActive, setRecordingActive] = useState<boolean | null>(null);
  const showsCapture = shows("capture");
  const [switchedToStable, setSwitchedToStable] = useState(false);
  /** Null until the backend has said; only the Recording page asks. */
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const showsRecording = shows("recording");
  /** The microphones to pick from; on Linux ffmpeg lists them, so they come once it is ready. */
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  /** Whether system sound can be recorded here; null until the backend has said, which hides it. */
  const [systemSound, setSystemSound] = useState<boolean | null>(null);
  const ffmpegReady = ffmpeg?.state === "ready";
  /** The cameras to pick from, listed by the webview once Show webcam is on. */
  const [cameras, setCameras] = useState<Camera[]>([]);
  const showsWebcam = showsRecording && settings?.recording?.showWebcam === true;
  /** Set as Show webcam is turned on: the next listing asks for the camera. */
  const askForCameras = useRef(false);
  // Null until the system has answered, or when it cannot say: the toggle
  // is then left out rather than shown in a state that may be wrong.
  const [autostart, setAutostartState] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAutostart()
      .then((enabled) => {
        if (!cancelled && typeof enabled === "boolean") setAutostartState(enabled);
      })
      .catch(() => {
        // No start-up support here; Settings works without the toggle.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ⌘+, ⌘− and ⌘0 change the text size while Settings is open.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onAppearanceChanged((appearance) => {
      if (!cancelled) setSettings((was) => (was ? { ...was, appearance } : was));
    })
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => {
        // Without events the slider shows the size it read.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatus({ kind: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!showsCapture) return;
    let cancelled = false;
    let receivedActivity = false;
    let unlisten: (() => void) | undefined;
    onHubActivity(({ recording }) => {
      receivedActivity = true;
      if (!cancelled) setRecordingActive(recording);
    })
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => undefined)
      .then(hubActivity)
      .then((activity) => {
        if (!cancelled && !receivedActivity) setRecordingActive(activity?.recording === true);
      })
      .catch(() => {
        // The preview command checks again before playing.
        if (!cancelled && !receivedActivity) setRecordingActive(false);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showsCapture]);

  useEffect(() => {
    if (!showsRecording) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onFfmpegStatus((status) => {
      if (!cancelled) setFfmpeg(status);
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Without events the page still shows the status it read.
      });
    ffmpegStatus()
      .then((status) => {
        if (!cancelled) setFfmpeg(status);
      })
      .catch(() => {
        // Settings works without the status line.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [showsRecording]);

  useEffect(() => {
    if (!showsRecording) return;
    let cancelled = false;
    listMicrophones()
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setMicrophones(list);
      })
      .catch(() => {
        // System default still works without the list.
      });
    return () => {
      cancelled = true;
    };
  }, [showsRecording, ffmpegReady]);

  useEffect(() => {
    if (!showsRecording) return;
    let cancelled = false;
    systemSoundAvailable()
      .then((available) => {
        if (!cancelled && typeof available === "boolean") setSystemSound(available);
      })
      .catch(() => {
        // Without an answer System and Both stay hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [showsRecording]);

  useEffect(() => {
    if (!showsWebcam) return;
    let cancelled = false;
    const ask = askForCameras.current;
    askForCameras.current = false;
    listCameras(ask)
      .then((listing) => {
        if (!cancelled) setCameras(listing.cameras);
        // Named, they are remembered for the setup toolbar's Camera chip.
        rememberListing(listing).catch(() => undefined);
      })
      .catch(() => {
        // The default camera still works without the list.
      });
    return () => {
      cancelled = true;
    };
  }, [showsWebcam]);

  function changeShowWebcam(enabled: boolean) {
    // Turning it on is when to ask for the camera, so its names show and
    // the first recording does not wait on the system's prompt.
    askForCameras.current = enabled;
    return changeRecording({ showWebcam: enabled });
  }

  async function changeRecording(change: Partial<RecordingSettings>) {
    setBusy(true);
    try {
      const saved = await setRecording({ ...DEFAULT_RECORDING, ...settings?.recording, ...change });
      setSettings(saved);
      setStatus({ kind: "preferences-saved" });
      // Choosing MP4 starts getting ffmpeg ready.
      if (saved.recording?.format === "mp4") setFfmpeg(await ffmpegStatus());
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function saveRetention(retention: Retention): Promise<boolean> {
    setBusy(true);
    try {
      setSettings(await setRetention(retention));
      setStatus({ kind: "preferences-saved" });
      return true;
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function retry() {
    retryFfmpeg()
      .then(setFfmpeg)
      .catch((err: unknown) => setStatus({ kind: "error", message: errorMessage(err) }));
  }

  async function changeFolder() {
    setBusy(true);
    try {
      const picked = await chooseFolder(settings?.saveFolder);
      if (picked === null) return;
      setSettings(await setSaveFolder(picked));
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeSaveLayout(key: keyof SaveLayout, enabled: boolean) {
    if (!settings) return;
    setBusy(true);
    try {
      setSettings(await setSaveLayout({ ...settings.saveLayout, [key]: enabled }));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  /** Saves one changed preference at once; there is no Save button for these. */
  async function changePreferences(change: Partial<Preferences>): Promise<boolean> {
    if (!settings) return false;
    const next: Preferences = {
      afterCapture: settings.afterCapture,
      copyToClipboard: settings.copyToClipboard,
      ai: settings.ai ?? DEFAULT_AI_PREFERENCES,
      ...change,
    };
    setBusy(true);
    try {
      setSettings(await setPreferences(next));
      setStatus({ kind: "preferences-saved" });
      return true;
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function changeCopySound(enabled: boolean) {
    setBusy(true);
    try {
      setSettings(await setCopySound(enabled));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeCopySoundVolume(volume: number): Promise<boolean> {
    try {
      setSettings(await setCopySoundVolume(volume));
      setStatus({ kind: "preferences-saved" });
      return true;
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
      return false;
    }
  }

  async function playCopySoundPreview() {
    setPreviewing(true);
    setStatus({ kind: "idle" });
    try {
      await previewCopySound();
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setPreviewing(false);
    }
  }

  const saveAi = (ai: AiPreferences) => changePreferences({ ai });

  async function changeAutoBackdrop(enabled: boolean) {
    setBusy(true);
    try {
      setSettings(await setAutoBackdrop(enabled));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeShowPointer(enabled: boolean) {
    setBusy(true);
    try {
      setSettings(await setShowPointer(enabled));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeAutostart(enabled: boolean) {
    setBusy(true);
    try {
      setAutostartState(await setAutostart(enabled));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeShowInDock(enabled: boolean) {
    setBusy(true);
    try {
      setSettings(await setShowInDock(enabled));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeAgentAccess(enabled: boolean) {
    setBusy(true);
    try {
      setSettings(await setAgentAccess(enabled));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeUpdateChannel(channel: UpdateChannel) {
    setBusy(true);
    try {
      setSettings(await setUpdateChannel(channel));
      setSwitchedToStable(channel === "stable");
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeAppearance(change: Partial<Appearance>) {
    setBusy(true);
    try {
      setSettings(await setAppearance({ ...(settings?.appearance ?? DEFAULT_APPEARANCE), ...change }));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function saveHotkeys(hotkeys: Hotkeys): Promise<HotkeysUpdate | null> {
    try {
      const update = await setHotkeys(hotkeys);
      setSettings(update.settings);
      setStatus({ kind: "hotkeys-saved", warnings: update.warnings });
      return update;
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
      return null;
    }
  }

  const afterCapture = AFTER_CAPTURE_CHOICES.find((choice) => choice.value === settings?.afterCapture);
  const savesAtOnce =
    section === undefined ||
    section === "general" ||
    section === "appearance" ||
    section === "capture" ||
    section === "editor" ||
    section === "recording" ||
    section === "storage" ||
    section === "agents";
  const recording: RecordingSettings = { ...DEFAULT_RECORDING, ...settings?.recording };
  const recordingOff = busy || settings === null;
  const silent = recording.format === "gif";
  const keystrokesHint = keystrokesHintFor(isMacPlatform());
  const textSizeKeys = isMacPlatform() ? "⌘+, ⌘− and ⌘0" : "Ctrl++, Ctrl+− and Ctrl+0";
  // System and Both are offered only where system sound can be recorded,
  // but a saved choice is still shown as it is.
  const audioChoices = RECORDING_AUDIO.filter(
    (choice) => systemSound === true || !recordsSystemSound(choice.value) || choice.value === recording.audio,
  );
  const defaultMicrophone = microphones.find((microphone) => microphone.isDefault);
  const savedMicrophoneMissing =
    recording.microphone !== null && !microphones.some((microphone) => microphone.id === recording.microphone);
  const savedCameraMissing = recording.camera !== null && !cameras.some((camera) => camera.id === recording.camera);
  const recordingFormat = RECORDING_FORMATS.find((choice) => choice.value === recording.format);
  const appearance = settings?.appearance ?? DEFAULT_APPEARANCE;
  const appearanceOff = busy || settings === null;
  const showsMac = shows("general") && (hasDock() || autostart !== null);
  const updateChannel = settings?.updateChannel ?? "stable";
  const updateChannelChoice = UPDATE_CHANNELS.find((choice) => choice.value === updateChannel);

  return (
    <main className={section === undefined ? "window settings" : "window settings settings-page"}>
      <h1 className="settings-title">{title}</h1>
      {/* Scrolls on its own, so the heading and the scrollbar never overlap. */}
      <div className="settings-content">
      <p className="settings-lead">
        {savesAtOnce ? "Changes save as you make them." : section === "hotkeys" ? "Press Save to use new hotkeys." : "AI settings save with Save; agent access saves at once."}
      </p>
      {showsMac && (
        <section aria-labelledby="mac-heading">
          <h2 className="group-heading" id="mac-heading">
            Grab-it on your Mac
          </h2>
          <div className="group">
            {hasDock() && (
              <label className="row">
                <span className="row-text">
                  <span className="row-title">Show Grab-it in the Dock</span>
                  <span className="row-hint">Click the Dock icon to open this window. Off, Grab-it lives in the menu bar only.</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={settings?.showInDock ?? true}
                  disabled={busy || settings === null}
                  onChange={(event) => void changeShowInDock(event.target.checked)}
                />
              </label>
            )}
            {autostart !== null && (
              <label className="row">
                <span className="row-text">
                  <span className="row-title">Start Grab-it when you sign in</span>
                  <span className="row-hint">It waits in the menu bar or tray, ready for your hotkeys.</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={autostart}
                  disabled={busy}
                  onChange={(event) => void changeAutostart(event.target.checked)}
                />
              </label>
            )}
          </div>
        </section>
      )}
      {showsCapture && (
        <section aria-labelledby="after-capture-heading">
          <h2 className="group-heading" id="after-capture-heading">
            When a capture is done
          </h2>
          <div className="group">
            <div className="row is-stacked">
              <fieldset className="segmented" aria-labelledby="after-capture-heading" disabled={busy || settings === null}>
                {AFTER_CAPTURE_CHOICES.map((choice) => (
                  <label key={choice.value}>
                    <input
                      type="radio"
                      name="after-capture"
                      value={choice.value}
                      checked={settings?.afterCapture === choice.value}
                      onChange={() => void changePreferences({ afterCapture: choice.value })}
                    />
                    {choice.title}
                  </label>
                ))}
              </fieldset>
              {afterCapture && <span className="row-hint">{afterCapture.hint}</span>}
            </div>
            <label className="row">
              <span className="row-text">
                <span className="row-title">Copy every capture to the clipboard</span>
                <span className="row-hint">Paste it straight into a chat, a document or an issue.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={settings?.copyToClipboard ?? true}
                disabled={busy || settings === null}
                onChange={(event) => void changePreferences({ copyToClipboard: event.target.checked })}
              />
            </label>
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="copy-sound">
                  Play a sound when copying
                </label>
                <span className="row-hint">Hear a shutter sound when Grab-it copies to the clipboard.</span>
                {recordingActive && (
                  <span className="row-hint" id="copy-sound-preview-hint">
                    Preview is unavailable while recording.
                  </span>
                )}
              </span>
              {/* Usable while the sound is off; it plays at the Volume below. */}
              <button
                type="button"
                className="btn btn-icon"
                aria-label="Preview sound"
                title="Preview sound"
                aria-describedby={recordingActive ? "copy-sound-preview-hint" : undefined}
                disabled={recordingActive !== false || previewing || settings === null}
                onClick={() => void playCopySoundPreview()}
              >
                <PlayIcon size={14} />
              </button>
              <input
                id="copy-sound"
                type="checkbox"
                role="switch"
                className="switch"
                checked={settings?.copySound ?? true}
                disabled={busy || settings === null}
                onChange={(event) => void changeCopySound(event.target.checked)}
              />
            </div>
            {/* Enabled while the sound is off, and never disabled by a save, so a drag is never cut short. */}
            <ScaleSlider
              id="copy-sound-volume"
              label="Volume"
              hint="How loud the copy sound plays, and its preview too."
              value={settings?.copySoundVolume ?? 50}
              disabled={settings === null}
              range={VOLUME_RANGE}
              letters={false}
              onCommit={changeCopySoundVolume}
            />
          </div>
        </section>
      )}
      {shows("editor") && (
        <section aria-labelledby="editor-heading">
          <h2 className="group-heading" id="editor-heading">
            New captures
          </h2>
          <div className="group">
            <label className="row">
              <span className="row-text">
                <span className="row-title">Frame new captures with the last backdrop</span>
                <span className="row-hint">
                  The editor adds it when it first opens a capture. The saved capture and its clipboard copy stay unframed.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={settings?.editor?.autoBackdrop ?? false}
                disabled={busy || settings === null}
                onChange={(event) => void changeAutoBackdrop(event.target.checked)}
              />
            </label>
            <label className="row">
              <span className="row-text">
                <span className="row-title">Show the pointer in new captures</span>
                <span className="row-hint">
                  The editor starts with the mouse pointer shown, and the clipboard copy has it drawn in. The saved capture never has it.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={settings?.editor?.showPointer ?? false}
                disabled={busy || settings === null}
                onChange={(event) => void changeShowPointer(event.target.checked)}
              />
            </label>
          </div>
        </section>
      )}
      {showsRecording && (
        <section aria-labelledby="recording-format-heading">
          <h2 className="group-heading" id="recording-format-heading">
            Save recordings as
          </h2>
          <div className="group">
            <div className="row is-stacked">
              <fieldset className="segmented" aria-labelledby="recording-format-heading" disabled={busy || settings === null}>
                {RECORDING_FORMATS.map((choice) => (
                  <label key={choice.value}>
                    <input
                      type="radio"
                      name="recording-format"
                      value={choice.value}
                      checked={recording.format === choice.value}
                      onChange={() => void changeRecording({ format: choice.value })}
                    />
                    {choice.title}
                  </label>
                ))}
              </fieldset>
              {recordingFormat && <span className="row-hint">{recordingFormat.hint}</span>}
            </div>
            {recording.format === "mp4" && (
              <>
                <div className="row is-stacked">
                  <span className="row-text">
                    <span className="row-title" id="recording-quality-heading">
                      Quality
                    </span>
                    <span className="row-hint">Higher quality looks sharper and makes bigger files.</span>
                  </span>
                  <fieldset className="segmented" aria-labelledby="recording-quality-heading" disabled={busy || settings === null}>
                    {RECORDING_QUALITIES.map((choice) => (
                      <label key={choice.value}>
                        <input
                          type="radio"
                          name="recording-quality"
                          value={choice.value}
                          checked={recording.quality === choice.value}
                          onChange={() => void changeRecording({ quality: choice.value })}
                        />
                        {choice.title}
                      </label>
                    ))}
                  </fieldset>
                </div>
                <div className="row is-stacked">
                  <span className="row-text">
                    <span className="row-title" id="recording-fps-heading">
                      Frame rate
                    </span>
                    <span className="row-hint">60 fps makes scrolling and pointer movement smoother, and files bigger.</span>
                  </span>
                  <fieldset className="segmented" aria-labelledby="recording-fps-heading" disabled={busy || settings === null}>
                    {RECORDING_FPS.map((choice) => (
                      <label key={choice.value}>
                        <input
                          type="radio"
                          name="recording-fps"
                          value={choice.value}
                          checked={recording.fps === choice.value}
                          onChange={() => void changeRecording({ fps: choice.value })}
                        />
                        {choice.title}
                      </label>
                    ))}
                  </fieldset>
                </div>
                <FfmpegRow status={ffmpeg} onRetry={retry} />
              </>
            )}
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="recording-audio">
                  Audio
                </label>
                <span className="row-hint">
                  {silent ? "GIFs are silent. Choose MP4 video to record sound." : "Records sound along with the video."}
                </span>
              </span>
              <select
                id="recording-audio"
                className="row-field"
                value={recording.audio}
                disabled={recordingOff || silent}
                onChange={(event) => void changeRecording({ audio: event.target.value as RecordingAudio })}
              >
                {audioChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.title}
                  </option>
                ))}
              </select>
            </div>
            {recordsMicrophone(recording.audio) && (
              <div className="row">
                <span className="row-text">
                  <label className="row-title" htmlFor="recording-microphone">
                    Microphone
                  </label>
                  <span className="row-hint">System default follows the input chosen in your sound settings.</span>
                </span>
                <select
                  id="recording-microphone"
                  className="row-field"
                  value={recording.microphone ?? ""}
                  disabled={recordingOff || silent}
                  onChange={(event) => void changeRecording({ microphone: event.target.value === "" ? null : event.target.value })}
                >
                  <option value="">{defaultMicrophone ? `System default (${defaultMicrophone.name})` : "System default"}</option>
                  {microphones.map((microphone) => (
                    <option key={microphone.id} value={microphone.id}>
                      {microphone.name}
                    </option>
                  ))}
                  {savedMicrophoneMissing && recording.microphone !== null && (
                    <option value={recording.microphone}>{`${recording.microphone} (not connected)`}</option>
                  )}
                </select>
              </div>
            )}
            <label className="row">
              <span className="row-text">
                <span className="row-title">Remove background noise</span>
                <span className="row-hint">
                  {silent
                    ? "GIFs are silent."
                    : recordsMicrophone(recording.audio)
                      ? "Cleans fan hum, keyboard clatter and room noise from your microphone. System sound is left as it is."
                      : "Choose a microphone under Audio first."}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={!silent && recordsMicrophone(recording.audio) && recording.removeNoise}
                disabled={busy || settings === null || recordingOff || silent || !recordsMicrophone(recording.audio)}
                onChange={(event) => void changeRecording({ removeNoise: event.target.checked })}
              />
            </label>
            <label className="row">
              <span className="row-text">
                <span className="row-title">Show cursor</span>
                <span className="row-hint">Draws the pointer into the recording.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={recording.showCursor}
                disabled={busy || settings === null}
                onChange={(event) => void changeRecording({ showCursor: event.target.checked })}
              />
            </label>
            <label className="row">
              <span className="row-text">
                <span className="row-title">Show clicks</span>
                <span className="row-hint">Draws a ring where you click, fading in half a second.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={recording.showClicks}
                disabled={busy || settings === null}
                onChange={(event) => void changeRecording({ showClicks: event.target.checked })}
              />
            </label>
            <label className="row">
              <span className="row-text">
                <span className="row-title">Show keystrokes</span>
                <span className="row-hint">{keystrokesHint}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={recording.showKeystrokes}
                disabled={busy || settings === null}
                onChange={(event) => void changeRecording({ showKeystrokes: event.target.checked })}
              />
            </label>
            <label className="row">
              <span className="row-text">
                <span className="row-title">Show webcam</span>
                <span className="row-hint">Shows your camera in a bubble over the recorded area, recorded with it. Drag it anywhere while recording.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={recording.showWebcam}
                disabled={busy || settings === null}
                onChange={(event) => void changeShowWebcam(event.target.checked)}
              />
            </label>
            {recording.showWebcam && (
              <>
                <div className="row">
                  <span className="row-text">
                    <label className="row-title" htmlFor="recording-camera">
                      Camera
                    </label>
                    <span className="row-hint">System default is the camera your system picks first.</span>
                  </span>
                  <select
                    id="recording-camera"
                    className="row-field"
                    value={recording.camera ?? ""}
                    disabled={recordingOff}
                    onChange={(event) => void changeRecording({ camera: event.target.value === "" ? null : event.target.value })}
                  >
                    <option value="">System default</option>
                    {cameras.map((camera) => (
                      <option key={camera.id} value={camera.id}>
                        {camera.name}
                      </option>
                    ))}
                    {savedCameraMissing && recording.camera !== null && (
                      <option value={recording.camera}>Saved camera (not connected)</option>
                    )}
                  </select>
                </div>
                <div className="row">
                  <span className="row-text">
                    <label className="row-title" htmlFor="recording-webcam-shape">
                      Webcam shape
                    </label>
                  </span>
                  <select
                    id="recording-webcam-shape"
                    className="row-field"
                    value={recording.webcamShape}
                    disabled={recordingOff}
                    onChange={(event) => void changeRecording({ webcamShape: event.target.value as WebcamShape })}
                  >
                    {WEBCAM_SHAPES.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.title}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="row">
                  <span className="row-text">
                    <span className="row-title">Mirror webcam</span>
                    <span className="row-hint">Shows you as a mirror would, so pointing at the screen points the right way. Turn it off when there is writing behind you.</span>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="switch"
                    checked={recording.mirrorWebcam}
                    disabled={recordingOff}
                    onChange={(event) => void changeRecording({ mirrorWebcam: event.target.checked })}
                  />
                </label>
              </>
            )}
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="recording-countdown">
                  Countdown
                </label>
                <span className="row-hint">Counts down on the recording toolbar before the first frame.</span>
              </span>
              <select
                id="recording-countdown"
                className="row-field"
                value={recording.countdown}
                disabled={recordingOff}
                onChange={(event) => void changeRecording({ countdown: Number(event.target.value) })}
              >
                {RECORDING_COUNTDOWNS.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds === 0 ? "Off" : `${seconds} seconds`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      )}
      {shows("appearance") && (
        <section aria-labelledby="text-size-heading">
          <h2 className="group-heading" id="text-size-heading">
            Text size
          </h2>
          <div className="group">
            <ScaleSlider
              id="text-scale"
              label="Grab-it window"
              hint={`Scales the library, Settings and every dialog: text, buttons and thumbnails. ${textSizeKeys} change it too.`}
              value={appearance.textScale}
              disabled={appearanceOff}
              onCommit={(textScale) => void changeAppearance({ textScale })}
            />
            <ScaleSlider
              id="hub-scale"
              label="Menu bar hub"
              hint="The menu under the Grab-it icon grows with it."
              value={appearance.hubScale}
              disabled={appearanceOff}
              onCommit={(hubScale) => void changeAppearance({ hubScale })}
            />
          </div>

          <h2 className="group-heading" id="popup-heading">
            Popup after a capture
          </h2>
          <div className="group">
            <div className="row is-stacked">
              <span className="row-text">
                <span className="row-title" id="popup-corner-heading">
                  Position
                </span>
                <span className="row-hint">Which corner of the screen the popup appears in.</span>
              </span>
              <fieldset className="corner-picker" aria-labelledby="popup-corner-heading" disabled={appearanceOff}>
                {POPUP_CORNERS.map((choice) => (
                  <label key={choice.value} className={`corner-${choice.value}`}>
                    <input
                      type="radio"
                      name="popup-corner"
                      value={choice.value}
                      checked={appearance.popupCorner === choice.value}
                      onChange={() => void changeAppearance({ popupCorner: choice.value })}
                    />
                    <span className="corner-card" aria-hidden="true" />
                    {choice.title}
                  </label>
                ))}
              </fieldset>
            </div>
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="popup-seconds">
                  Show it for
                </label>
                <span className="row-hint">Resting the pointer on it keeps it open. Errors stay at least 10 seconds.</span>
              </span>
              <select
                id="popup-seconds"
                className="row-field"
                value={appearance.popupSeconds}
                disabled={appearanceOff}
                onChange={(event) => void changeAppearance({ popupSeconds: Number(event.target.value) })}
              >
                {POPUP_SECONDS.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds === 0 ? "Until I close it" : `${seconds} seconds`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      )}
      {shows("general") && (
        <section>
          <h2 className="group-heading">
            <label htmlFor="save-folder">Save folder</label>
          </h2>
          <div className="group">
            <div className="row">
              <span className="icon-chip tint-blue" aria-hidden="true">
                <FolderIcon size={14} />
              </span>
              <span className="row-text">
                <input
                  id="save-folder"
                  className="mono-value"
                  type="text"
                  readOnly
                  value={settings?.saveFolder ?? ""}
                  placeholder={settings ? "" : "Loading…"}
                  aria-describedby="save-folder-hint"
                />
                <span className="row-hint" id="save-folder-hint">
                  New captures are saved here. Earlier captures stay where they are and stay in your library.
                </span>
              </span>
              <button type="button" className="pill" onClick={changeFolder} disabled={busy || settings === null}>
                Change…
              </button>
            </div>
            {SAVE_LAYOUT_OPTIONS.map(({ key, label, hint }) => (
              <label className="row" key={key}>
                <span className="row-text">
                  <span className="row-title" id={`save-layout-${key}-label`}>{label}</span>
                  <span className="row-hint" id={`save-layout-${key}-hint`}>{hint}</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  aria-labelledby={`save-layout-${key}-label`}
                  aria-describedby={`save-layout-${key}-hint`}
                  checked={settings?.saveLayout[key] ?? false}
                  disabled={busy || settings === null}
                  onChange={(event) => void changeSaveLayout(key, event.target.checked)}
                />
              </label>
            ))}
          </div>
        </section>
      )}
      {shows("general") && (
        <section aria-labelledby="updates-heading">
          <h2 className="group-heading" id="updates-heading">
            Updates
          </h2>
          <div className="group">
            <div className="row">
              <div className="row-text">
                <label className="row-title" htmlFor="update-channel">
                  Update channel
                </label>
                <div className="row-text" id="update-channel-info">
                  {updateChannelChoice && <span className="row-hint">{updateChannelChoice.hint}</span>}
                  <span aria-live="polite" className={switchedToStable ? "row-hint" : undefined}>
                    {switchedToStable && "If you’re ahead of Stable, you’ll keep your current version until a newer Stable release is available."}
                  </span>
                </div>
              </div>
              <select
                id="update-channel"
                className="row-field"
                aria-describedby="update-channel-info"
                value={updateChannel}
                disabled={busy || settings === null}
                onChange={(event) => void changeUpdateChannel(event.target.value as UpdateChannel)}
              >
                {UPDATE_CHANNELS.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      )}
      {shows("storage") && settings && (
        <StorageSection saved={{ ...DEFAULT_RETENTION, ...settings.retention }} disabled={busy} onSave={saveRetention} />
      )}
      {shows("ai") && settings && (
        <AiSection saved={settings.ai ?? DEFAULT_AI_PREFERENCES} disabled={busy} onSave={saveAi} />
      )}
      {(shows("agents") || shows("ai")) && settings && (
        <AgentsSection
          access={settings.agentAccess ?? false}
          disabled={busy}
          onAccess={(enabled) => void changeAgentAccess(enabled)}
        />
      )}
      {shows("hotkeys") && settings && (
        <HotkeysSection saved={settings.hotkeys} disabled={busy} onSave={saveHotkeys} />
      )}
      <p className={`status status-${status.kind === "preferences-saved" ? "saved" : status.kind}`} role="status">
        {status.kind === "saved" && "Save folder updated."}
        {status.kind === "preferences-saved" && "Saved."}
        {status.kind === "hotkeys-saved" &&
          (status.warnings.length > 0 ? status.warnings.join(" ") : "Hotkeys updated.")}
        {status.kind === "error" && status.message}
      </p>
      </div>
    </main>
  );
}

export default SettingsWindow;
