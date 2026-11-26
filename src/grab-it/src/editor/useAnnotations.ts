import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { editorInfo, saveAnnotations, type EditorInfo } from "./api";
import { canRedo, canUndo, commit, initHistory, redo, undo, type History } from "./history";
import { emptyAnnotations, type Annotations } from "./model";
import { parseAnnotations, serializeAnnotations } from "./sidecar";

/** Wait this long after the last edit before writing the sidecar. */
export const AUTOSAVE_DELAY_MS = 400;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

type Action =
  | { type: "load"; doc: Annotations }
  | { type: "commit"; doc: Annotations }
  | { type: "undo" }
  | { type: "redo" };

function reducer(history: History, action: Action): History {
  switch (action.type) {
    case "load":
      return initHistory(action.doc);
    case "commit":
      return commit(history, action.doc);
    case "undo":
      return undo(history);
    case "redo":
      return redo(history);
  }
}

/**
 * Loads the capture's annotations, keeps undo/redo history, and auto-saves
 * the sidecar after each change (debounced). A pending edit is written
 * before the window closes: closing destroys the webview without unmounting
 * React, so the close request waits for the write.
 */
export function useAnnotations() {
  const [history, dispatch] = useReducer(reducer, undefined, () => initHistory(emptyAnnotations()));
  const [info, setInfo] = useState<EditorInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  /** The document the sidecar holds: as loaded, then as last saved. */
  const saved = useRef<Annotations | null>(null);
  const pending = useRef<Annotations | null>(null);
  /** Set while the editor steps to another capture: edits are ignored, so none can land in the next capture's sidecar. */
  const frozen = useRef(false);

  useEffect(() => {
    let cancelled = false;
    editorInfo()
      .then((next) => {
        if (cancelled) return;
        const doc = parseAnnotations(next.annotations);
        saved.current = doc;
        setInfo(next);
        dispatch({ type: "load", doc });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err instanceof Error ? err.message : err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** The latest sidecar write and whether it worked; writes run one after another. */
  const writing = useRef<Promise<boolean>>(Promise.resolve(true));

  /**
   * Writes the pending edit, if any; resolves once every write so far has finished, with
   * whether the last one worked. A failed edit stays pending, so the next flush tries again.
   */
  const flush = useCallback((): Promise<boolean> => {
    const doc = pending.current;
    if (!doc) return writing.current;
    const before = saved.current;
    pending.current = null;
    saved.current = doc;
    setStatus("saving");
    writing.current = writing.current
      .then(() => saveAnnotations(serializeAnnotations(doc)))
      .then(
        () => {
          setStatus((now) => (now === "saving" ? "saved" : now));
          return true;
        },
        () => {
          if (saved.current === doc) saved.current = before;
          pending.current ??= doc;
          setStatus("error");
          return false;
        },
      );
    return writing.current;
  }, []);

  useEffect(() => {
    const doc = history.present;
    // Nothing to save before loading, or when the sidecar already holds it
    // (an edit undone before it was written).
    if (saved.current === null) return;
    if (doc === saved.current) {
      pending.current = null;
      return;
    }
    pending.current = doc;
    const timer = window.setTimeout(flush, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [history.present, flush]);

  useEffect(() => {
    // Tauri holds the close while a close-requested listener runs, then
    // destroys the window once it returns.
    let unlisten: (() => void) | null = null;
    let disposed = false;
    let listening: Promise<() => void>;
    try {
      listening = getCurrentWindow().onCloseRequested(async () => {
        await flush();
      });
    } catch (err) {
      // Outside a Tauri window (no window metadata): nothing to hold.
      listening = Promise.reject(err);
    }
    listening
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    const onPageHide = () => void flush();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      disposed = true;
      // The real unlisten is async; a failure only means the listener is gone.
      Promise.resolve(unlisten?.()).catch(() => undefined);
      window.removeEventListener("pagehide", onPageHide);
      void flush();
    };
  }, [flush]);

  /** Applies an edit, unless the editor is stepping away. */
  const edit = useCallback((action: Action) => {
    if (!frozen.current) dispatch(action);
  }, []);
  const commitDoc = useCallback((doc: Annotations) => edit({ type: "commit", doc }), [edit]);
  /** Starts from `doc` as if it had been loaded (no undo step), and saves it. */
  const adoptDoc = useCallback((doc: Annotations) => edit({ type: "load", doc }), [edit]);
  const undoDoc = useCallback(() => edit({ type: "undo" }), [edit]);
  const redoDoc = useCallback(() => edit({ type: "redo" }), [edit]);
  /**
   * Stops taking edits and writes the pending one; resolves with whether the sidecar holds
   * every edit. Edits stay off until `thaw`, so nothing changes while the editor steps away.
   */
  const freeze = useCallback((): Promise<boolean> => {
    frozen.current = true;
    return flush();
  }, [flush]);
  /** Takes edits again after a step that did not leave this capture. */
  const thaw = useCallback(() => {
    frozen.current = false;
  }, []);

  return {
    info,
    error,
    status,
    doc: history.present,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    commit: commitDoc,
    adopt: adoptDoc,
    undo: undoDoc,
    redo: redoDoc,
    freeze,
    thaw,
  };
}
