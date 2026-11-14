import { useEffect, useState } from "react";
import AiSection from "./AiSection";
import HotkeysSection from "./HotkeysSection";
import {
  AFTER_CAPTURE_CHOICES,
  DEFAULT_AI_PREFERENCES,
  chooseFolder,
  getAutostart,
  getSettings,
  hasDock,
  SETTINGS_SECTIONS,
  setAutoBackdrop,
  setAutostart,
  setHotkeys,
  setPreferences,
  setSaveFolder,
  setShowInDock,
  type AiPreferences,
  type Hotkeys,
  type HotkeysUpdate,
  type Preferences,
  type Settings,
  type SettingsSection,
} from "./api";

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

type Status =
  | { kind: "idle" }
  | { kind: "saved" }
  | { kind: "preferences-saved" }
  | { kind: "hotkeys-saved"; warnings: string[] }
  | { kind: "error"; message: string };

interface SettingsWindowProps {
  /** One page of Settings, as the Grab-it window shows it; all of them without. */
  section?: SettingsSection;
}

function SettingsWindow({ section }: SettingsWindowProps = {}) {
  const shows = (page: SettingsSection) => section === undefined || section === page;
  const title = section === undefined ? "Settings" : SETTINGS_SECTIONS.find((page) => page.id === section)?.title;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  // Null until the system has answered, or when it cannot say: the toggle
  // is then left out rather than shown in a state that may be wrong.
  const [autostart, setAutostartState] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAutostart()
      .then((enabled) => {
        if (!cancelled && typeof enabled === "boolean") setAutostartState(enabled);
      })
      .catch(() => {
        // No start-up support here; Settings works without the toggle.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatus({ kind: "error", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function changeFolder() {
    setBusy(true);
    try {
      const picked = await chooseFolder(settings?.saveFolder);
      if (picked === null) return;
      setSettings(await setSaveFolder(picked));
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  /** Saves one changed preference at once; there is no Save button for these. */
  async function changePreferences(change: Partial<Preferences>): Promise<boolean> {
    if (!settings) return false;
    const next: Preferences = {
      afterCapture: settings.afterCapture,
      copyToClipboard: settings.copyToClipboard,
      ai: settings.ai ?? DEFAULT_AI_PREFERENCES,
      ...change,
    };
    setBusy(true);
    try {
      setSettings(await setPreferences(next));
      setStatus({ kind: "preferences-saved" });
      return true;
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const saveAi = (ai: AiPreferences) => changePreferences({ ai });

  async function changeAutoBackdrop(enabled: boolean) {
    setBusy(true);
    try {
      setSettings(await setAutoBackdrop(enabled));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeAutostart(enabled: boolean) {
    setBusy(true);
    try {
      setAutostartState(await setAutostart(enabled));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function changeShowInDock(enabled: boolean) {
    setBusy(true);
    try {
      setSettings(await setShowInDock(enabled));
      setStatus({ kind: "preferences-saved" });
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function saveHotkeys(hotkeys: Hotkeys): Promise<HotkeysUpdate | null> {
    try {
      const update = await setHotkeys(hotkeys);
      setSettings(update.settings);
      setStatus({ kind: "hotkeys-saved", warnings: update.warnings });
      return update;
    } catch (err) {
      setStatus({ kind: "error", message: errorMessage(err) });
      return null;
    }
  }

  return (
    <main className={section === undefined ? "window" : "window settings-page"}>
      <h1>{title}</h1>
      {shows("general") && hasDock() && (
        <section className="card" aria-labelledby="dock-heading">
          <h2 id="dock-heading">Where Grab-it lives</h2>
          <label className="toggle first">
            <input
              type="checkbox"
              checked={settings?.showInDock ?? true}
              disabled={busy || settings === null}
              onChange={(event) => void changeShowInDock(event.target.checked)}
            />
            <span>
              <span className="choice-title">Show Grab-it in the Dock</span>
              <span className="hint">Click the Dock icon to open this window. Off, Grab-it lives in the menu bar only.</span>
            </span>
          </label>
        </section>
      )}
      {shows("capture") && (
        <section className="card" aria-labelledby="after-capture-heading">
          <h2 id="after-capture-heading">After a capture</h2>
          <fieldset className="choices" disabled={busy || settings === null}>
            {AFTER_CAPTURE_CHOICES.map((choice) => (
              <label className="choice" key={choice.value}>
                <input
                  type="radio"
                  name="after-capture"
                  value={choice.value}
                  checked={settings?.afterCapture === choice.value}
                  onChange={() => void changePreferences({ afterCapture: choice.value })}
                />
                <span>
                  <span className="choice-title">{choice.title}</span>
                  <span className="hint">{choice.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings?.copyToClipboard ?? true}
              disabled={busy || settings === null}
              onChange={(event) => void changePreferences({ copyToClipboard: event.target.checked })}
            />
            <span>
              <span className="choice-title">Copy every capture to the clipboard</span>
              <span className="hint">Paste it straight into a chat, a document or an issue.</span>
            </span>
          </label>
        </section>
      )}
      {shows("editor") && (
        <section className="card" aria-labelledby="editor-heading">
          <h2 id="editor-heading">Editor</h2>
          <label className="toggle first">
            <input
              type="checkbox"
              checked={settings?.editor?.autoBackdrop ?? false}
              disabled={busy || settings === null}
              onChange={(event) => void changeAutoBackdrop(event.target.checked)}
            />
            <span>
              <span className="choice-title">Frame new captures with the last backdrop</span>
              <span className="hint">
                The editor adds it when it first opens a capture. The saved capture and its clipboard copy stay unframed.
              </span>
            </span>
          </label>
        </section>
      )}
      {shows("general") && (
        <section className="card field">
          <h2>
            <label htmlFor="save-folder">Save folder</label>
          </h2>
          <div className="field-row">
            <input
              id="save-folder"
              type="text"
              readOnly
              value={settings?.saveFolder ?? ""}
              placeholder={settings ? "" : "Loading…"}
            />
            <button type="button" className="secondary" onClick={changeFolder} disabled={busy || settings === null}>
              Change…
            </button>
          </div>
          <p className="hint">
            New captures are saved here. Earlier captures stay where they are and stay in your
            library.
          </p>
        </section>
      )}
      {shows("general") && autostart !== null && (
        <section className="card" aria-labelledby="startup-heading">
          <h2 id="startup-heading">Start-up</h2>
          <label className="toggle first">
            <input
              type="checkbox"
              checked={autostart}
              disabled={busy}
              onChange={(event) => void changeAutostart(event.target.checked)}
            />
            <span>
              <span className="choice-title">Start Grab-it when you sign in</span>
              <span className="hint">It waits in the menu bar or tray, ready for your hotkeys.</span>
            </span>
          </label>
        </section>
      )}
      {shows("ai") && settings && (
        <div className="card">
          <AiSection saved={settings.ai ?? DEFAULT_AI_PREFERENCES} disabled={busy} onSave={saveAi} />
        </div>
      )}
      {shows("hotkeys") && settings && (
        <div className="card">
          <HotkeysSection saved={settings.hotkeys} disabled={busy} onSave={saveHotkeys} />
        </div>
      )}
      <p className={`status status-${status.kind === "preferences-saved" ? "saved" : status.kind}`} role="status">
        {status.kind === "saved" && "Save folder updated."}
        {status.kind === "preferences-saved" && "Saved."}
        {status.kind === "hotkeys-saved" &&
          (status.warnings.length > 0 ? status.warnings.join(" ") : "Hotkeys updated.")}
        {status.kind === "error" && status.message}
      </p>
    </main>
  );
}

export default SettingsWindow;
