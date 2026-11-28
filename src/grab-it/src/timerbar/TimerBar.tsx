import { useEffect, useLayoutEffect, useState, type MouseEvent } from "react";
import "./timerbar.css";
import { CloseIcon } from "../app/icons";
import { CountdownRing, Rolling } from "../recordbar/countdown";
import { isBareKey, useCountdownTotal } from "../recordbar/countdownState";
import { cancelTimer, endsFromHash, secondsLeft, startTimerNow } from "./api";

/** How often the count is redrawn, in ms. */
const TICK_MS = 250;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A click on a bar button leaves the focus where it was, as the capture toolbar's do. */
function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

/**
 * The pill shown while a timed capture waits (src-tauri/src/timer_bar.rs),
 * like the recording toolbar's countdown in blue: a ring that empties each
 * second, the seconds left, Start now to capture at once and Cancel to stop
 * the capture from starting.
 */
function TimerBar() {
  const [ends] = useState(() => endsFromHash(window.location.hash));
  const [now, setNow] = useState(() => Date.now());
  const [ending, setEnding] = useState(false);
  const left = secondsLeft(ends, now);
  const total = useCountdownTotal(ends, left);

  // The window is see-through: only the pill may paint.
  useLayoutEffect(() => {
    document.documentElement.classList.add("timerbar-clear");
    return () => document.documentElement.classList.remove("timerbar-clear");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  function end(action: () => Promise<void>) {
    if (ending) return;
    // Once: the pill closes as the countdown ends.
    setEnding(true);
    action().catch((err: unknown) => {
      console.error(`Grab-it: ${errorText(err)}`);
      setEnding(false);
    });
  }

  // Enter starts now and Esc cancels, on a pill that has the focus.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isBareKey(event)) return;
      if (event.key === "Enter") end(startTimerNow);
      else if (event.key === "Escape") end(cancelTimer);
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <main className="timerbar">
      <div className="bar-pill timerbar-pill">
        <CountdownRing left={left} total={total} tone="capture" />
        <span className="bar-strong">Capturing in</span>
        <Rolling value={left} label="Seconds left" />
        <span className="timerbar-gap" aria-hidden="true" />
        <button
          type="button"
          className="bar-main"
          title="Skip the timer and capture now"
          aria-keyshortcuts="Enter"
          disabled={ending}
          onMouseDown={keepFocus}
          onClick={() => end(startTimerNow)}
        >
          Start now
          <kbd aria-hidden="true">↵</kbd>
        </button>
        <button
          type="button"
          className="bar-tool timerbar-cancel"
          aria-label="Cancel"
          title="Cancel the capture"
          aria-keyshortcuts="Escape"
          disabled={ending}
          onMouseDown={keepFocus}
          onClick={() => end(cancelTimer)}
        >
          <CloseIcon size={16} />
        </button>
      </div>
    </main>
  );
}

export default TimerBar;
