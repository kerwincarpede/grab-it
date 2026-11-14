import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./welcome.css";
import Logo from "../app/Logo";
import {
  CardIcon,
  ColourIcon,
  GridIcon,
  PenIcon,
  PinIcon,
  RecordIcon,
  RegionIcon,
  ScreenIcon,
  SearchIcon,
  SparkleIcon,
  TextIcon,
  WindowIcon,
} from "../app/icons";
import { keyCaps } from "../hub/keys";
import { onAiStatus } from "../library/api";
import { aiProvider, getSettings, type Hotkeys } from "../settings/api";

/** Opens a window or starts a capture by its `--open` name. */
function openTarget(target: string): Promise<void> {
  return invoke<void>("open_target", { target });
}

/** The hotkeys in the order they are listed, with what each one does. */
const SHORTCUTS: { key: keyof Hotkeys; title: string; detail: string; icon: ReactNode }[] = [
  { key: "region", title: "Capture a region", detail: "Drag an area, or click a window.", icon: <RegionIcon /> },
  { key: "window", title: "Capture a window", detail: "Hover a window and click it.", icon: <WindowIcon /> },
  { key: "screen", title: "Capture the screen", detail: "Every monitor at once.", icon: <ScreenIcon /> },
  { key: "text", title: "Capture text", detail: "Drag over text to copy it.", icon: <TextIcon /> },
  { key: "colour", title: "Pick a colour", detail: "Click a pixel to copy its hex code.", icon: <ColourIcon /> },
  { key: "library", title: "Open the library", detail: "Every capture, searchable, from anywhere.", icon: <GridIcon /> },
];

const TIP_ICONS: Record<string, ReactNode> = {
  "Quick Access": <CardIcon />,
  Annotate: <PenIcon />,
  Pin: <PinIcon />,
  Record: <RecordIcon />,
  Library: <SearchIcon />,
  "AI descriptions": <SparkleIcon />,
};

const TIPS: { title: string; detail: string }[] = [
  {
    title: "Quick Access",
    detail: "After each capture a card in the corner offers Copy, Annotate and Pin. It goes away by itself.",
  },
  {
    title: "Annotate",
    detail: "Arrows, steps, blur and spotlight, plus a backdrop with padding and rounded corners.",
  },
  { title: "Pin", detail: "Keep a capture floating above your other windows while you work." },
  { title: "Record", detail: "Record a region or a window as a GIF: click the Grab-it icon, then Record GIF." },
  { title: "Library", detail: "Every capture, searchable by the text inside the image." },
];

/** Added to the tips while Claude Code describes captures. */
const CLAUDE_TIP = {
  title: "AI descriptions",
  detail:
    "Claude Code describes each new capture, so you can search for what it shows. Change or turn it off in Settings.",
};

/**
 * Shown once, on the first launch, and from the tray afterwards: a tray app
 * opens no window of its own, so this says where it lives and how to use it.
 */
function WelcomeWindow({ onClose }: { onClose?: () => void } = {}) {
  const [hotkeys, setHotkeys] = useState<Hotkeys | null>(null);
  const [claudeDescribes, setClaudeDescribes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const load = () =>
      getSettings()
        .then((settings) => {
          if (cancelled) return;
          setHotkeys(settings.hotkeys);
          setClaudeDescribes(settings.ai?.enabled === true && aiProvider(settings.ai) === "claudeCode");
        })
        .catch(() => {
          // The tips still read well without the hotkeys.
        });
    void load();
    // Grab-it may turn on describing with Claude Code just after this opens;
    // the queue's first status says so.
    onAiStatus(() => void load())
      .then((stop) => {
        if (cancelled) stop?.();
        else unlisten = stop;
      })
      .catch(() => {
        // Then the tip shows the next time this opens.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function open(target: string) {
    setError(null);
    openTarget(target).catch((err: unknown) => setError(typeof err === "string" ? err : "Something went wrong."));
  }

  const tips = claudeDescribes ? [...TIPS, CLAUDE_TIP] : TIPS;
  return (
    <main className={onClose ? "welcome in-dialog" : "window welcome"}>
      <header className="welcome-head">
        <span className="mark" aria-hidden="true">
          <Logo size={24} />
        </span>
        <div>
          <h1>Welcome to Grab-it</h1>
          <p className="welcome-lead">
            Click the Grab-it icon in the menu bar, or use a hotkey. Every capture is saved, copied and searchable
            here.
          </p>
        </div>
      </header>

      <div className="welcome-cols">
        <section aria-labelledby="welcome-shortcuts">
          <h2 className="welcome-sec" id="welcome-shortcuts">
            Hotkeys
          </h2>
          <ul className="welcome-list">
            {SHORTCUTS.map(({ key, title, detail, icon }) => (
              <li className="welcome-row" key={key}>
                {icon}
                <span className="welcome-text">
                  <span className="welcome-title">{title}</span>
                  <span className="welcome-detail">{detail}</span>
                </span>
                <span className="keys" aria-label={hotkeys?.[key] ?? undefined}>
                  {keyCaps(hotkeys?.[key] ?? "").map((part) => (
                    <kbd key={part}>{part}</kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="welcome-tips">
          <h2 className="welcome-sec" id="welcome-tips">
            Worth knowing
          </h2>
          <ul className="welcome-list">
            {tips.map(({ title, detail }) => (
              <li className="welcome-row" key={title}>
                {TIP_ICONS[title]}
                <span className="welcome-text">
                  <span className="welcome-title">{title}</span>
                  <span className="welcome-detail">{detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {error && (
        <p className="status status-error" role="status">
          {error}
        </p>
      )}

      <footer className="dialog-foot welcome-foot">
        <button type="button" className="link-button dialog-foot-note" onClick={() => open("settings")}>
          Open Settings
        </button>
        <button type="button" className="btn" onClick={() => open("region")}>
          Capture a region now
        </button>
        {onClose ? (
          <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
            Get started
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => open("library")}>
            Open the Library
          </button>
        )}
      </footer>
    </main>
  );
}

export default WelcomeWindow;
