import { useEffect, useRef, useState, type ReactNode } from "react";
import "./welcome.css";
import Logo from "../app/Logo";
import {
  AllInOneIcon,
  CardIcon,
  ColourIcon,
  GridIcon,
  PenIcon,
  PinIcon,
  RecordIcon,
  RegionIcon,
  ScreenIcon,
  ScrollIcon,
  SearchIcon,
  SparkleIcon,
  StepsIcon,
  TextIcon,
  WindowIcon,
} from "../app/icons";
import { useEffectiveHotkeys } from "../app/useEffectiveHotkeys";
import { keyCaps } from "../hub/keys";
import { onAiStatus } from "../library/api";
import { aiDescribes, aiProvider, getSettings, type Hotkeys } from "../settings/api";
import { openTarget } from "./api";
import { startCapture, type CaptureKind } from "../app/api";
import PermissionsPage from "./PermissionsPage";
import {
  finishPermissions,
  permissionsMissing,
  permissionStatus,
  primeScreenCapture,
  type PermissionStatus,
} from "./permissions";

/** The hotkeys in the order they are listed, with what each one does. */
const SHORTCUTS: { key: keyof Hotkeys; title: string; detail: string; icon: ReactNode; start?: CaptureKind }[] = [
  { key: "allInOne", title: "Capture & record…", detail: "Press again to close the chooser or stop a recording. On Wayland, cancel in the desktop picker. Recording is unavailable there.", icon: <AllInOneIcon /> },
  { key: "region", title: "Capture a region", detail: "Drag an area, or click a window.", icon: <RegionIcon /> },
  { key: "window", title: "Capture a window", detail: "Hover a window and click it.", icon: <WindowIcon /> },
  { key: "screen", title: "Capture the screen", detail: "Every monitor at once.", icon: <ScreenIcon /> },
  { key: "text", title: "Capture text", detail: "Drag over text to copy it.", icon: <TextIcon /> },
  { key: "colour", title: "Pick a colour", detail: "Click a pixel to copy its hex code.", icon: <ColourIcon /> },
  { key: "library", title: "Open the library", detail: "Every capture, searchable, from anywhere.", icon: <GridIcon /> },
  { key: "steps", title: "Step capture", detail: "Each click becomes a numbered step in a guide. Press again to stop.", icon: <StepsIcon /> },
  { key: "scroll", title: "Scrolling capture", detail: "Choose a window or area. Grab-it scrolls down from what's on screen and joins it into one long image. No hotkey until you set one in Settings. Unavailable on Wayland.", icon: <ScrollIcon />, start: "scroll" },
];

const TIP_ICONS: Record<string, ReactNode> = {
  "Quick Access": <CardIcon />,
  Annotate: <PenIcon />,
  Pin: <PinIcon />,
  Record: <RecordIcon />,
  Library: <SearchIcon />,
  "AI descriptions": <SparkleIcon />,
  "AI integration": <SparkleIcon />,
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
  { title: "Record", detail: "Record a region or a window as an MP4 video or a GIF: click the Grab-it icon, then Record." },
  { title: "Library", detail: "Every capture, searchable by the text inside the image." },
];

/** The last tip while no provider describes captures: AI integration is optional and off. */
const AI_TIP = {
  title: "AI integration",
  detail:
    "Optional and off until you choose a provider in Settings. It describes captures so you can search for what they show, and lets AI agents take screenshots.",
};

/** The last tip while Claude Code describes captures. */
const CLAUDE_TIP = {
  title: "AI descriptions",
  detail:
    "Claude Code describes each new capture, so you can search for what it shows. Change or turn it off in Settings.",
};

type Step = { kind: "loading" } | { kind: "permissions"; status: PermissionStatus } | { kind: "hotkeys" };

/**
 * Shown on the first launch, and from the tray afterwards: a tray app opens
 * no window of its own, so this says where it lives and how to use it. On
 * macOS, while a permission is missing, it starts on the Permissions page.
 */
function WelcomeWindow({ onClose }: { onClose?: () => void } = {}) {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const main = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    permissionStatus()
      .then((status) => {
        if (cancelled) return;
        if (status && permissionsMissing(status)) {
          setStep({ kind: "permissions", status });
          return;
        }
        // Reopened after Allow all's restart with everything granted:
        // setup is done. One throwaway capture brings up macOS's
        // window-picker alert now, not on the first real capture.
        if (status?.resume) {
          void primeScreenCapture().catch(() => undefined);
          void finishPermissions().catch(() => undefined);
        }
        setStep({ kind: "hotkeys" });
      })
      .catch(() => {
        // Nothing reported is nothing missing.
        if (!cancelled) setStep({ kind: "hotkeys" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The dialog focuses its main button as it opens, before a step shows.
  useEffect(() => {
    if (onClose && step.kind !== "loading") main.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [onClose, step.kind]);

  let page: ReactNode = null;
  if (step.kind === "permissions") {
    page = <PermissionsPage initial={step.status} inDialog={!!onClose} onDone={() => setStep({ kind: "hotkeys" })} />;
  } else if (step.kind === "hotkeys") {
    page = <HotkeysPage onClose={onClose} />;
  }
  return (
    <div ref={main} className="welcome-step">
      {page}
    </div>
  );
}

/** The hotkeys and tips: what Grab-it does and how to reach it. */
function HotkeysPage({ onClose }: { onClose?: () => void }) {
  const hotkeys = useEffectiveHotkeys();
  const [claudeDescribes, setClaudeDescribes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const load = () =>
      getSettings()
        .then((settings) => {
          if (cancelled) return;
          setClaudeDescribes(aiDescribes(settings.ai) && aiProvider(settings.ai) === "claudeCode");
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

  const tips = [...TIPS, claudeDescribes ? CLAUDE_TIP : AI_TIP];
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
            {SHORTCUTS.map(({ key, title, detail, icon, start }) => (
              <li className="welcome-row" key={key}>
                {icon}
                <span className="welcome-text">
                  <span className="welcome-title">{title}</span>
                  <span className="welcome-detail">{detail}</span>
                </span>
                {hotkeys && !hotkeys[key] && start ? (
                  <span className="welcome-none">No hotkey</span>
                ) : (
                  <span className="keys" aria-label={hotkeys?.[key] ?? undefined}>
                    {keyCaps(hotkeys?.[key] ?? "").map((part) => (
                      <kbd key={part}>{part}</kbd>
                    ))}
                  </span>
                )}
                {start && (
                  <button type="button" className="welcome-start" aria-label={`Start ${title}`} onClick={() => void startCapture(start).catch(() => {})}>
                    Start
                  </button>
                )}
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
