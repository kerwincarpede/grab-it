import { useEffect, useState } from "react";
import "./printScreenNotice.css";
import { fixPrintScreen, openPrintScreenSettings, printScreenConflict } from "./api";
import { CloseIcon } from "./icons";

interface PrintScreenNoticeProps {
  /** Checks again whenever this changes, such as after hotkeys are saved. */
  recheck?: unknown;
  /** Shows a button that hides the notice until the page opens again. */
  dismissable?: boolean;
  /** Where another hotkey can be chosen, ending the sentence: "in Settings", or "below" in Settings. */
  hotkeysPlace?: string;
}

function message(err: unknown): string {
  return typeof err === "string" ? err : "Something went wrong.";
}

/**
 * Shown on Windows while its "Use the Print screen key to open screen
 * capture" setting is on and a Grab-it hotkey is a bare PrintScreen, so
 * PrintScreen switches between Windows' screen capture and Grab-it. One
 * button turns the setting off; the other opens Windows Settings.
 * Elsewhere the check always says no, and nothing shows.
 */
function PrintScreenNotice({ recheck, dismissable = false, hotkeysPlace = "in Settings" }: PrintScreenNoticeProps) {
  const [conflict, setConflict] = useState(false);
  const [stillOn, setStillOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    printScreenConflict()
      .then((found) => {
        if (cancelled) return;
        setConflict(found === true);
        if (found !== true) setStillOn(false);
      })
      .catch(() => {
        // Without an answer there is nothing to warn about.
      });
    return () => {
      cancelled = true;
    };
  }, [recheck]);

  async function fix() {
    setBusy(true);
    setError(null);
    try {
      const still = await fixPrintScreen();
      setConflict(still);
      setStillOn(still);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function openSettings() {
    setError(null);
    try {
      await openPrintScreenSettings();
      setConflict((await printScreenConflict()) === true);
    } catch (err) {
      setError(message(err));
    }
  }

  if (!conflict || dismissed) return null;
  return (
    <section className="printscreen-notice" aria-labelledby="printscreen-notice-title">
      <div className="printscreen-notice-head">
        <h3 className="printscreen-notice-title" id="printscreen-notice-title">
          PrintScreen also opens Windows&apos; screen capture
        </h3>
        {dismissable && (
          <button
            type="button"
            className="printscreen-notice-dismiss"
            aria-label="Dismiss PrintScreen notice"
            onClick={() => setDismissed(true)}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
      <p>
        Windows&apos; Use the Print screen key to open screen capture setting is on, so PrintScreen switches between
        Windows&apos; tool and Grab-it. Turn it off to make PrintScreen open Grab-it, or choose another hotkey instead of
        PrintScreen {hotkeysPlace}.
      </p>
      {stillOn && (
        <p className="printscreen-notice-still" role="status">
          Windows still has the setting on. Click Open Windows settings and turn off Use the Print screen key to open
          screen capture.
        </p>
      )}
      {error && (
        <p className="status-error" role="status">
          {error}
        </p>
      )}
      <div className="printscreen-notice-actions">
        <button type="button" className="btn btn-small btn-primary" onClick={() => void fix()} disabled={busy}>
          Use PrintScreen for Grab-it
        </button>
        <button type="button" className="btn btn-small" onClick={() => void openSettings()} disabled={busy}>
          Open Windows settings
        </button>
      </div>
    </section>
  );
}

export default PrintScreenNotice;
