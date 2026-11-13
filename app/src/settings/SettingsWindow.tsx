import { useEffect, useState } from "react";
import { chooseFolder, getSettings, setSaveFolder, type Settings } from "./api";

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

type Status = { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string };

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

  return (
    <main className="window">
      <h1>Settings</h1>
      <section className="field">
        <label htmlFor="save-folder">Save folder</label>
        <div className="field-row">
          <input
            id="save-folder"
            type="text"
            readOnly
            value={settings?.saveFolder ?? ""}
            placeholder={settings ? "" : "Loading…"}
          />
          <button type="button" onClick={changeFolder} disabled={busy || settings === null}>
            Change…
          </button>
        </div>
        <p className="hint">
          New captures are saved here. Earlier captures stay where they are and stay in your
          library.
        </p>
      </section>
      <p className={`status status-${status.kind}`} role="status">
        {status.kind === "saved" && "Save folder updated."}
        {status.kind === "error" && status.message}
      </p>
    </main>
  );
}

export default SettingsWindow;
