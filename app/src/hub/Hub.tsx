import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "../app/app.css";
import "./hub.css";
import Logo from "../app/Logo";
import {
  ColourIcon,
  GearIcon,
  RecordIcon,
  RegionIcon,
  RepeatIcon,
  ScreenIcon,
  TextIcon,
  TimerIcon,
  WindowIcon,
} from "../app/icons";
import { openMain, startCapture, checkForUpdates, type CaptureKind } from "../app/api";
import { getSettings, type Hotkeys } from "../settings/api";
import { shortcutLabel } from "./keys";
import { listShots, openShot, type Shot } from "../library/api";
import { useThumbnail } from "../library/thumbnails";

/** Mirrors `HUB_SHOWN_EVENT` in src-tauri/src/hub.rs. */
const HUB_SHOWN_EVENT = "hub-shown";
/** How many recent captures the hub shows. */
const RECENT = 4;

const CAPTURES: { kind: CaptureKind; title: string; hotkey?: keyof Hotkeys; icon: ReactNode }[] = [
  { kind: "region", title: "Region", hotkey: "region", icon: <RegionIcon size={20} /> },
  { kind: "window", title: "Window", hotkey: "window", icon: <WindowIcon size={20} /> },
  { kind: "screen", title: "Screen", hotkey: "screen", icon: <ScreenIcon size={20} /> },
  { kind: "record", title: "Record GIF", icon: <RecordIcon size={20} /> },
  { kind: "text", title: "Text", hotkey: "text", icon: <TextIcon size={20} /> },
  { kind: "colour", title: "Colour", hotkey: "colour", icon: <ColourIcon size={20} /> },
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
    <button
      type="button"
      className="hub-recent-shot"
      title={shot.windowTitle ?? shot.fileName}
      aria-label={`Open ${shot.windowTitle ?? shot.fileName} in the editor`}
      onClick={() => void openShot(shot.id)}
    >
      {url && <img src={url} alt="" />}
    </button>
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
  }, []);

  useEffect(() => {
    load();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Shown again: start from the top, with fresh captures.
    listen(HUB_SHOWN_EVENT, () => {
      setPanel(null);
      setError(null);
      load();
    })
      .then((stop) => (disposed ? stop() : (unlisten = stop)))
      .catch(() => {});
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void invoke("hub_hide");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [load]);

  function run(action: Promise<void>) {
    action.catch((err: unknown) => setError(errorMessage(err)));
  }

  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next));

  return (
    <main className="hub">
      <header className="hub-head">
        <Logo size={28} />
        <span className="brand-name">Grab-it</span>
        <button type="button" className="hub-open" onClick={() => run(openMain("library"))}>
          Open Grab-it
        </button>
        <button type="button" className="hub-icon" aria-label="Settings" title="Settings" onClick={() => run(openMain("settings"))}>
          <GearIcon />
        </button>
      </header>

      <div className="hub-captures">
        {CAPTURES.map(({ kind, title, hotkey, icon }) => (
          <button
            type="button"
            key={kind}
            className={`hub-capture${kind === "region" ? " is-primary" : ""}`}
            onClick={() => run(startCapture(kind))}
          >
            {icon}
            <span>
              {title}
              <span className="hub-key">
                {hotkey && hotkeys?.[hotkey] ? shortcutLabel(hotkeys[hotkey]) : kind === "record" ? "start or stop" : " "}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="hub-chips">
        <button type="button" className="hub-chip" onClick={() => run(startCapture("repeat"))}>
          <RepeatIcon size={14} />
          Repeat last region
        </button>
        <button type="button" className="hub-chip" aria-expanded={panel === "timed"} onClick={() => toggle("timed")}>
          <TimerIcon size={14} />
          Timed
        </button>
        {monitors.length > 1 && (
          <button type="button" className="hub-chip" aria-expanded={panel === "monitor"} onClick={() => toggle("monitor")}>
            <ScreenIcon size={14} />
            Monitor
          </button>
        )}
      </div>
      {panel === "timed" && (
        <div className="hub-options">
          {TIMED.map(({ kind, title, seconds }) => (
            <button type="button" key={title} onClick={() => run(startCapture(kind, { delaySeconds: seconds }))}>
              {title}
            </button>
          ))}
        </div>
      )}
      {panel === "monitor" && (
        <div className="hub-options">
          {monitors.map(({ index, label }) => (
            <button type="button" key={index} onClick={() => run(startCapture("monitor", { monitor: index }))}>
              {label}
            </button>
          ))}
        </div>
      )}

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
        <button type="button" className="link-button" onClick={() => run(checkForUpdates())}>
          Check for updates
        </button>
        <button type="button" className="link-button hub-quit" onClick={() => void invoke("hub_quit")}>
          Quit
        </button>
      </footer>
    </main>
  );
}

export default Hub;
