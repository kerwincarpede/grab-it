import { describe, expect, it } from "vitest";
import { canRedo, canUndo, commit, HISTORY_LIMIT, initHistory, redo, undo } from "./history";
import { emptyAnnotations, type Annotations } from "./model";
import { addShape } from "./tools";

const withStep = (doc: Annotations, id: string) =>
  addShape(doc, { id, type: "step", color: "red", x: 0, y: 0, radius: 10 });

describe("undo/redo", () => {
  const a = emptyAnnotations();
  const b = withStep(a, "1");
  const c = withStep(b, "2");

  it("undoes and redoes commits in order", () => {
    let history = commit(commit(initHistory(a), b), c);
    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(false);

    history = undo(history);
    expect(history.present).toBe(b);
    history = undo(history);
    expect(history.present).toBe(a);
    expect(canUndo(history)).toBe(false);
    expect(undo(history)).toBe(history);

    history = redo(redo(history));
    expect(history.present).toBe(c);
    expect(redo(history)).toBe(history);
  });

  it("drops the redo branch on a new edit", () => {
    const history = commit(undo(commit(commit(initHistory(a), b), c)), withStep(b, "3"));
    expect(canRedo(history)).toBe(false);
    expect(history.past).toEqual([a, b]);
  });

  it("ignores committing the same document", () => {
    const history = initHistory(a);
    expect(commit(history, a)).toBe(history);
  });

  it("keeps a bounded history", () => {
    let history = initHistory(a);
    for (let i = 0; i < HISTORY_LIMIT + 20; i += 1) history = commit(history, withStep(history.present, String(i)));
    expect(history.past).toHaveLength(HISTORY_LIMIT);
  });
});
