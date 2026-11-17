import type { Annotations } from "./model";

/** Undo/redo over whole documents; each edit commits one entry. */
export interface History<Doc = Annotations> {
  past: Doc[];
  present: Doc;
  future: Doc[];
}

export const HISTORY_LIMIT = 200;

export function initHistory<Doc>(doc: Doc): History<Doc> {
  return { past: [], present: doc, future: [] };
}

export function commit<Doc>(history: History<Doc>, doc: Doc): History<Doc> {
  if (doc === history.present) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: doc,
    future: [],
  };
}

export function undo<Doc>(history: History<Doc>): History<Doc> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo<Doc>(history: History<Doc>): History<Doc> {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return { past: [...history.past, history.present], present: next, future: rest };
}

export const canUndo = <Doc>(history: History<Doc>) => history.past.length > 0;
export const canRedo = <Doc>(history: History<Doc>) => history.future.length > 0;
