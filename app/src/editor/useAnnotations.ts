import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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
 * the sidecar after each change (debounced, flushed on unmount).
 */
export function useAnnotations() {
  const [history, dispatch] = useReducer(reducer, undefined, () => initHistory(emptyAnnotations()));
  const [info, setInfo] = useState<EditorInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>("idle");
  /** The document the sidecar holds: as loaded, then as last saved. */
  const saved = useRef<Annotations | null>(null);
  const pending = useRef<Annotations | null>(null);

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

  const flush = useCallback(() => {
    const doc = pending.current;
    if (!doc) return;
    pending.current = null;
    saved.current = doc;
    setStatus("saving");
    saveAnnotations(serializeAnnotations(doc))
      .then(() => setStatus((now) => (now === "saving" ? "saved" : now)))
      .catch(() => setStatus("error"));
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
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  const commitDoc = useCallback((doc: Annotations) => dispatch({ type: "commit", doc }), []);
  const undoDoc = useCallback(() => dispatch({ type: "undo" }), []);
  const redoDoc = useCallback(() => dispatch({ type: "redo" }), []);

  return {
    info,
    error,
    status,
    doc: history.present,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    commit: commitDoc,
    undo: undoDoc,
    redo: redoDoc,
  };
}
