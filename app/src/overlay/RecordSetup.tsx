import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CameraIcon,
  ChevronDownIcon,
  ClickIcon,
  KeyboardIcon,
  MicIcon,
  MicOffIcon,
  SpeakerIcon,
  TimerIcon,
} from "../app/icons";
import {
  DEFAULT_RECORDING,
  getSettings,
  listMicrophones,
  recordsMicrophone,
  recordsSystemSound,
  setRecording,
  systemSoundAvailable,
  type Microphone,
  type RecordingSettings,
} from "../settings/api";
import { microphoneLabel, nextCountdown, withMicrophone, withSystemSound } from "./recordSetup";

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

interface ChipMenuProps {
  label: ReactNode;
  icon?: ReactNode;
  title: string;
  disabled?: boolean;
  /** Opens above the chip, for a panel near the bottom of the screen. */
  up: boolean;
  options: { key: string; title: string; selected: boolean; onPick: () => void }[];
}

/** A chip that opens a short list to pick from. */
function ChipMenu({ label, icon, title, disabled, up, options }: ChipMenuProps) {
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
        <div className="overlay-chip-list" role="menu" aria-label={title} data-up={up ? "true" : "false"}>
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={option.selected}
              className="overlay-chip-option"
              onClick={() => {
                setOpen(false);
                option.onPick();
              }}
            >
              {option.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ToggleChipProps {
  label: string;
  icon: ReactNode;
  on: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
}

function ToggleChip({ label, icon, on, disabled, title, onToggle }: ToggleChipProps) {
  return (
    <button
      type="button"
      className="overlay-tool overlay-chip"
      aria-pressed={on}
      disabled={disabled}
      title={title ?? label}
      onClick={onToggle}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

interface RecordSetupProps {
  /** Lists open above their chips. */
  up: boolean;
}

/**
 * How to record, beside a held recording area: the format, the
 * microphone, the system sound, the webcam, clicks, keys and a countdown.
 * Each choice is saved to Settings → Recording as it is made, so the next
 * recording starts with it.
 */
function RecordSetup({ up }: RecordSetupProps) {
  const [recording, setLocal] = useState<RecordingSettings | null>(null);
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  const [system, setSystem] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (!cancelled) setLocal({ ...DEFAULT_RECORDING, ...settings.recording });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    listMicrophones()
      .then((listed) => {
        if (!cancelled) setMicrophones(listed);
      })
      .catch(() => {
        // The default microphone is still offered.
      });
    systemSoundAvailable()
      .then((available) => {
        if (!cancelled) setSystem(available);
      })
      .catch(() => {
        // Then system sound is not offered.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!recording) {
    return (
      <div className="overlay-record-setup" data-testid="overlay-record-setup">
        <span className="overlay-record-note">{error ?? "Loading recording options…"}</span>
      </div>
    );
  }

  function save(next: RecordingSettings) {
    const before = recording;
    setLocal(next);
    setError(null);
    setRecording(next).catch((err: unknown) => {
      setLocal(before);
      setError(String(err));
    });
  }

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

  return (
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
      {system && (
        <ToggleChip
          label="System sound"
          icon={<SpeakerIcon size={14} />}
          on={!gif && recordsSystemSound(recording.audio)}
          disabled={gif}
          title={silent}
          onToggle={() => save(withSystemSound(recording, !recordsSystemSound(recording.audio)))}
        />
      )}
      <ToggleChip
        label="Webcam"
        icon={<CameraIcon size={14} />}
        on={recording.showWebcam}
        onToggle={() => save({ ...recording, showWebcam: !recording.showWebcam })}
      />
      <ToggleChip
        label="Clicks"
        icon={<ClickIcon size={14} />}
        on={recording.showClicks}
        onToggle={() => save({ ...recording, showClicks: !recording.showClicks })}
      />
      <ToggleChip
        label="Keys"
        icon={<KeyboardIcon size={14} />}
        on={recording.showKeystrokes}
        onToggle={() => save({ ...recording, showKeystrokes: !recording.showKeystrokes })}
      />
      <ToggleChip
        label={recording.countdown === 0 ? "No countdown" : `${recording.countdown} s`}
        icon={<TimerIcon size={14} />}
        on={recording.countdown > 0}
        title="Countdown before recording"
        onToggle={() => save({ ...recording, countdown: nextCountdown(recording.countdown) })}
      />
      {error && (
        <span className="overlay-record-note overlay-record-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export default RecordSetup;
