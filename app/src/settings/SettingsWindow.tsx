import { useEffect, useState } from "react";
import HotkeysSection from "./HotkeysSection";
import {
  AFTER_CAPTURE_CHOICES,
  chooseFolder,
  getSettings,
  setHotkeys,
  setPreferences,
  setSaveFolder,
  type Hotkeys,
  type HotkeysUpdate,
  type Preferences,
  type Settings,
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

function SettingsWindow() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

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
  async function changePreferences(change: Partial<Preferences>) {
    if (!settings) return;
    const next: Preferences = {
      afterCapture: settings.afterCapture,
      copyToClipboard: settings.copyToClipboard,
      ...change,
    };
    setBusy(true);
    try {
      setSettings(await setPreferences(next));
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
    <main className="window">
      <h1>Settings</h1>
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
      {settings && (
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
