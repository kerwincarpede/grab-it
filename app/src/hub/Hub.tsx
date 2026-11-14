import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "../app/app.css";
import "./hub.css";
import Logo from "../app/Logo";
import {
  ChevronRightIcon,
  ColourIcon,
  OpenIcon,
  RecordIcon,
  RegionIcon,
  RepeatIcon,
  ScreenIcon,
  SlidersIcon,
  TextIcon,
  TimerIcon,
  WindowIcon,
} from "../app/icons";
import { openMain, startCapture, type CaptureKind } from "../app/api";
import { checkForUpdate, onUpdateStatus, pendingUpdate, updateStatus, type UpdateStatus } from "../app/updates";
import { getSettings, type Hotkeys } from "../settings/api";
import { shortcutLabel } from "./keys";
import { formatTime, listShots, openShot, type Shot } from "../library/api";
import { useThumbnail } from "../library/thumbnails";

/** Mirrors `HUB_SHOWN_EVENT` in src-tauri/src/hub.rs. */
const HUB_SHOWN_EVENT = "hub-shown";
/** How many recent captures the hub shows. */
const RECENT = 3;

/** The captures under Capture region. */
const TOOLS: { kind: CaptureKind; title: string; hotkey?: keyof Hotkeys; icon: ReactNode }[] = [
  { kind: "window", title: "Window", hotkey: "window", icon: <WindowIcon /> },
  { kind: "screen", title: "Screen", hotkey: "screen", icon: <ScreenIcon /> },
  { kind: "record", title: "Record GIF", icon: <RecordIcon /> },
  { kind: "text", title: "Grab text", hotkey: "text", icon: <TextIcon /> },
  { kind: "colour", title: "Pick colour", hotkey: "colour", icon: <ColourIcon /> },
];

const TIMED: { kind: CaptureKind; title: string; seconds: number }[] = [
  { kind: "region", title: "Region in 3 s", seconds: 3 },
  { kind: "region", title: "Region in 5 s", seconds: 5 },
  { kind: "region", title: "Region in 10 s", seconds: 10 },
  { kind: "screen", title: "Screen in 5 s", seconds: 5 },
];

interface HubMonitor {
  index: number;
  label: string;
}

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

function RecentShot({ shot }: { shot: Shot }) {
  const { url } = useThumbnail(shot.id, `${shot.id}:${shot.path}`, true);
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
  const [hotkeys, setHotkeys] = useState<Hotkeys | null>(null);
  const [recent, setRecent] = useState<Shot[]>([]);
  const [monitors, setMonitors] = useState<HubMonitor[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);

  const load = useCallback(() => {
    getSettings()
      .then((settings) => setHotkeys(settings?.hotkeys ?? null))
      .catch(() => {});
    listShots(0, RECENT)
      .then((page) => setRecent(Array.isArray(page?.shots) ? page.shots : []))
      .catch(() => {});
    invoke<HubMonitor[]>("hub_monitors")
      .then((found) => setMonitors(Array.isArray(found) ? found : []))
      .catch(() => {});
    updateStatus()
      .then((status) => setUpdate(status?.state ? status : null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    let disposed = false;
    const stops: (() => void)[] = [];
    const keep = (stop: () => void) => (disposed ? stop() : stops.push(stop));
    // Shown again: start from the top, with fresh captures.
    listen(HUB_SHOWN_EVENT, () => {
      setPanel(null);
      setError(null);
      load();
    })
      .then(keep)
      .catch(() => {});
    onUpdateStatus(({ status }) => setUpdate(status))
      .then(keep)
      .catch(() => {});
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void invoke("hub_hide");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      window.removeEventListener("keydown", onKey);
    };
  }, [load]);

  function run(action: Promise<void>) {
    action.catch((err: unknown) => setError(errorMessage(err)));
  }

  const keyLabel = (hotkey?: keyof Hotkeys) => (hotkey && hotkeys?.[hotkey] ? shortcutLabel(hotkeys[hotkey]) : "");
  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next));
  const waiting = pendingUpdate(update);

  return (
    <main className="hub">
      <header className="hub-head">
        <Logo size={22} />
        <span className="hub-name">Grab-it</span>
        <button type="button" className="hub-icon" aria-label="Open Grab-it" title="Open Grab-it" onClick={() => run(openMain("library"))}>
          <OpenIcon size={15} />
        </button>
        <button type="button" className="hub-icon" aria-label="Settings" title="Settings" onClick={() => run(openMain("settings"))}>
          <SlidersIcon size={15} />
        </button>
      </header>

      <div className="hub-scroll">
        <button type="button" className="hub-item is-primary" onClick={() => run(startCapture("region"))}>
          <RegionIcon />
          Capture region
          {hotkeys?.region && <kbd className="hub-key">{shortcutLabel(hotkeys.region)}</kbd>}
        </button>
        {TOOLS.map(({ kind, title, hotkey, icon }) => (
          <button type="button" key={kind} className="hub-item" onClick={() => run(startCapture(kind))}>
            {icon}
            {title}
            {keyLabel(hotkey) && <kbd className="hub-key">{keyLabel(hotkey)}</kbd>}
          </button>
        ))}

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
          <div className="hub-sub">
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
          <div className="hub-sub">
            {monitors.map(({ index, label }) => (
              <button type="button" key={index} onClick={() => run(startCapture("monitor", { monitor: index }))}>
                {label}
              </button>
            ))}
          </div>
        )}

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
      </div>

      {error && (
        <p role="alert" className="hub-error">
          {error}
        </p>
      )}

      {waiting && (
        <button type="button" className="hub-update" onClick={() => run(checkForUpdate())}>
          {update?.state === "installing" ? `Installing Grab-it ${waiting.version}…` : `Grab-it ${waiting.version} is ready`}
          {update?.state !== "installing" && <span>Update</span>}
        </button>
      )}

      <footer className="hub-foot">
        <button type="button" className="link-button" onClick={() => run(openMain("welcome"))}>
          Shortcuts
        </button>
        {!waiting && (
          <button type="button" className="link-button" onClick={() => run(checkForUpdate())}>
            Check for updates
          </button>
        )}
        <button type="button" className="link-button hub-quit" onClick={() => void invoke("hub_quit")}>
          Quit
        </button>
      </footer>
    </main>
  );
}

export default Hub;
