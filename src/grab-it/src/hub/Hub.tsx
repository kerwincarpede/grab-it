import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import "../app/app.css";
import "./hub.css";
import Logo from "../app/Logo";
import {
  AllInOneIcon,
  ChevronRightIcon,
  ColourIcon,
  OpenIcon,
  RecordIcon,
  RegionIcon,
  RepeatIcon,
  ScreenIcon,
  SlidersIcon,
  StepsIcon,
  TextIcon,
  TimerIcon,
  WindowIcon,
} from "../app/icons";
import { openMain, startCapture, type CaptureKind } from "../app/api";
import { useEffectiveHotkeys } from "../app/useEffectiveHotkeys";
import { formatTime, listShots, openShot, type Shot } from "../library/api";
import { useThumbnail } from "../library/thumbnails";
import { IDLE, hideHub, hubActivity, hubMonitors, onHubActivity, quitApp, type HubActivity, type HubMonitor } from "./api";

/** Mirrors `HUB_SHOWN_EVENT` in src-tauri/src/hub.rs. */
const HUB_SHOWN_EVENT = "hub-shown";
/** How many recent captures the hub shows. */
const RECENT = 3;

interface Tool {
  kind: CaptureKind;
  title: string;
  icon: ReactNode;
  /** What it says while it runs, when choosing it again stops it. */
  stop?: { title: string; running: keyof HubActivity };
}

/** The captures under Capture region. */
const TOOLS: Tool[] = [
  { kind: "allInOne", title: "Capture & record…", icon: <AllInOneIcon /> },
  { kind: "window", title: "Window", icon: <WindowIcon /> },
  { kind: "screen", title: "Screen", icon: <ScreenIcon /> },
  { kind: "record", title: "Record", icon: <RecordIcon />, stop: { title: "Stop recording", running: "recording" } },
  { kind: "text", title: "Grab text", icon: <TextIcon /> },
  { kind: "colour", title: "Pick colour", icon: <ColourIcon /> },
  { kind: "steps", title: "Step capture", icon: <StepsIcon />, stop: { title: "Stop step capture", running: "steps" } },
];

/** `found` as an activity, or nothing running when the backend sent something else. */
function activityOf(found: HubActivity | null | undefined): HubActivity {
  return { recording: found?.recording === true, steps: found?.steps === true };
}

const TIMED: { kind: CaptureKind; title: string; seconds: number }[] = [
  { kind: "region", title: "Region in 3 s", seconds: 3 },
  { kind: "region", title: "Region in 5 s", seconds: 5 },
  { kind: "region", title: "Region in 10 s", seconds: 10 },
  { kind: "screen", title: "Screen in 5 s", seconds: 5 },
];

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

function RecentShot({ shot }: { shot: Shot }) {
  const { url } = useThumbnail(shot, true);
  return (
    <div className="hub-recent-item">
      <button
        type="button"
        className="hub-recent-shot"
        title={shot.windowTitle ?? shot.fileName}
        aria-label={`Open ${shot.windowTitle ?? shot.fileName} in the editor`}
        onClick={() => void openShot(shot.id)}
      >
        {url && <img src={url} alt="" />}
      </button>
      {typeof shot.capturedAt === "number" && <span className="hub-recent-time">{formatTime(shot.capturedAt)}</span>}
    </div>
  );
}

type Panel = "timed" | "monitor" | null;

/** The window under the tray icon: capture, see what you just took, open Grab-it. */
function Hub() {
  const hotkeys = useEffectiveHotkeys();
  const primary = useRef<HTMLButtonElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState<Shot[]>([]);
  const [monitors, setMonitors] = useState<HubMonitor[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<HubActivity>(IDLE);

  const load = useCallback(() => {
    listShots(0, RECENT)
      .then((page) => setRecent(Array.isArray(page?.shots) ? page.shots : []))
      .catch(() => {});
    hubMonitors()
      .then((found) => setMonitors(Array.isArray(found) ? found : []))
      .catch(() => {});
    hubActivity()
      .then((found) => setActivity(activityOf(found)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    primary.current?.focus();
    load();
    let disposed = false;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => (disposed ? stop() : stops.push(stop));
    // Shown again: start from the top, with fresh captures.
    listen(HUB_SHOWN_EVENT, () => {
      primary.current?.focus();
      setPanel(null);
      setError(null);
      load();
    })
      .then(keep)
      .catch(() => {});
    // A recording or step capture started or stopped while it is open.
    onHubActivity((found) => setActivity(activityOf(found)))
      .then(keep)
      .catch(() => {});
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void hideHub();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      window.removeEventListener("keydown", onKey);
    };
  }, [load]);

  useEffect(() => {
    submenu.current?.scrollIntoView?.({ block: "nearest" });
  }, [panel]);

  function run(action: Promise<void>) {
    action.catch((err: unknown) => setError(errorMessage(err)));
  }

  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next));

  return (
    <main className="hub">
      <header className="hub-head">
        <Logo size={22} />
        <span className="hub-name">Grab-it</span>
        <button type="button" className="hub-icon" aria-label="Open Grab-it" title={hotkeys?.library ? `Open Grab-it (${hotkeys.library})` : "Open Grab-it"} onClick={() => run(openMain("library"))}>
          <OpenIcon size={15} />
        </button>
        <button type="button" className="hub-icon" aria-label="Settings" title="Settings" onClick={() => run(openMain("settings"))}>
          <SlidersIcon size={15} />
        </button>
      </header>

      <div className="hub-scroll">
        <button type="button" ref={primary} className="hub-item is-primary" onClick={() => run(startCapture("region"))}>
          <RegionIcon />
          Capture region
          {hotkeys?.region && <kbd className="hub-key">{hotkeys.region}</kbd>}
        </button>
        {TOOLS.map(({ kind, title, icon, stop }) => {
          const running = stop !== undefined && activity[stop.running];
          return (
            <button type="button" key={kind} className={running ? "hub-item is-running" : "hub-item"} onClick={() => run(startCapture(kind))}>
              {icon}
              {running && stop ? stop.title : title}
              {running && <span className="hub-live" aria-hidden="true" />}
              {hotkeys[kind] && <kbd className="hub-key">{hotkeys[kind]}</kbd>}
            </button>
          );
        })}

        <hr className="hub-sep" />
        <button type="button" className="hub-item" onClick={() => run(startCapture("repeat"))}>
          <RepeatIcon />
          Repeat last region
        </button>
        <button type="button" className="hub-item" aria-expanded={panel === "timed"} onClick={() => toggle("timed")}>
          <TimerIcon />
          Timed
          <ChevronRightIcon size={13} />
        </button>
        {panel === "timed" && (
          <div className="hub-sub" ref={submenu}>
            {TIMED.map(({ kind, title, seconds }) => (
              <button type="button" key={title} onClick={() => run(startCapture(kind, { delaySeconds: seconds }))}>
                {title}
              </button>
            ))}
          </div>
        )}
        {monitors.length > 1 && (
          <button type="button" className="hub-item" aria-expanded={panel === "monitor"} onClick={() => toggle("monitor")}>
            <ScreenIcon />
            Monitor
            <ChevronRightIcon size={13} />
          </button>
        )}
        {panel === "monitor" && (
          <div className="hub-sub" ref={submenu}>
            {monitors.map(({ index, label }) => (
              <button type="button" key={index} onClick={() => run(startCapture("monitor", { monitor: index }))}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <hr className="hub-sep" />
      <div className="hub-recent-head">
        <h2>Recent</h2>
        <button type="button" className="link-button" onClick={() => run(openMain("library"))}>
          Show all
        </button>
      </div>
      {recent.length > 0 ? (
        <div className="hub-recent">
          {recent.map((shot) => (
            <RecentShot key={shot.id} shot={shot} />
          ))}
        </div>
      ) : (
        <p className="hub-empty">Your captures will show up here.</p>
      )}

      {error && (
        <p role="alert" className="hub-error">
          {error}
        </p>
      )}

      <footer className="hub-foot">
        <button type="button" className="link-button" onClick={() => run(openMain("welcome"))}>
          Shortcuts
        </button>
        <button type="button" className="link-button hub-quit" onClick={() => void quitApp()}>
          Quit
        </button>
      </footer>
    </main>
  );
}

export default Hub;
