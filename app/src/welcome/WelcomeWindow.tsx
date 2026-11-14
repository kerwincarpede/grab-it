import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./welcome.css";
import { acceleratorKeys } from "../settings/accelerator";
import { aiProvider, getSettings, type Hotkeys } from "../settings/api";

/** Opens a window or starts a capture by its `--open` name. */
function openTarget(target: string): Promise<void> {
  return invoke<void>("open_target", { target });
}

/** The hotkeys in the order they are listed, with what each one does. */
const SHORTCUTS: { key: keyof Hotkeys; title: string; detail: string }[] = [
  { key: "region", title: "Capture a region", detail: "Drag an area, or click a window." },
  { key: "window", title: "Capture a window", detail: "Hover a window and click it." },
  { key: "screen", title: "Capture the screen", detail: "Every monitor at once." },
  { key: "text", title: "Capture text", detail: "Drag over text to copy it." },
  { key: "colour", title: "Pick a colour", detail: "Click a pixel to copy its hex code." },
];

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
  { title: "Record", detail: "Record a region or a window as a GIF from the tray menu." },
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
function WelcomeWindow() {
  const [hotkeys, setHotkeys] = useState<Hotkeys | null>(null);
  const [claudeDescribes, setClaudeDescribes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (cancelled) return;
        setHotkeys(settings.hotkeys);
        setClaudeDescribes(settings.ai?.enabled === true && aiProvider(settings.ai) === "claudeCode");
      })
      .catch(() => {
        // The tips still read well without the hotkeys.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function open(target: string) {
    setError(null);
    openTarget(target).catch((err: unknown) => setError(typeof err === "string" ? err : "Something went wrong."));
  }

  return (
    <main className="window welcome">
      <header className="welcome-header">
        <h1>Welcome to Grab-it</h1>
        <p className="welcome-lead">
          Grab-it lives in your system tray. Capture with a hotkey or from the tray menu; everything you capture is
          saved, copied and searchable.
        </p>
      </header>

      {/* Straight under the introduction, so they are in view however short the window is. */}
      <div className="welcome-actions">
        <button type="button" onClick={() => open("region")}>
          Capture a region now
        </button>
        <button type="button" className="secondary" onClick={() => open("settings")}>
          Open Settings
        </button>
        <button type="button" className="secondary" onClick={() => open("library")}>
          Open the Library
        </button>
      </div>
      <p className="status status-error" role="status">
        {error}
      </p>

      <section className="card" aria-labelledby="welcome-shortcuts">
        <h2 id="welcome-shortcuts">Hotkeys</h2>
        <ul className="welcome-shortcuts">
          {SHORTCUTS.map(({ key, title, detail }) => (
            <li key={key}>
              <span>
                <span className="choice-title">{title}</span>
                <span className="hint">{detail}</span>
              </span>
              <span className="welcome-keys" aria-label={hotkeys?.[key] ?? undefined}>
                {acceleratorKeys(hotkeys?.[key] ?? "").map((part) => (
                  <kbd key={part}>{part}</kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="hint">Change them in Settings. Timed captures, Repeat last region and Record GIF are in the tray menu.</p>
      </section>

      <section className="card" aria-labelledby="welcome-tips">
        <h2 id="welcome-tips">Worth knowing</h2>
        <ul className="welcome-tips">
          {(claudeDescribes ? [...TIPS, CLAUDE_TIP] : TIPS).map(({ title, detail }) => (
            <li key={title}>
              <span className="choice-title">{title}</span>
              <span className="hint">{detail}</span>
            </li>
          ))}
        </ul>
      </section>

    </main>
  );
}

export default WelcomeWindow;
