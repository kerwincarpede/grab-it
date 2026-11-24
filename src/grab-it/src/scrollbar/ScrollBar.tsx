import { useEffect, useLayoutEffect, useState } from "react";
import "./scrollbar.css";
import { cancelScroll, finishScroll, onScrollBarState, scrollBarState, type ScrollBarState } from "./api";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the bar says when the capture sends no message of its own. */
function statusOf(state: ScrollBarState): string {
  if (state.saving) return "Saving…";
  if (state.message) return state.message;
  if (state.autoScrolling) return "Scrolling for you. Leave the mouse and trackpad alone.";
  return "Scroll by hand, then choose Done.";
}

/**
 * The bar shown while a scrolling capture runs (src-tauri/src/scroll_bar.rs):
 * a progress stripe toward the length limit, the length so far, a live
 * preview of the newest part, what to do, Done and Cancel.
 */
function ScrollBar() {
  const [state, setState] = useState<ScrollBarState | null>(null);
  const [ending, setEnding] = useState<"done" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The window is see-through: only the bar may paint.
  useLayoutEffect(() => {
    document.documentElement.classList.add("scrollbar-clear");
    return () => document.documentElement.classList.remove("scrollbar-clear");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onScrollBarState((next) => {
      if (!cancelled) setState(next);
    })
      .then((stop) => {
        if (cancelled) {
          stop();
          return;
        }
        unlisten = stop;
        // Read after subscribing, so a state sent in between is not missed.
        return scrollBarState().then((first) => {
          if (!cancelled && first) setState((current) => current ?? first);
        });
      })
      .catch((err: unknown) => console.error(`Grab-it: ${errorText(err)}`));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function end(kind: "done" | "cancel") {
    if (!state || ending) return;
    setEnding(kind);
    setError(null);
    (kind === "done" ? finishScroll : cancelScroll)(state.sessionId).catch((err: unknown) => {
      setError(errorText(err));
      setEnding(null);
    });
  }

  const saving = state?.saving === true || ending === "done";
  const percent = Math.round(Math.min(Math.max(state?.progress ?? 0, 0), 1) * 100);
  return (
    <main className="scrollbar" data-testid="scrollbar">
      <div className="scrollbar-pill">
        <div className="scrollbar-preview" aria-hidden={state?.preview ? undefined : "true"}>
          {state?.preview && <img src={state.preview} alt="The newest part of the image" />}
        </div>
        <div className="scrollbar-body">
          <div className="scrollbar-head">
            <span className="scrollbar-title">Scrolling capture</span>
            <span className="scrollbar-length">{state ? `${state.width} × ${state.height}` : "Starting…"}</span>
          </div>
          <div
            className="scrollbar-progress"
            role="progressbar"
            aria-label="Length toward the limit"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            data-capped={state?.capped ? "true" : "false"}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <p className="scrollbar-message" role="status">
            {error ?? (state ? statusOf(saving ? { ...state, saving } : state) : "Starting…")}
          </p>
        </div>
        <div className="scrollbar-actions">
          <button type="button" className="scrollbar-done" disabled={!state || ending !== null} onClick={() => end("done")}>
            {saving ? "Saving…" : "Done"}
          </button>
          <button type="button" className="scrollbar-cancel" disabled={!state || ending !== null} onClick={() => end("cancel")}>
            Cancel
          </button>
        </div>
      </div>
    </main>
  );
}

export default ScrollBar;
