import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import "./recordframe.css";
import { barStatus, countdownLeft, onBarStatus, type BarStatus } from "../recordbar/api";
import { frameOptions, type FrameOptions } from "./api";

/** How often the countdown is read again, in ms. */
const TICK_MS = 100;
/** How thick the corner brackets are, in CSS px. Matches `.recordframe-corner`. */
const BRACKET = 3;
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the backend says the recording is doing, kept up to date while `listening`. */
function useBarStatus(listening: boolean): BarStatus | null {
  const [status, setStatus] = useState<BarStatus | null>(null);
  useEffect(() => {
    if (!listening) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onBarStatus((next) => {
      if (!cancelled) setStatus(next);
    })
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        // Read after subscribing, so a change in between is not missed.
        return barStatus().then((loaded) => {
          if (!cancelled && loaded) setStatus(loaded);
        });
      })
      .catch((err: unknown) => console.error(`Grab-it: ${errorText(err)}`));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [listening]);
  return status;
}

/** The time now, ticking while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

interface RecordFrameProps {
  options?: FrameOptions;
  /** Shown as given, for tests; otherwise read from the backend. */
  status?: BarStatus | null;
}

/**
 * The recorded-area outline: a see-through, click-through window around
 * what is recorded, with a thin dashed red edge and solid corner brackets
 * drawn in the margin just outside the area, so they never land in the
 * video. A window's area is rounded where the window is left out of the
 * recording, and square elsewhere, as a rounded edge bends into the area;
 * a whole display gets brackets in its
 * corners only. Before the first frame, the countdown's big number sits in
 * the middle (see src-tauri/src/record_frame.rs).
 */
function RecordFrame({ options = frameOptions(window.location.hash), status: given }: RecordFrameProps) {
  const live = useBarStatus(given === undefined);
  const status = given === undefined ? live : given;
  const { shape, margin } = options;
  // The number goes as the countdown ends, before the first frame is grabbed.
  const endsAt = status?.phase === "countdown" ? status.countdownEndsAt : null;
  const now = useNow(endsAt !== null);
  const count = status && endsAt !== null && now < endsAt ? countdownLeft(status, now) : null;
  // A display's brackets sit on the area itself: where the window is
  // recorded, they show only until the recording starts.
  const brackets = shape !== "screen" || options.protected || count !== null;
  // A rounded edge bends inside the area's corner, so only a window left out
  // of the recording may have one.
  const rounded = shape === "window" && options.protected;

  // The window is see-through: only the outline and the number may paint.
  useLayoutEffect(() => {
    document.documentElement.classList.add("recordframe-clear");
    return () => document.documentElement.classList.remove("recordframe-clear");
  }, []);

  const style = {
    "--rf-margin": `${margin}px`,
    "--rf-bracket-at": `${shape === "screen" ? 0 : Math.max(0, margin - BRACKET)}px`,
  } as CSSProperties;
  return (
    <main className="recordframe" data-testid="recordframe" data-shape={shape}
      data-rounded={rounded ? "true" : "false"}
      style={style} aria-hidden="true">
      {shape !== "screen" && <div className="recordframe-edge" data-testid="recordframe-edge" />}
      {brackets &&
        CORNERS.map((corner) => <div key={corner} className="recordframe-corner" data-corner={corner} data-testid="recordframe-corner" />)}
      {count !== null && (
        <div className="recordframe-count" data-testid="recordframe-count">
          {count}
        </div>
      )}
    </main>
  );
}

export default RecordFrame;
