import { useEffect, useLayoutEffect, useState, type MouseEvent } from "react";
import "../recordbar/countdown.css";
import "./scrollbar.css";
import { CloseIcon } from "../app/icons";
import { isBareKey } from "../recordbar/countdownState";
import { cancelScroll, finishScroll, stitchedHeight, onScrollBarState, scrollBarState, type ScrollBarState } from "./api";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the bar says when the capture sends no message of its own. */
function statusOf(state: ScrollBarState): string {
  if (state.saving) return "Saving…";
  if (state.message) return state.message;
  if (state.autoScrolling) return "Hands off the mouse. It stops and saves at the end.";
  return "Scroll at a steady pace. Choose Finish at the end.";
}

/** A click on a bar button leaves the focus where it was, as the capture toolbar's do. */
function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

/**
 * The bar shown while a scrolling capture runs (src-tauri/src/scroll_bar.rs),
 * in the capture toolbar's style: a pulsing blue dot, the stitched height,
 * who is scrolling, Finish and Cancel, over a progress stripe toward the
 * length limit, what to do and a live preview of the newest part. The bar never takes the focus, so Esc reaches Cancel through a
 * global shortcut the capture holds while it runs (src-tauri/src/scroll.rs);
 * the key is also handled here for a bar that has been clicked, as is
 * Enter for Finish.
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

  // Esc and Enter on a bar that has the focus; the global Esc covers the rest.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") end("cancel");
      else if (event.key === "Enter" && isBareKey(event)) end("done");
      else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

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
            <span className="bar-dot" data-tone="capture" data-paused={saving ? "true" : "false"} aria-hidden="true" />
            <span className="bar-strong scrollbar-title">{saving ? "Saving" : "Scrolling"}</span>
            <span className="bar-sep" aria-hidden="true" />
            <span className="scrollbar-length" title={state ? `${state.width} × ${state.height}` : undefined}>
              {state ? stitchedHeight(state.height) : "Starting…"}
            </span>
            {state && !saving && !state.capped && (
              <span className="scrollbar-who" data-who={state.autoScrolling ? "grab-it" : "me"}>
                {state.autoScrolling ? "Grab-it is scrolling" : "You're scrolling"}
              </span>
            )}
            <span className="scrollbar-spacer" />
            <button
              type="button"
              className="bar-main scrollbar-done"
              aria-keyshortcuts="Enter"
              disabled={!state || ending !== null}
              onMouseDown={keepFocus}
              onClick={() => end("done")}
            >
              {saving ? "Saving…" : "Finish"}
              {!saving && <kbd aria-hidden="true">↵</kbd>}
            </button>
            <button
              type="button"
              className="bar-tool scrollbar-cancel"
              aria-label="Cancel"
              title="Cancel (Esc)"
              aria-keyshortcuts="Escape"
              disabled={!state || ending !== null}
              onMouseDown={keepFocus}
              onClick={() => end("cancel")}
            >
              <CloseIcon size={16} />
            </button>
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
      </div>
    </main>
  );
}

export default ScrollBar;
