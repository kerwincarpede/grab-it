import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  CameraIcon,
  CameraOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  GripIcon,
  MicIcon,
  MicOffIcon,
  RestartIcon,
  SlidersIcon,
  TimerIcon,
} from "../app/icons";
import {
  RECORDING_COUNTDOWNS,
  recordsMicrophone,
  recordsSystemSound,
  type RecordingSettings,
  type RecordingSource,
} from "../settings/api";
import {
  cameraLabel,
  COUNTDOWN_USE,
  countdownText,
  microphoneLabel,
  perceivedLevel,
  nextCountdown,
  withCamera,
  withMicrophone,
  withSystemSound,
} from "./recordOptions";
import { SOURCES, type RecordingOptions } from "./recordSources";
import { Tipped, type TipText } from "./Tipped";

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

/**
 * Keeps the mouseup and click of a press that closed a list from reaching
 * the overlay, which would otherwise let go of the held selection.
 */
function swallowClick() {
  const stopClick = (event: Event) => event.stopPropagation();
  const stopUp = (event: globalThis.MouseEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    window.removeEventListener("mouseup", stopUp, true);
    // The click, if any, comes straight after its mouseup.
    window.setTimeout(() => window.removeEventListener("click", stopClick, true), 0);
  };
  window.addEventListener("mouseup", stopUp, true);
  window.addEventListener("click", stopClick, { capture: true, once: true });
}

/** A row of a chip's list: an option to pick, or a separator, heading or action between them. */
type ChipRow =
  | { kind?: "option"; key: string; title: string; selected: boolean; onPick: () => void }
  | { kind: "separator"; key: string }
  | { kind: "heading"; key: string; title: string }
  /** Does something rather than pick; the list stays open, as it may change the list. */
  | { kind: "action"; key: string; title: string; icon?: ReactNode; busy?: boolean; onPick: () => void };

interface ChipMenuProps {
  /** What the chip says; left out, it shows its icon alone. */
  label?: ReactNode;
  icon?: ReactNode;
  title: string;
  disabled?: boolean;
  /** Opens above the chip, for a panel near the bottom of the screen. */
  up: boolean;
  /** Marks the option picked with a check, and lines the others up with it. */
  checks?: boolean;
  /** Its tooltip; without one, the title is. */
  tip?: TipText;
  /** An icon button with no chevron, as the toolbar's microphone and camera. */
  bare?: boolean;
  options: ChipRow[];
}

/** A chip that opens a short list to pick from. */
export function ChipMenu({ label, icon, title, disabled, up, checks = false, tip, bare = false, options }: ChipMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // A first click outside only closes it: the overlay never sees it.
    const close = (event: globalThis.MouseEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      const inList = event.target instanceof Element && event.target.closest('[role="menu"], [role="dialog"]');
      if (event.button === 0 && !inList) {
        event.stopPropagation();
        // The focus stays where it was, as for any click on the toolbar.
        event.preventDefault();
        swallowClick();
      }
      setOpen(false);
    };
    window.addEventListener("mousedown", close, true);
    return () => window.removeEventListener("mousedown", close, true);
  }, [open]);
  const chip = (describedBy?: string) => (
    <button
      type="button"
      className="overlay-tool overlay-chip"
      data-icon-only={label === undefined ? "true" : undefined}
      data-bare={bare ? "true" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={title}
      aria-describedby={describedBy}
      title={tip ? undefined : title}
      disabled={disabled}
      onClick={() => setOpen((was) => !was)}
    >
      {icon}
      {label !== undefined && <span>{label}</span>}
      {!bare && <ChevronDownIcon size={12} />}
    </button>
  );
  return (
    <div className="overlay-chip-menu" ref={root}>
      {tip ? <Tipped tip={tip}>{chip}</Tipped> : chip()}
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

/** What Remove background noise does, on the toolbar. */
const NOISE_USE = "Cleans fan hum, keyboard clatter and room noise from your microphone.";

interface SwitchRowProps {
  label: string;
  on: boolean;
  disabled?: boolean;
  /** What its tooltip says it does. */
  use: string;
  onToggle: () => void;
}

interface RecordOptionsFieldsProps {
  options: RecordingOptions;
  /** Lists and tooltips open above, for a toolbar in the lower half. */
  up: boolean;
  /** Unused: the microphone and camera are always icons, their tooltips name the choice. */
  iconsOnly?: boolean;
  /** The chosen microphone's level, 0 to 1, while setup listens to it; null for none. */
  level?: number | null;
}

/**
 * Settings → Recording's most used options, each with a tooltip: the
 * format, the microphone, the webcam, and the system sound, noise
 * removal, clicks and keys as icons. In the Record overlay's setup
 * toolbar and in the middle of Capture & record's toolbar while Record
 * is on.
 */
export function RecordOptionsFields({ options, up, level = null }: RecordOptionsFieldsProps) {
  const { recording, microphones, cameras, refreshingCameras, refreshCameras, system, error, save } = options;
  if (!recording) {
    return <span className="overlay-record-note">{error ?? "Loading recording options…"}</span>;
  }
  const gif = recording.format === "gif";
  const silent = "A GIF is silent.";
  const micOn = recordsMicrophone(recording.audio);
  // Default, each device, then Off, as the camera's list is.
  const micOptions: ChipRow[] = [
    {
      key: "default",
      title: "Default",
      selected: micOn && recording.microphone === null,
      onPick: () => save(withMicrophone(recording, { kind: "default" })),
    },
    ...microphones.map((mic) => ({
      key: mic.id,
      title: mic.name,
      selected: micOn && recording.microphone === mic.id,
      onPick: () => save(withMicrophone(recording, { kind: "device", id: mic.id })),
    })),
    { kind: "separator", key: "off-separator" },
    { key: "none", title: "Off", selected: !micOn, onPick: () => save(withMicrophone(recording, { kind: "none" })) },
  ];
  const micLabel = gif ? "No sound" : microphoneLabel(recording, microphones);
  const micUse = gif ? silent : "Picks the microphone that records your voice.";
  const webcamOn = recording.showWebcam;
  const webcamLabel = cameraLabel(recording, cameras);
  const webcamUse = "Picks the webcam shown in a bubble over the recording.";
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
    {
      key: "default",
      title: "Default",
      selected: webcamOn && recording.camera === null,
      onPick: () => save(withCamera(recording, { kind: "default" })),
    },
    ...cameraSection,
    { kind: "separator", key: "off-separator" },
    { key: "none", title: "Off", selected: !webcamOn, onPick: () => save(withCamera(recording, { kind: "none" })) },
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
  const format = FORMAT_CHOICES.find((choice) => choice.value === formatChoice(recording))?.title;
  const micIcon = micOn && !gif ? <MicIcon size={16} /> : <MicOffIcon size={16} />;
  const countdown = countdownText(recording.countdown);
  return (
    <div className="overlay-record-setup" data-testid="overlay-record-setup" role="group" aria-label="Recording options">
      <ChipMenu
        title="Microphone"
        up={up}
        checks
        bare
        disabled={gif}
        icon={
          <>
            {micIcon}
            {level !== null && micOn && !gif && <MicLevel level={level} />}
          </>
        }
        // An icon alone: its tooltip names the choice.
        tip={{ name: "Microphone", use: `${micLabel}. ${micUse}` }}
        options={micOptions}
      />
      <ChipMenu
        title="Camera"
        up={up}
        checks
        bare
        icon={webcamOn ? <CameraIcon size={16} /> : <CameraOffIcon size={16} />}
        tip={{ name: "Camera", use: `${webcamLabel}. ${webcamUse}` }}
        options={cameraRows}
      />
      <OptionsPopover up={up} countdown={recording.countdown > 0 ? countdown.text : null}>
        <div className="overlay-options-heading">Recording options</div>
        <OptionRow label="Format">
          <ChipMenu
            title="Format"
            up={false}
            checks
            label={format}
            tip={{ name: "Format", use: "MP4 at 30 or 60 fps, or a silent GIF of up to a minute." }}
            options={FORMAT_CHOICES.map((choice) => ({
              key: choice.value,
              title: choice.title,
              selected: choice.value === formatChoice(recording),
              onPick: () => save(withFormat(recording, choice.value)),
            }))}
          />
        </OptionRow>
        <OptionRow label="Countdown">
          <ChipMenu
            title="Countdown"
            up={false}
            checks
            label={countdown.text}
            tip={{ name: "Countdown", use: COUNTDOWN_USE }}
            options={RECORDING_COUNTDOWNS.map((seconds) => ({
              key: String(seconds),
              title: countdownText(seconds).text,
              selected: seconds === recording.countdown,
              onPick: () => save({ ...recording, countdown: seconds }),
            }))}
          />
        </OptionRow>
        <div className="overlay-options-rule" role="separator" />
        <OptionRow label="Microphone">
          <ChipMenu
            title="Microphone device"
            up={false}
            checks
            disabled={gif}
            label={gif ? "No sound" : micOn ? (recording.microphone === null ? "Default" : micLabel) : "Off"}
            tip={{ name: "Microphone", use: micUse }}
            options={micOptions}
          />
        </OptionRow>
        <OptionRow label="Camera">
          <ChipMenu
            title="Camera device"
            up={false}
            checks
            label={webcamOn ? (recording.camera === null ? "Default" : webcamLabel) : "Off"}
            tip={{ name: "Camera", use: webcamUse }}
            options={cameraRows}
          />
        </OptionRow>
        <div className="overlay-options-rule" role="separator" />
        {system && (
          <SwitchRow
            label="System sound"
            on={!gif && recordsSystemSound(recording.audio)}
            disabled={gif}
            use={gif ? silent : "Records what your computer plays."}
            onToggle={() => save(withSystemSound(recording, !recordsSystemSound(recording.audio)))}
          />
        )}
        <SwitchRow
          label="Remove background noise"
          on={!gif && micOn && recording.removeNoise}
          disabled={gif || !micOn}
          use={gif ? silent : micOn ? NOISE_USE : "Turn on a microphone first."}
          onToggle={() => save({ ...recording, removeNoise: !recording.removeNoise })}
        />
        <SwitchRow
          label="Show clicks"
          on={recording.showClicks}
          use="Draws a ring where you click."
          onToggle={() => save({ ...recording, showClicks: !recording.showClicks })}
        />
        <SwitchRow
          label="Show keystrokes"
          on={recording.showKeystrokes}
          use="Shows the keys you press at the bottom of the recording."
          onToggle={() => save({ ...recording, showKeystrokes: !recording.showKeystrokes })}
        />
      </OptionsPopover>
      {error && (
        <span className="overlay-record-note overlay-record-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** A labelled row of Recording options, its control on the right. */
function OptionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overlay-options-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** An option that is on or off: its label, and a switch on the right. */
function SwitchRow({ label, on, disabled, use, onToggle }: SwitchRowProps) {
  return (
    <Tipped tip={{ name: `${label} · ${on ? "on" : "off"}`, use }}>
      {(describedBy) => (
        <button
          type="button"
          className="overlay-options-row overlay-options-switch"
          aria-pressed={on}
          aria-label={label}
          aria-describedby={describedBy}
          disabled={disabled}
          onClick={onToggle}
        >
          <span>{label}</span>
          <span className="overlay-switch" aria-hidden="true" />
        </button>
      )}
    </Tipped>
  );
}

/** The microphone's level as three bars beside its icon, lit from the left. */
function MicLevel({ level }: { level: number }) {
  const shown = perceivedLevel(level);
  return (
    <span className="overlay-mic-level" data-testid="overlay-mic-level" data-level={shown.toFixed(2)} aria-hidden="true">
      {[0.2, 0.5, 0.8].map((at) => (
        <span key={at} data-lit={shown >= at ? "true" : "false"} />
      ))}
    </span>
  );
}

/**
 * Recording options: the format and the system sound, noise removal,
 * clicks and keys, in a popover that a button opens, so the toolbar's
 * row keeps to the microphone and camera.
 */
function OptionsPopover({ up, countdown, children }: { up: boolean; countdown: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // A first click outside only closes it: the overlay never sees it.
    const close = (event: globalThis.MouseEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      const inList = event.target instanceof Element && event.target.closest('[role="menu"], [role="dialog"]');
      if (event.button === 0 && !inList) {
        event.stopPropagation();
        // The focus stays where it was, as for any click on the toolbar.
        event.preventDefault();
        swallowClick();
      }
      setOpen(false);
    };
    window.addEventListener("mousedown", close, true);
    return () => window.removeEventListener("mousedown", close, true);
  }, [open]);
  return (
    <div className="overlay-chip-menu" ref={root}>
      <Tipped tip={{ name: "Recording options", use: "The format, system sound, noise removal, clicks and keys." }}>
        {(describedBy) => (
          <button
            type="button"
            className="overlay-tool overlay-setup-icon"
            data-testid="overlay-record-options"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label="Recording options"
            aria-describedby={describedBy}
            onClick={() => setOpen((was) => !was)}
          >
            <SlidersIcon size={16} />
            {countdown && <span className="overlay-options-countdown">{countdown}</span>}
          </button>
        )}
      </Tipped>
      {open && (
        <div
          className="overlay-chip-list overlay-options-popover"
          role="dialog"
          aria-label="Recording options"
          data-testid="overlay-record-options-popover"
          data-up={up ? "true" : "false"}
        >
          {children}
        </div>
      )}
    </div>
  );
}

interface RecordSetupProps {
  options: RecordingOptions;
  /** The chosen microphone's level, 0 to 1, or null for none. */
  level?: number | null;
  /** What is being recorded; the source buttons and keys 1 to 3 switch it. */
  source: RecordingSource;
  /** Something is picked, so Record can start. */
  canRecord: boolean;
  /** Lists and tooltips open above, for a toolbar in the lower half. */
  up: boolean;
  /** Places the toolbar; it follows the grip by this alone. */
  transform: string;
  onGrip: (event: MouseEvent) => void;
  onSource: (source: RecordingSource) => void;
  onRecord: () => void;
  onCancel: () => void;
}

/**
 * The Record overlay's setup toolbar, in the recording toolbar's look: a
 * grip to move it, what to record (Region, Window or Screen), the
 * recording options, the countdown, Record and Cancel. Every item has a
 * tooltip, in place of a hint line. Capture & record shows the same
 * options in its own toolbar instead.
 */
function RecordSetup({ options, level = null, source, canRecord, up, transform, onGrip, onSource, onRecord, onCancel }: RecordSetupProps) {
  const { recording, save } = options;
  const first = SOURCES.find((each) => each.source === source)?.first ?? "";
  const countdown = recording ? countdownText(recording.countdown) : null;

  return (
    <div
      className="overlay-setup"
      data-testid="overlay-setup"
      data-up={up ? "true" : "false"}
      role="toolbar"
      aria-label="Record"
      style={{ transform }}
      // A click on a button leaves the focus where it was, so Enter never
      // presses it again.
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) event.preventDefault();
      }}
    >
      <Tipped tip={{ name: "Move", use: "Drag to move this toolbar. The recording toolbar opens where you leave it." }}>
        {() => (
          <span
            className="overlay-setup-grip"
            data-testid="overlay-setup-grip"
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
      </Tipped>
      <div className="overlay-setup-sources" role="group" aria-label="What to record">
        {SOURCES.map(({ source: each, label, icon, use }, at) => (
          <Tipped key={each} tip={{ name: label, keyLabel: String(at + 1), use }}>
            {(describedBy) => (
              <button
                type="button"
                className="overlay-tool"
                aria-pressed={each === source}
                aria-describedby={describedBy}
                aria-keyshortcuts={String(at + 1)}
                onClick={() => onSource(each)}
              >
                {icon}
                <span>{label}</span>
                <kbd aria-hidden="true">{at + 1}</kbd>
              </button>
            )}
          </Tipped>
        ))}
      </div>
      <span className="overlay-toolbar-gap" aria-hidden="true" />
      <RecordOptionsFields options={options} up={up} iconsOnly={false} level={level} />
      {recording && countdown && (
        <Tipped tip={{ name: "Countdown", use: COUNTDOWN_USE }}>
          {(describedBy) => (
            <button
              type="button"
              className="overlay-tool overlay-setup-countdown"
              aria-pressed={recording.countdown > 0}
              aria-label={countdown.label}
              aria-describedby={describedBy}
              onClick={() => save({ ...recording, countdown: nextCountdown(recording.countdown) })}
            >
              <TimerIcon size={16} />
              <span>{countdown.text}</span>
            </button>
          )}
        </Tipped>
      )}
      <Tipped tip={{ name: "Record", keyLabel: "Enter", use: canRecord ? "Starts recording." : first }}>
        {(describedBy) => (
          <button
            type="button"
            className="overlay-setup-record"
            data-testid="overlay-record"
            // Dimmed, not disabled, so its tooltip still says what to do first.
            aria-disabled={canRecord ? undefined : "true"}
            aria-describedby={describedBy}
            aria-keyshortcuts="Enter"
            onClick={() => {
              if (canRecord) onRecord();
            }}
          >
            <span className="overlay-setup-dot" aria-hidden="true" />
            <span>Record</span>
            <kbd aria-hidden="true">↵</kbd>
          </button>
        )}
      </Tipped>
      <Tipped tip={{ name: "Cancel", keyLabel: "Esc", use: "Closes without recording." }}>
        {(describedBy) => (
          <button
            type="button"
            className="overlay-tool overlay-setup-icon"
            aria-label="Cancel"
            aria-describedby={describedBy}
            aria-keyshortcuts="Escape"
            onClick={onCancel}
          >
            <CloseIcon size={14} />
          </button>
        )}
      </Tipped>
    </div>
  );
}

export default RecordSetup;
