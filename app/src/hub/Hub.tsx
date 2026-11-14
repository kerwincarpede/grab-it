import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "../app/app.css";
import "./hub.css";
import Logo from "../app/Logo";
import {
  ColourIcon,
  ChevronDownIcon,
  GearIcon,
  RecordIcon,
  RegionIcon,
  ScreenIcon,
  TextIcon,
  WindowIcon,
} from "../app/icons";
import { openMain, startCapture, checkForUpdates, type CaptureKind } from "../app/api";
import { getSettings, type Hotkeys } from "../settings/api";
import { shortcutLabel } from "./keys";
import { formatTime, listShots, openShot, type Shot } from "../library/api";
import { useThumbnail } from "../library/thumbnails";

/** Mirrors `HUB_SHOWN_EVENT` in src-tauri/src/hub.rs. */
const HUB_SHOWN_EVENT = "hub-shown";
/** How many recent captures the hub shows. */
const RECENT = 3;

/** The captures under Capture region, each in its own tint. */
const TOOLS: { kind: CaptureKind; title: string; hotkey?: keyof Hotkeys; tint: string; icon: ReactNode }[] = [
  { kind: "window", title: "Window", hotkey: "window", tint: "blue", icon: <WindowIcon size={18} /> },
  { kind: "screen", title: "Screen", hotkey: "screen", tint: "violet", icon: <ScreenIcon size={18} /> },
  { kind: "record", title: "Record", tint: "red", icon: <RecordIcon size={18} /> },
  { kind: "text", title: "Text", hotkey: "text", tint: "green", icon: <TextIcon size={18} /> },
  { kind: "colour", title: "Colour", hotkey: "colour", tint: "amber", icon: <ColourIcon size={18} /> },
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

  const keyLabel = (kind: CaptureKind, hotkey?: keyof Hotkeys) =>
    kind === "record" ? "GIF" : hotkey && hotkeys?.[hotkey] ? shortcutLabel(hotkeys[hotkey]) : "";

  const toggle = (next: Panel) => setPanel((current) => (current === next ? null : next));

  return (
    <main className="hub">
      <header className="hub-head">
        <Logo size={28} />
        <span className="brand-name">Grab-it</span>
        <button type="button" className="pill hub-open" onClick={() => run(openMain("library"))}>
          Open Grab-it
        </button>
        <button type="button" className="hub-icon" aria-label="Settings" title="Settings" onClick={() => run(openMain("settings"))}>
          <GearIcon />
        </button>
      </header>

      <div className="hub-primary">
        <button type="button" className="cta hub-region" onClick={() => run(startCapture("region"))}>
          <RegionIcon size={18} />
          Capture region
          {hotkeys?.region && <kbd className="cta-key">{shortcutLabel(hotkeys.region)}</kbd>}
        </button>
      </div>

      <div className="hub-tools">
        {TOOLS.map(({ kind, title, hotkey, tint, icon }) => (
          <button type="button" key={kind} className="hub-tool" onClick={() => run(startCapture(kind))}>
            <span className={`hub-tool-icon tint-${tint}`} aria-hidden="true">
              {icon}
            </span>
            {title}{" "}
            <span className="hub-key" title={keyLabel(kind, hotkey)}>
              {keyLabel(kind, hotkey) || " "}
            </span>
          </button>
        ))}
      </div>

      <div className="hub-chips">
        <button type="button" className="pill" onClick={() => run(startCapture("repeat"))}>
          Repeat last region
        </button>
        <button type="button" className="pill" aria-expanded={panel === "timed"} onClick={() => toggle("timed")}>
          Timed
          <ChevronDownIcon size={12} />
        </button>
        {monitors.length > 1 && (
          <button type="button" className="pill" aria-expanded={panel === "monitor"} onClick={() => toggle("monitor")}>
            Monitor
            <ChevronDownIcon size={12} />
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
