import { useEffect, useState } from "react";
import AiSection from "./AiSection";
import HotkeysSection from "./HotkeysSection";
import { FolderIcon } from "../app/icons";
import {
  AFTER_CAPTURE_CHOICES,
  DEFAULT_AI_PREFERENCES,
  DEFAULT_APPEARANCE,
  POPUP_CORNERS,
  POPUP_SECONDS,
  TEXT_SIZES,
  setAppearance,
  type Appearance,
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

  async function changeAppearance(change: Partial<Appearance>) {
    setBusy(true);
    try {
      setSettings(await setAppearance({ ...(settings?.appearance ?? DEFAULT_APPEARANCE), ...change }));
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

  const afterCapture = AFTER_CAPTURE_CHOICES.find((choice) => choice.value === settings?.afterCapture);
  const savesAtOnce =
    section === undefined || section === "general" || section === "appearance" || section === "capture" || section === "editor";
  const appearance = settings?.appearance ?? DEFAULT_APPEARANCE;
  const appearanceOff = busy || settings === null;
  const showsMac = shows("general") && (hasDock() || autostart !== null);

  return (
    <main className={section === undefined ? "window settings" : "window settings settings-page"}>
      <h1 className="settings-title">{title}</h1>
      <p className="settings-lead">
        {savesAtOnce ? "Changes save as you make them." : section === "hotkeys" ? "Press Save to use new hotkeys." : "Switches save at once; endpoint details save with Save."}
      </p>
      {showsMac && (
        <section aria-labelledby="mac-heading">
          <h2 className="group-heading" id="mac-heading">
            Grab-it on your Mac
          </h2>
          <div className="group">
            {hasDock() && (
              <label className="row">
                <span className="row-text">
                  <span className="row-title">Show Grab-it in the Dock</span>
                  <span className="row-hint">Click the Dock icon to open this window. Off, Grab-it lives in the menu bar only.</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={settings?.showInDock ?? true}
                  disabled={busy || settings === null}
                  onChange={(event) => void changeShowInDock(event.target.checked)}
                />
              </label>
            )}
            {autostart !== null && (
              <label className="row">
                <span className="row-text">
                  <span className="row-title">Start Grab-it when you sign in</span>
                  <span className="row-hint">It waits in the menu bar or tray, ready for your hotkeys.</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={autostart}
                  disabled={busy}
                  onChange={(event) => void changeAutostart(event.target.checked)}
                />
              </label>
            )}
          </div>
        </section>
      )}
      {shows("capture") && (
        <section aria-labelledby="after-capture-heading">
          <h2 className="group-heading" id="after-capture-heading">
            When a capture is done
          </h2>
          <div className="group">
            <div className="row is-stacked">
              <fieldset className="segmented" aria-labelledby="after-capture-heading" disabled={busy || settings === null}>
                {AFTER_CAPTURE_CHOICES.map((choice) => (
                  <label key={choice.value}>
                    <input
                      type="radio"
                      name="after-capture"
                      value={choice.value}
                      checked={settings?.afterCapture === choice.value}
                      onChange={() => void changePreferences({ afterCapture: choice.value })}
                    />
                    {choice.title}
                  </label>
                ))}
              </fieldset>
              {afterCapture && <span className="row-hint">{afterCapture.hint}</span>}
            </div>
            <label className="row">
              <span className="row-text">
                <span className="row-title">Copy every capture to the clipboard</span>
                <span className="row-hint">Paste it straight into a chat, a document or an issue.</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={settings?.copyToClipboard ?? true}
                disabled={busy || settings === null}
                onChange={(event) => void changePreferences({ copyToClipboard: event.target.checked })}
              />
            </label>
          </div>
        </section>
      )}
      {shows("editor") && (
        <section aria-labelledby="editor-heading">
          <h2 className="group-heading" id="editor-heading">
            New captures
          </h2>
          <div className="group">
            <label className="row">
              <span className="row-text">
                <span className="row-title">Frame new captures with the last backdrop</span>
                <span className="row-hint">
                  The editor adds it when it first opens a capture. The saved capture and its clipboard copy stay unframed.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={settings?.editor?.autoBackdrop ?? false}
                disabled={busy || settings === null}
                onChange={(event) => void changeAutoBackdrop(event.target.checked)}
              />
            </label>
          </div>
        </section>
      )}
      {shows("appearance") && (
        <section aria-labelledby="text-size-heading">
          <h2 className="group-heading" id="text-size-heading">
            Text size
          </h2>
          <div className="group">
            <div className="row is-stacked">
              <fieldset className="segmented" aria-labelledby="text-size-heading" disabled={appearanceOff}>
                {TEXT_SIZES.map((choice) => (
                  <label key={choice.value}>
                    <input
                      type="radio"
                      name="text-size"
                      value={choice.value}
                      checked={appearance.textSize === choice.value}
                      onChange={() => void changeAppearance({ textSize: choice.value })}
                    />
                    {choice.title}
                  </label>
                ))}
              </fieldset>
              <span className="row-hint">Scales the Grab-it window: text, buttons and thumbnails.</span>
            </div>
          </div>

          <h2 className="group-heading" id="popup-heading">
            Popup after a capture
          </h2>
          <div className="group">
            <div className="row is-stacked">
              <span className="row-text">
                <span className="row-title" id="popup-corner-heading">
                  Position
                </span>
                <span className="row-hint">Which corner of the screen the popup appears in.</span>
              </span>
              <fieldset className="corner-picker" aria-labelledby="popup-corner-heading" disabled={appearanceOff}>
                {POPUP_CORNERS.map((choice) => (
                  <label key={choice.value} className={`corner-${choice.value}`}>
                    <input
                      type="radio"
                      name="popup-corner"
                      value={choice.value}
                      checked={appearance.popupCorner === choice.value}
                      onChange={() => void changeAppearance({ popupCorner: choice.value })}
                    />
                    <span className="corner-card" aria-hidden="true" />
                    {choice.title}
                  </label>
                ))}
              </fieldset>
            </div>
            <div className="row">
              <span className="row-text">
                <label className="row-title" htmlFor="popup-seconds">
                  Show it for
                </label>
                <span className="row-hint">Resting the pointer on it keeps it open. Errors stay at least 10 seconds.</span>
              </span>
              <select
                id="popup-seconds"
                className="row-field"
                value={appearance.popupSeconds}
                disabled={appearanceOff}
                onChange={(event) => void changeAppearance({ popupSeconds: Number(event.target.value) })}
              >
                {POPUP_SECONDS.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds === 0 ? "Until I close it" : `${seconds} seconds`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      )}
      {shows("general") && (
        <section>
          <h2 className="group-heading">
            <label htmlFor="save-folder">Save folder</label>
          </h2>
          <div className="group">
            <div className="row">
              <span className="icon-chip tint-blue" aria-hidden="true">
                <FolderIcon size={14} />
              </span>
              <span className="row-text">
                <input
                  id="save-folder"
                  className="mono-value"
                  type="text"
                  readOnly
                  value={settings?.saveFolder ?? ""}
                  placeholder={settings ? "" : "Loading…"}
                  aria-describedby="save-folder-hint"
                />
                <span className="row-hint" id="save-folder-hint">
                  New captures are saved here. Earlier captures stay where they are and stay in your library.
                </span>
              </span>
              <button type="button" className="pill" onClick={changeFolder} disabled={busy || settings === null}>
                Change…
              </button>
            </div>
          </div>
        </section>
      )}
      {shows("ai") && settings && (
        <AiSection saved={settings.ai ?? DEFAULT_AI_PREFERENCES} disabled={busy} onSave={saveAi} />
      )}
      {shows("hotkeys") && settings && (
        <HotkeysSection saved={settings.hotkeys} disabled={busy} onSave={saveHotkeys} />
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
