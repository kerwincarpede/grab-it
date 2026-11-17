import { useEffect, useLayoutEffect, useState } from "react";
import "./timerbar.css";
import { cancelTimer, endsFromHash, secondsLeft } from "./api";

/** How often the count is redrawn, in ms. */
const TICK_MS = 250;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The pill shown while a timed capture waits (src-tauri/src/timer_bar.rs):
 * the seconds left and a Cancel that stops the capture from starting.
 */
function TimerBar() {
  const [ends] = useState(() => endsFromHash(window.location.hash));
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);

  // The window is see-through: only the pill may paint.
  useLayoutEffect(() => {
    document.documentElement.classList.add("timerbar-clear");
    return () => document.documentElement.classList.remove("timerbar-clear");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  function cancel() {
    // Once: the pill closes as the countdown stops.
    setCancelling(true);
    cancelTimer().catch((err: unknown) => {
      console.error(`Grab-it: ${errorText(err)}`);
      setCancelling(false);
    });
  }

  return (
    <main className="timerbar">
      <div className="timerbar-pill">
        <span className="timerbar-count" role="timer" aria-label="Seconds left">
          {secondsLeft(ends, now)}
        </span>
        <span className="timerbar-note">Capturing…</span>
        <button type="button" className="timerbar-cancel" title="Cancel the capture" disabled={cancelling} onClick={cancel}>
          Cancel
        </button>
      </div>
    </main>
  );
}

export default TimerBar;
