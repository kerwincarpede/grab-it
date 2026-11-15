import { act, renderHook, waitFor } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { describe, expect, it } from "vitest";
import type { Annotations, Shape } from "./model";
import { addShape } from "./tools";
import { AUTOSAVE_DELAY_MS, useAnnotations } from "./useAnnotations";

const step: Shape = { id: "s1", type: "step", color: "#e5484d", x: 10, y: 10, radius: 16 };
const rect: Shape = { id: "r1", type: "rect", color: "#0090ff", strokeWidth: 4, x: 1, y: 2, width: 30, height: 40 };

/**
 * Mocks the editor commands inside an `editor-1` window; returns every
 * sidecar written. `calls` records each write and window destroy in order.
 */
function mockEditor(annotations: unknown = { version: 1, shapes: [step] }, calls: string[] = []): Annotations[] {
  const saved: Annotations[] = [];
  mockWindows("editor-1");
  mockIPC(
    (cmd, payload) => {
      switch (cmd) {
        case "editor_info":
          return { path: "/p/originals/shot.png", fileName: "shot.png", annotations };
        case "editor_save_annotations":
          saved.push(JSON.parse(JSON.stringify((payload as { annotations: Annotations }).annotations)));
          calls.push("save");
          return null;
        case "plugin:window|destroy":
          calls.push("destroy");
          return null;
        default:
          throw new Error(`unexpected command ${cmd}`);
      }
    },
    { shouldMockEvents: true },
  );
  return saved;
}

const last = <T,>(items: T[]): T | undefined => items[items.length - 1];

async function loaded() {
  const hook = renderHook(() => useAnnotations());
  await waitFor(() => expect(hook.result.current.info).not.toBeNull());
  return hook;
}

describe("useAnnotations", () => {
  it("reloads the saved sidecar without writing it back", async () => {
    const saved = mockEditor();
    const { result } = await loaded();
    expect(result.current.doc.shapes).toEqual([step]);
    expect(result.current.canUndo).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saved).toEqual([]);
  });

  it("starts empty for a capture without a sidecar", async () => {
    mockEditor(null);
    const { result } = await loaded();
    expect(result.current.doc).toEqual({ version: 1, shapes: [], crop: null });
  });

  it("auto-saves edits, undo and redo to the sidecar", async () => {
    const saved = mockEditor();
    const { result } = await loaded();

    act(() => result.current.commit(addShape(result.current.doc, rect)));
    await waitFor(() => expect(last(saved)?.shapes).toEqual([step, rect]));
    expect(last(saved)).toEqual({ version: 1, shapes: [step, rect], crop: null });
    await waitFor(() => expect(result.current.status).toBe("saved"));

    act(() => result.current.undo());
    await waitFor(() => expect(last(saved)?.shapes).toEqual([step]));

    act(() => result.current.redo());
    await waitFor(() => expect(last(saved)?.shapes).toEqual([step, rect]));
  });

  it("debounces a burst of edits into one write", async () => {
    const saved = mockEditor();
    const { result } = await loaded();
    act(() => {
      result.current.commit(addShape(result.current.doc, rect));
    });
    act(() => {
      result.current.commit({ ...result.current.doc, crop: { x: 0, y: 0, width: 20, height: 20 } });
    });
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].crop).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  it("flushes a pending edit when the editor unmounts", async () => {
    const saved = mockEditor();
    const { result, unmount } = await loaded();
    act(() => result.current.commit(addShape(result.current.doc, rect)));
    unmount();
    await waitFor(() => expect(last(saved)?.shapes).toEqual([step, rect]));
  });

  it("writes a pending edit before the window closes", async () => {
    const calls: string[] = [];
    const saved = mockEditor(undefined, calls);
    const { result } = await loaded();
    act(() => result.current.commit(addShape(result.current.doc, rect)));
    // Closed well inside the autosave delay: the close itself must write.
    await act(() => emit("tauri://close-requested"));
    await waitFor(() => expect(calls).toEqual(["save", "destroy"]), { timeout: AUTOSAVE_DELAY_MS / 2 });
    expect(last(saved)).toEqual({ version: 1, shapes: [step, rect], crop: null });
  });

  it("closes at once when nothing is pending", async () => {
    const calls: string[] = [];
    mockEditor(undefined, calls);
    await loaded();
    await act(() => emit("tauri://close-requested"));
    await waitFor(() => expect(calls).toEqual(["destroy"]));
  });

  it("reports a sidecar from a newer version instead of editing it", async () => {
    mockEditor({ version: 9, shapes: [] });
    const { result } = renderHook(() => useAnnotations());
    await waitFor(() => expect(result.current.error).toMatch(/version 9/));
  });
});

describe("useAnnotations before a write", () => {
  it("writes nothing when an edit is undone before the save", async () => {
    const saved = mockEditor();
    const { result, unmount } = await loaded();
    act(() => result.current.commit(addShape(result.current.doc, rect)));
    act(() => result.current.undo());
    await new Promise((resolve) => setTimeout(resolve, 600));
    unmount();
    expect(saved).toEqual([]);
  });
});
