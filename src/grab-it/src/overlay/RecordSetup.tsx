import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  CameraIcon,
  CameraOffIcon,
  CheckIcon,
  ChevronDownIcon,
  ClickIcon,
  CloseIcon,
  GripIcon,
  KeyboardIcon,
  MicIcon,
  MicOffIcon,
  RestartIcon,
  SpeakerIcon,
  TimerIcon,
} from "../app/icons";
import {
  recordsMicrophone,
  recordsSystemSound,
  type RecordingSettings,
  type RecordingSource,
} from "../settings/api";
import {
  cameraLabel,
  microphoneLabel,
  nextCountdown,
  withCamera,
  withMicrophone,
  withSystemSound,
} from "./recordOptions";
import { SOURCES, type RecordingOptions } from "./recordSources";

type FormatChoice = "mp4-30" | "mp4-60" | "gif";

const FORMAT_CHOICES: { value: FormatChoice; title: string }[] = [
  { value: "mp4-30", title: "MP4 · 30 fps" },
  { value: "mp4-60", title: "MP4 · 60 fps" },
  { value: "gif", title: "GIF · silent, 1 min" },
];

function formatChoice(recording: RecordingSettings): FormatChoice {
  if (recording.format === "gif") return "gif";
  return recording.fps === 60 ? "mp4-60" : "mp4-30";
}

function withFormat(recording: RecordingSettings, choice: FormatChoice): RecordingSettings {
  if (choice === "gif") return { ...recording, format: "gif" };
  return { ...recording, format: "mp4", fps: choice === "mp4-60" ? 60 : 30 };
}

/** A row of a chip's list: an option to pick, or a separator, heading or action between them. */
type ChipRow =
  | { kind?: "option"; key: string; title: string; selected: boolean; onPick: () => void }
  | { kind: "separator"; key: string }
  | { kind: "heading"; key: string; title: string }
  /** Does something rather than pick; the list stays open, as it may change the list. */
  | { kind: "action"; key: string; title: string; icon?: ReactNode; busy?: boolean; onPick: () => void };

interface ChipMenuProps {
  label: ReactNode;
  icon?: ReactNode;
  title: string;
  disabled?: boolean;
  /** Opens above the chip, for a panel near the bottom of the screen. */
  up: boolean;
  /** Marks the option picked with a check, and lines the others up with it. */
  checks?: boolean;
  options: ChipRow[];
}

/** A chip that opens a short list to pick from. */
function ChipMenu({ label, icon, title, disabled, up, checks = false, options }: ChipMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="overlay-chip-menu" ref={root}>
      <button
        type="button"
        className="overlay-tool overlay-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        {icon}
        <span>{label}</span>
        <ChevronDownIcon size={12} />
      </button>
      {open && (
        <div
          className="overlay-chip-list"
          role="menu"
          aria-label={title}
          data-up={up ? "true" : "false"}
          data-checks={checks ? "true" : undefined}
        >
          {options.map((row) => {
            switch (row.kind) {
              case "separator":
                return <div key={row.key} role="separator" className="overlay-chip-separator" />;
              case "heading":
                return (
                  <div key={row.key} role="presentation" className="overlay-chip-heading">
                    {row.title}
                  </div>
                );
              case "action":
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="menuitem"
                    className="overlay-chip-option overlay-chip-action"
                    disabled={row.busy}
                    aria-busy={row.busy || undefined}
                    onClick={row.onPick}
                  >
                    <span className="overlay-chip-mark" aria-hidden="true">
                      {row.icon}
                    </span>
                    <span>{row.title}</span>
                  </button>
                );
              default:
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={row.selected}
                    className="overlay-chip-option"
                    onClick={() => {
                      setOpen(false);
                      row.onPick();
                    }}
                  >
                    {checks && (
                      <span className="overlay-chip-mark" aria-hidden="true">
                        {row.selected && <CheckIcon size={14} />}
                      </span>
                    )}
                    <span>{row.title}</span>
                  </button>
                );
            }
          })}
        </div>
      )}
    </div>
  );
}

interface IconToggleProps {
  label: string;
  icon: ReactNode;
  on: boolean;
  disabled?: boolean;
  /** The tooltip, when it says more than the label. */
  title?: string;
  onToggle: () => void;
}

/** An option as an icon, tinted when on; its tooltip names it. */
function IconToggle({ label, icon, on, disabled, title, onToggle }: IconToggleProps) {
  return (
    <button
      type="button"
      className="overlay-tool overlay-setup-icon"
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      title={title ?? `${label} · ${on ? "on" : "off"}`}
      onClick={onToggle}
    >
      {icon}
    </button>
  );
}

interface RecordSetupProps {
  options: RecordingOptions;
  /** What is being recorded; the source buttons switch it. */
  source: RecordingSource;
  /** Number keys 1 to 3 switch the source; All-in-one keeps them for its modes. */
  numbered: boolean;
  /** Something is picked, so Record can start. */
  canRecord: boolean;
  /** Lists open above their chips, for a toolbar in the lower half. */
  up: boolean;
  /** Places the toolbar; it follows the grip by this alone. */
  transform: string;
  /** Left out where the toolbar cannot be moved. */
  onGrip?: (event: MouseEvent) => void;
  onSource: (source: RecordingSource) => void;
  onRecord: () => void;
  onCancel: () => void;
}

/**
 * The Record overlay's setup toolbar, in the recording toolbar's look: a
 * grip to move it, what to record (Region, Window or Screen), the format,
 * the microphone, the camera, the system sound, clicks and keys as icons,
 * the countdown, Record and Cancel.
 */
function RecordSetup({
  options,
  source,
  numbered,
  canRecord,
  up,
  transform,
  onGrip,
  onSource,
  onRecord,
  onCancel,
}: RecordSetupProps) {
  const { recording, microphones, cameras, refreshingCameras, refreshCameras, system, error, save } = options;

  const sources = (
    <div className="overlay-setup-sources" role="group" aria-label="What to record">
      {SOURCES.map(({ source: each, label, icon }, at) => (
        <button
          key={each}
          type="button"
          className="overlay-tool"
          aria-pressed={each === source}
          title={numbered ? `${label} (${at + 1})` : label}
          onClick={() => onSource(each)}
        >
          {icon}
          <span>{label}</span>
          {numbered && <kbd aria-hidden="true">{at + 1}</kbd>}
        </button>
      ))}
    </div>
  );

  let settings: ReactNode;
  if (!recording) {
    settings = <span className="overlay-record-note">{error ?? "Loading recording options…"}</span>;
  } else {
    const gif = recording.format === "gif";
    const silent = gif ? "A GIF is silent" : undefined;
    const micOn = recordsMicrophone(recording.audio);
    const micOptions = [
      { key: "none", title: "No microphone", selected: !micOn, onPick: () => save(withMicrophone(recording, { kind: "none" })) },
      {
        key: "default",
        title: "Default microphone",
        selected: micOn && recording.microphone === null,
        onPick: () => save(withMicrophone(recording, { kind: "default" })),
      },
      ...microphones.map((mic) => ({
        key: mic.id,
        title: mic.name,
        selected: micOn && recording.microphone === mic.id,
        onPick: () => save(withMicrophone(recording, { kind: "device", id: mic.id })),
      })),
    ];
    const webcamOn = recording.showWebcam;
    const cameraSection: ChipRow[] =
      cameras.length === 0
        ? []
        : [
            { kind: "separator", key: "cameras-separator" },
            { kind: "heading", key: "cameras-heading", title: "Cameras" },
            ...cameras.map((camera) => ({
              key: `camera-${camera.id}`,
              title: camera.name,
              selected: webcamOn && recording.camera === camera.id,
              onPick: () => save(withCamera(recording, { kind: "device", id: camera.id })),
            })),
          ];
    const cameraRows: ChipRow[] = [
      { key: "none", title: "No webcam", selected: !webcamOn, onPick: () => save(withCamera(recording, { kind: "none" })) },
      {
        key: "default",
        title: "Default camera",
        selected: webcamOn && recording.camera === null,
        onPick: () => save(withCamera(recording, { kind: "default" })),
      },
      ...cameraSection,
      { kind: "separator", key: "refresh-separator" },
      {
        kind: "action",
        key: "refresh",
        title: "Refresh camera list",
        icon: <RestartIcon size={14} />,
        busy: refreshingCameras,
        onPick: refreshCameras,
      },
    ];
    settings = (
      <div className="overlay-record-setup" data-testid="overlay-record-setup" role="group" aria-label="Recording options">
        <ChipMenu
          title="Format"
          up={up}
          label={FORMAT_CHOICES.find((choice) => choice.value === formatChoice(recording))?.title}
          options={FORMAT_CHOICES.map((choice) => ({
            key: choice.value,
            title: choice.title,
            selected: choice.value === formatChoice(recording),
            onPick: () => save(withFormat(recording, choice.value)),
          }))}
        />
        <ChipMenu
          title="Microphone"
          up={up}
          disabled={gif}
          icon={micOn && !gif ? <MicIcon size={14} /> : <MicOffIcon size={14} />}
          label={gif ? "No sound" : microphoneLabel(recording, microphones)}
          options={micOptions}
        />
        <ChipMenu
          title="Camera"
          up={up}
          checks
          icon={webcamOn ? <CameraIcon size={14} /> : <CameraOffIcon size={14} />}
          label={cameraLabel(recording, cameras)}
          options={cameraRows}
        />
        <span className="overlay-toolbar-gap" aria-hidden="true" />
        {system && (
          <IconToggle
            label="System sound"
            icon={<SpeakerIcon size={16} />}
            on={!gif && recordsSystemSound(recording.audio)}
            disabled={gif}
            title={silent}
            onToggle={() => save(withSystemSound(recording, !recordsSystemSound(recording.audio)))}
          />
        )}
        <IconToggle
          label="Clicks"
          icon={<ClickIcon size={16} />}
          on={recording.showClicks}
          onToggle={() => save({ ...recording, showClicks: !recording.showClicks })}
        />
        <IconToggle
          label="Keys"
          icon={<KeyboardIcon size={16} />}
          on={recording.showKeystrokes}
          onToggle={() => save({ ...recording, showKeystrokes: !recording.showKeystrokes })}
        />
        <button
          type="button"
          className="overlay-tool overlay-setup-countdown"
          aria-pressed={recording.countdown > 0}
          aria-label={recording.countdown === 0 ? "No countdown" : `Countdown ${recording.countdown} s`}
          title="Countdown before recording: off, 3, 5 or 10 s"
          onClick={() => save({ ...recording, countdown: nextCountdown(recording.countdown) })}
        >
          <TimerIcon size={16} />
          <span>{recording.countdown === 0 ? "Off" : `${recording.countdown} s`}</span>
        </button>
        {error && (
          <span className="overlay-record-note overlay-record-error" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="overlay-setup"
      data-testid="overlay-setup"
      role="toolbar"
      aria-label="Record"
      style={{ transform }}
      // A click on a button leaves the focus where it was, so Enter never
      // presses it again.
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) event.preventDefault();
      }}
    >
      {onGrip && (
        <span
          className="overlay-setup-grip"
          data-testid="overlay-setup-grip"
          title="Drag to move"
          aria-hidden="true"
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            onGrip(event);
          }}
        >
          <GripIcon size={14} />
        </span>
      )}
      {sources}
      <span className="overlay-toolbar-gap" aria-hidden="true" />
      {settings}
      <button
        type="button"
        className="overlay-setup-record"
        data-testid="overlay-record"
        disabled={!canRecord}
        title="Record (Enter)"
        onClick={onRecord}
      >
        <span className="overlay-setup-dot" aria-hidden="true" />
        <span>Record</span>
        <kbd aria-hidden="true">↵</kbd>
      </button>
      <button
        type="button"
        className="overlay-tool overlay-setup-icon"
        aria-label="Cancel"
        title="Cancel (Esc)"
        onClick={onCancel}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );
}

export default RecordSetup;
