import type { Annotations } from "./model";

/** Undo/redo over whole documents; each edit commits one entry. */
export interface History {
  past: Annotations[];
  present: Annotations;
  future: Annotations[];
}

export const HISTORY_LIMIT = 200;

export function initHistory(doc: Annotations): History {
  return { past: [], present: doc, future: [] };
}

export function commit(history: History, doc: Annotations): History {
  if (doc === history.present) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: doc,
    future: [],
  };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

export const canUndo = (history: History) => history.past.length > 0;
export const canRedo = (history: History) => history.future.length > 0;
