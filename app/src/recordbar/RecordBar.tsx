import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./recordbar.css";
import {
  CameraIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  GripIcon,
  MicIcon,
  MicOffIcon,
  PauseIcon,
  PinIcon,
  PlayIcon,
  RestartIcon,
  SpeakerIcon,
  SpeakerOffIcon,
  StopIcon,
  TrashIcon,
} from "../app/icons";
import {
  barStatus,
  countdownLeft,
  discardRecording,
  fitBar,
  formatClock,
  microphoneLevel,
  muteInput,
  onBarStatus,
  pauseRecording,
  recordedMs,
  resetBarPosition,
  restartRecording,
  showWebcam,
  stopRecording,
  type BarStatus,
} from "./api";

/** The room around the pill for its shadow, in CSS px. Matches `.recordbar` padding. */
const EDGE = 10;
/** The gap between the pill and its open menu, in CSS px. */
const MENU_GAP = 6;
/** How often the clock ticks and the microphone's level is read, in ms. */
const TICK_MS = 250;
const LEVEL_MS = 100;
/** The level each bar of the meter lights up at, quietest first. */
const METER_STEPS = [0.02, 0.08, 0.2, 0.4];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs a toolbar action, logging what went wrong rather than failing silently. */
function run(action: () => Promise<unknown>) {
  action().catch((err: unknown) => console.error(`Grab-it: ${errorText(err)}`));
}

/** The time now, ticking every `interval` ms while `ticking`. */
function useNow(ticking: boolean, interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [ticking, interval]);
  return now;
}

/** What the backend says the recording is doing, kept up to date. */
function useBarStatus(): BarStatus | null {
  const [status, setStatus] = useState<BarStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onBarStatus((next) => {
      if (!cancelled) setStatus(next);
    })
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        // Read after subscribing, so a change in between is not missed.
        return barStatus().then((loaded) => {
          if (!cancelled && loaded) setStatus(loaded);
        });
      })
      .catch((err: unknown) => console.error(`Grab-it: ${errorText(err)}`));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return status;
}

/** The microphone's level, read while `listening`; 0 otherwise. */
function useLevel(listening: boolean): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!listening) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      microphoneLevel()
        .then((next) => {
          if (!cancelled) setLevel(next ?? 0);
        })
        .catch(() => {
          // The meter just stays still.
        });
    }, LEVEL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [listening]);
  return listening ? level : 0;
}

function startDragging() {
  try {
    void getCurrentWindow()
      .startDragging()
      .catch(() => undefined);
  } catch {
    // Outside a Tauri window there is nothing to drag.
  }
}

interface ToolProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  pressed?: boolean;
  expanded?: boolean;
  disabled?: boolean;
}

function Tool({ label, onClick, children, className, pressed, expanded, disabled }: ToolProps) {
  return (
    <button
      type="button"
      className={className ? `recordbar-tool ${className}` : "recordbar-tool"}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface MenuProps {
  status: BarStatus;
  onDone: () => void;
}

/** The rest of the toolbar: sounds and webcam on or off, Restart, Discard and where it sits. */
function Menu({ status, onDone }: MenuProps) {
  const recording = status.phase === "recording";
  const choose = (action: () => Promise<unknown>) => () => {
    onDone();
    run(action);
  };
  const toggle = (label: string, on: boolean, icon: ReactNode, change: () => Promise<unknown>) => (
    <button type="button" role="menuitemcheckbox" aria-checked={on} className="recordbar-item" onClick={() => run(change)}>
      {icon}
      <span className="recordbar-item-label">{label}</span>
      <span className="recordbar-switch" data-on={on ? "true" : "false"} aria-hidden="true" />
    </button>
  );
  return (
    <div className="recordbar-menu" role="menu" aria-label="Recording options">
      {status.microphone !== null &&
        toggle("Microphone", !status.microphone, <MicIcon size={15} />, () => muteInput("microphone", !status.microphone))}
      {status.system !== null &&
        toggle("System sound", !status.system, <SpeakerIcon size={15} />, () => muteInput("system", !status.system))}
      {toggle("Webcam", status.webcam, <CameraIcon size={15} />, () => showWebcam(!status.webcam))}
      <div className="recordbar-separator" role="separator" />
      <button type="button" role="menuitem" className="recordbar-item" disabled={!recording} onClick={choose(restartRecording)}>
        <RestartIcon size={15} />
        <span className="recordbar-item-label">Restart</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="recordbar-item recordbar-danger"
        disabled={status.phase === "saving"}
        onClick={choose(discardRecording)}
      >
        <TrashIcon size={15} />
        <span className="recordbar-item-label">Discard</span>
      </button>
      <button type="button" role="menuitem" className="recordbar-item" onClick={choose(resetBarPosition)}>
        <PinIcon size={15} />
        <span className="recordbar-item-label">Move back to the top</span>
      </button>
    </div>
  );
}

interface RecordBarProps {
  /** Shown as given, for tests; otherwise read from the backend. */
  status?: BarStatus | null;
}

/**
 * The recording toolbar: a small pill with the time, the microphone,
 * Pause, Stop and a menu of the rest. Dragged by its body, it remembers
 * where it was left on each display (see src-tauri/src/record_bar.rs).
 */
function RecordBar({ status: given }: RecordBarProps) {
  const live = useBarStatus();
  const status = given === undefined ? live : given;
  const [menuChosen, setMenuOpen] = useState(false);
  const [up, setUp] = useState(false);
  const pill = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const fitted = useRef<string>("");

  const phase = status?.phase ?? null;
  const paused = status?.pausedAt !== null && status?.pausedAt !== undefined;
  const now = useNow(phase === "recording" || phase === "countdown", TICK_MS);
  const micOn = status?.microphone === false;
  // Saving has nothing left to change.
  const menuOpen = menuChosen && phase !== "saving";
  const level = useLevel(micOn && phase === "recording" && !paused);

  // The window is see-through: only the pill and its menu may paint.
  useLayoutEffect(() => {
    document.documentElement.classList.add("recordbar-clear");
    return () => document.documentElement.classList.remove("recordbar-clear");
  }, []);

  // The window is fitted to the pill, and to the menu while it is open.
  useLayoutEffect(() => {
    const box = pill.current;
    if (!box) return;
    const width = Math.ceil(box.offsetWidth) + 2 * EDGE;
    const height = Math.ceil(box.offsetHeight) + 2 * EDGE;
    const menuHeight = menuOpen && menu.current ? Math.ceil(menu.current.offsetHeight) + MENU_GAP : null;
    const key = `${width}x${height}+${menuHeight ?? 0}`;
    if (key === fitted.current) return;
    fitted.current = key;
    fitBar(width, height, menuHeight)
      .then((layout) => setUp(layout.up))
      .catch(() => {
        // Outside Grab-it's window there is nothing to fit.
      });
  });

  if (!status) return null;

  function onPillMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    // Buttons take their own clicks.
    if ((event.target as HTMLElement).closest("button")) return;
    // A drag must not start a text selection.
    event.preventDefault();
    if (menuOpen) {
      // The window is fitted back to the pill before it can be moved.
      setMenuOpen(false);
      return;
    }
    startDragging();
  }

  const recorded = recordedMs(status, now);
  let body: ReactNode;
  if (status.phase === "countdown") {
    body = (
      <>
        <span className="recordbar-count" aria-live="polite">
          {countdownLeft(status, now)}
        </span>
        <span className="recordbar-note">Starting…</span>
        <Tool label="Cancel recording" className="recordbar-cancel" onClick={() => run(stopRecording)}>
          <CloseIcon size={15} />
        </Tool>
      </>
    );
  } else if (status.phase === "saving") {
    body = (
      <>
        <span className="recordbar-spinner" aria-hidden="true" />
        <span className="recordbar-note" role="status">
          Saving…
        </span>
      </>
    );
  } else {
    body = (
      <>
        <span className="recordbar-dot" data-paused={paused ? "true" : "false"} aria-hidden="true" />
        <span className="recordbar-time" role="timer" aria-label={paused ? "Paused" : "Recording"}>
          {formatClock(recorded)}
          {status.maxSeconds !== null && <span className="recordbar-limit"> / {formatClock(status.maxSeconds * 1000)}</span>}
        </span>
        <span className="recordbar-sep" aria-hidden="true" />
        {status.microphone !== null && (
          <>
            <Tool
              label={status.microphone ? "Turn the microphone on" : "Mute the microphone"}
              className={status.microphone ? "recordbar-off" : undefined}
              pressed={status.microphone}
              onClick={() => run(() => muteInput("microphone", !status.microphone))}
            >
              {status.microphone ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
            </Tool>
            <span className="recordbar-meter" data-testid="recordbar-meter" aria-hidden="true">
              {METER_STEPS.map((step) => (
                <i key={step} data-on={level >= step ? "true" : "false"} />
              ))}
            </span>
          </>
        )}
        {status.microphone === null && status.system !== null && (
          <Tool
            label={status.system ? "Turn the system sound on" : "Mute the system sound"}
            className={status.system ? "recordbar-off" : undefined}
            pressed={status.system}
            onClick={() => run(() => muteInput("system", !status.system))}
          >
            {status.system ? <SpeakerOffIcon size={16} /> : <SpeakerIcon size={16} />}
          </Tool>
        )}
        <Tool label={paused ? "Resume" : "Pause"} onClick={() => run(() => pauseRecording(!paused))}>
          {paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />}
        </Tool>
        <Tool label="More" expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          {menuOpen === up ? <ChevronDownIcon size={16} /> : <ChevronUpIcon size={16} />}
        </Tool>
        <Tool label="Stop and save" className="recordbar-stop" onClick={() => run(stopRecording)}>
          <StopIcon size={16} />
        </Tool>
      </>
    );
  }

  const openMenu = menuOpen && (
    <div ref={menu} className="recordbar-menu-wrap">
      <Menu status={status} onDone={() => setMenuOpen(false)} />
    </div>
  );
  return (
    <main className="recordbar" data-testid="recordbar" data-up={up ? "true" : "false"} onContextMenu={(event) => event.preventDefault()}>
      {up && openMenu}
      <div
        ref={pill}
        className="recordbar-pill"
        data-phase={status.phase}
        title="Drag to move"
        onMouseDown={onPillMouseDown}
      >
        <span className="recordbar-grip" aria-hidden="true">
          <GripIcon size={14} />
        </span>
        {body}
      </div>
      {!up && openMenu}
    </main>
  );
}

export default RecordBar;
