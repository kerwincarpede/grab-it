import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ReactNode, Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EditorWindow from "./EditorWindow";
import type { Annotations } from "./model";
import { AUTOSAVE_DELAY_MS } from "./useAnnotations";

/** Where the mocked stage reports the pointer, in capture pixels. */
const pointerAt = vi.hoisted(() => ({ x: 0, y: 0 }));

// jsdom has no canvas, so Konva nodes render as plain elements that keep
// the props the tests look at.
vi.mock("react-konva", async () => {
  const { createElement, useImperativeHandle, useMemo } = await import("react");
  const node =
    (kind: string) =>
    ({
      children,
      id,
      name,
      text,
      enabledAnchors,
      draggable,
      onMouseDown,
    }: {
      children?: ReactNode;
      id?: string;
      name?: string;
      text?: string;
      enabledAnchors?: string[];
      draggable?: boolean;
      onMouseDown?: () => void;
    }) =>
      // Only annotations (which have ids) take clicks; the Stage's handler
      // needs real Konva events.
      createElement(
        "div",
        {
          "data-konva": kind,
          "data-id": id,
          "data-name": name,
          "data-text": text,
          "data-anchors": enabledAnchors?.join(" "),
          "data-draggable": draggable === undefined ? undefined : String(draggable),
          onMouseDown: id ? () => onMouseDown?.() : undefined,
        },
        children,
      );
  const LayerNode = node("Layer");
  // The editor needs a layer to flatten (flatten itself is mocked below).
  const Layer = ({ ref, ...props }: { ref?: Ref<unknown>; children?: ReactNode; name?: string }) => {
    useImperativeHandle(ref, () => ({ findOne: () => undefined }), []);
    return createElement(LayerNode, props);
  };
  type Handler = ((event: unknown) => void) | undefined;
  // The stage hands its mouse handlers a Konva-like event: the pointer
  // comes from `pointerAt`, and the target is the annotation under the
  // DOM event (its node reports the "annotation" name) or the stage.
  const Stage = ({
    ref,
    children,
    onMouseDown,
    onMouseMove,
    onMouseUp,
  }: {
    ref?: Ref<unknown>;
    children?: ReactNode;
    onMouseDown?: Handler;
    onMouseMove?: Handler;
    onMouseUp?: Handler;
  }) => {
    const stage = useMemo(() => {
      const self: Record<string, unknown> = {
        getRelativePointerPosition: () => ({ ...pointerAt }),
        getPointerPosition: () => ({ ...pointerAt }),
        getStage: () => self,
        getParent: () => null,
        getClassName: () => "Stage",
        hasName: () => false,
        name: () => "",
        draggable: () => false,
      };
      return self;
    }, []);
    useImperativeHandle(ref, () => stage, [stage]);
    const target = (element: EventTarget) => {
      if (!(element instanceof Element) || !element.closest("[data-id]")) return stage;
      return {
        getStage: () => stage,
        getParent: () => null,
        getClassName: () => "Shape",
        hasName: (name: string) => name === "annotation",
        name: () => "annotation",
        draggable: () => true,
      };
    };
    const forward = (handler: Handler) => (event: { nativeEvent: MouseEvent; target: EventTarget }) =>
      handler?.({ evt: event.nativeEvent, target: target(event.target) });
    return createElement(
      "div",
      { "data-konva": "Stage", onMouseDown: forward(onMouseDown), onMouseMove: forward(onMouseMove), onMouseUp: forward(onMouseUp) },
      children,
    );
  };
  return {
    Stage,
    Layer,
    Shape: node("Shape"),
    Label: node("Label"),
    Tag: node("Tag"),
    Group: node("Group"),
    Arrow: node("Arrow"),
    Line: node("Line"),
    Rect: node("Rect"),
    Ellipse: node("Ellipse"),
    Circle: node("Circle"),
    Text: node("Text"),
    Image: node("Image"),
    Transformer: node("Transformer"),
  };
});

const FLATTENED = new Uint8Array([1, 2, 3]);
const flattened = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("./flatten", async (original) => ({
  ...(await original<typeof import("./flatten")>()),
  flatten: async (_layer: unknown, doc: unknown) => {
    flattened.calls.push(doc);
    return new Uint8Array([1, 2, 3]);
  },
}));

class LoadedImage {
  width = 400;
  height = 300;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_url: string) {
    setTimeout(() => this.onload?.());
  }
}

const sidecar: Annotations = {
  version: 1,
  shapes: [
    { id: "a1", type: "arrow", color: "#e5484d", strokeWidth: 4, points: [10, 10, 100, 80] },
    { id: "t1", type: "text", color: "#1f2328", x: 20, y: 200, text: "Click here", fontSize: 24 },
    { id: "s1", type: "step", color: "#e5484d", x: 50, y: 50, radius: 16 },
    { id: "s2", type: "step", color: "#e5484d", x: 90, y: 50, radius: 16 },
  ],
  crop: null,
};

/** Mocks the editor commands; returns every sidecar written. `calls` records output commands in order. */
function mockEditor(annotations: Annotations = sidecar, calls: { cmd: string; payload: unknown }[] = []): Annotations[] {
  const saved: Annotations[] = [];
  mockIPC((cmd, payload) => {
    switch (cmd) {
      case "editor_info":
        return { path: "/p/originals/shot.png", fileName: "shot.png", annotations };
      case "editor_image":
        return new ArrayBuffer(8);
      case "editor_save_annotations":
        saved.push((payload as { annotations: Annotations }).annotations);
        return null;
      case "editor_pin":
      case "editor_copy":
      case "plugin:window|close":
        calls.push({ cmd, payload });
        return null;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return saved;
}

const bytes = (payload: unknown) => Array.from(new Uint8Array(payload as ArrayBuffer));

async function ready() {
  render(<EditorWindow />);
  await waitFor(() => expect(screen.getByTestId("editor")).toHaveAttribute("data-ready", "true"));
}

const last = <T,>(items: T[]): T | undefined => items[items.length - 1];

const anchors = () => document.querySelector('[data-konva="Transformer"]')?.getAttribute("data-anchors")?.split(" ");

const shapeIds = () =>
  Array.from(document.querySelectorAll("[data-konva] [data-id]")).map((element) => element.getAttribute("data-id"));

const stage = () => document.querySelector('[data-konva="Stage"]') as Element;
const pressed = (name: string) =>
  within(screen.getByRole("toolbar", { name: "Annotation tools" })).getByRole("button", { name });

/** Drags across the stage from `from` to `to` (capture pixels) with the given modifier keys. */
function drag(from: [number, number], to: [number, number], keys: { metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) {
  Object.assign(pointerAt, { x: from[0], y: from[1] });
  fireEvent.mouseDown(stage(), keys);
  Object.assign(pointerAt, { x: to[0], y: to[1] });
  fireEvent.mouseMove(stage(), keys);
  fireEvent.mouseUp(stage(), keys);
}

/** Presses and lets go of `key`, holding it for `ms` (Date.now is stubbed). */
function holdKey(key: string, ms: number, during?: () => void) {
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
  fireEvent.keyDown(window, { key });
  during?.();
  now.mockReturnValue(10_000 + ms);
  fireEvent.keyUp(window, { key });
  now.mockRestore();
}

describe("EditorWindow", () => {
  beforeEach(() => {
    flattened.calls = [];
    vi.stubGlobal("Image", LoadedImage);
    URL.createObjectURL = vi.fn(() => "blob:capture");
    URL.revokeObjectURL = vi.fn();
  });

  it("shows the capture with its saved annotations and numbered steps", async () => {
    mockEditor();
    await ready();
    expect(screen.getByText("shot.png")).toBeInTheDocument();
    expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);
    expect(document.querySelector('[data-text="Click here"]')).toBeInTheDocument();
    const badges = Array.from(document.querySelectorAll('[data-konva="Group"] [data-text]')).map((element) =>
      element.getAttribute("data-text"),
    );
    expect(badges).toEqual(["1", "2"]);
  });

  it("offers every tool and switches tools by key", async () => {
    mockEditor();
    await ready();
    const rail = within(screen.getByRole("toolbar", { name: "Annotation tools" }));
    for (const name of ["Arrow", "Rectangle", "Ellipse", "Line", "Freehand", "Text", "Highlighter", "Blur", "Spotlight", "Step", "Crop", "Select", "Pan"]) {
      expect(rail.getByRole("button", { name })).toBeInTheDocument();
    }
    // Icon buttons: the name is the label, the tooltip adds the key.
    expect(rail.getByRole("button", { name: "Spotlight" })).toHaveAttribute("title", "Spotlight (S)");
    expect(rail.getByRole("button", { name: "Spotlight" }).querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Arrow" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "b" });
    expect(screen.getByRole("button", { name: "Blur" })).toHaveAttribute("aria-pressed", "true");
  });

  it("selects, deletes and undoes, saving the sidecar each time", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();

    fireEvent.keyDown(window, { key: "Delete" });
    expect(shapeIds()).toEqual(["t1", "s1", "s2"]);
    await waitFor(() => expect(last(saved)?.shapes.map((shape) => shape.id)).toEqual(["t1", "s1", "s2"]));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);
    await waitFor(() => expect(last(saved)?.shapes.map((shape) => shape.id)).toEqual(["a1", "t1", "s1", "s2"]));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(shapeIds()).toEqual(["t1", "s1", "s2"]);
  });

  it("recolours the selected shape", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);
    fireEvent.click(screen.getByRole("button", { name: "Colour #0090ff" }));
    await waitFor(() => expect(last(saved)?.shapes.find((shape) => shape.id === "t1")).toMatchObject({ color: "#0090ff" }));
  });

  it("drops the selection when a key picks a drawing tool", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();

    fireEvent.keyDown(window, { key: "r" });
    expect(screen.getByRole("button", { name: "Rectangle" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();

    // The new colour is for the next shape, not the arrow selected before.
    fireEvent.click(screen.getByRole("button", { name: "Colour #0090ff" }));
    expect(screen.getByRole("button", { name: "Colour #0090ff" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "Delete" });
    expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    expect(saved).toEqual([]);
  });

  it("keeps the selection when a key picks Select", async () => {
    mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    fireEvent.keyDown(window, { key: "v" });
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("resizes text and step badges from the corners only", async () => {
    mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    expect(anchors()).toContain("middle-left");

    const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);
    expect(anchors()).toEqual(corners);
    fireEvent.mouseDown(document.querySelector('[data-id="s1"]') as Element);
    expect(anchors()).toEqual(corners);
  });

  it("shows the options that fit the active tool", async () => {
    mockEditor();
    await ready();
    expect(screen.queryByRole("button", { name: "Fill" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "r" });
    fireEvent.click(screen.getByRole("button", { name: "Fill" }));
    expect(screen.getByRole("button", { name: "Fill" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(window, { key: "b" });
    expect(screen.queryByRole("button", { name: "Fill" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pixelate" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Smooth" }));
    expect(screen.getByRole("button", { name: "Smooth" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getByRole("button", { name: "Spotlight" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("group", { name: "Blur style" })).not.toBeInTheDocument();
  });

  it("puts a background behind the selected text", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);
    fireEvent.click(screen.getByRole("button", { name: "Text background" }));
    expect(screen.getByRole("button", { name: "Text background" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-konva="Label"][data-id="t1"] [data-text="Click here"]')).toBeInTheDocument();
    await waitFor(() => expect(last(saved)?.shapes.find((shape) => shape.id === "t1")).toMatchObject({ background: true }));
  });

  it("dims the capture around its spotlights", async () => {
    mockEditor({ ...sidecar, shapes: [...sidecar.shapes, { id: "sp", type: "spotlight", x: 10, y: 10, width: 100, height: 80 }] });
    await ready();
    expect(document.querySelectorAll('[data-name="spotlight-dim"]')).toHaveLength(1);
    expect(shapeIds()).toContain("sp");
  });

  it("does not dim a capture without spotlights", async () => {
    mockEditor();
    await ready();
    expect(document.querySelector('[data-name="spotlight-dim"]')).not.toBeInTheDocument();
  });

  it("duplicates and nudges the selected shape from the keyboard", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="s1"]') as Element);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowUp", shiftKey: true });
    await waitFor(() => expect(last(saved)?.shapes.find((shape) => shape.id === "s1")).toMatchObject({ x: 51, y: 40 }));

    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    expect(shapeIds()).toHaveLength(5);
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "step", x: 63, y: 52 }));
    // The copy is selected, so the next key moves it, not the original.
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ y: 53 }));
    expect(last(saved)?.shapes.find((shape) => shape.id === "s1")).toMatchObject({ x: 51, y: 40 });
  });

  it("leaves the arrow keys alone when nothing is selected", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "d", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    expect(saved).toEqual([]);
  });

  it("steps the stroke width with [ and ]", async () => {
    mockEditor();
    await ready();
    expect(screen.getByRole("button", { name: "Width 4px" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "]" });
    expect(screen.getByRole("button", { name: "Width 6px" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.keyDown(window, { key: "[" });
    expect(screen.getByRole("button", { name: "Width 2px" })).toHaveAttribute("aria-pressed", "true");
  });

  it("adds, adjusts and removes a backdrop from its panel", async () => {
    const saved = mockEditor();
    await ready();
    const toggle = screen.getByRole("button", { name: "Backdrop" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const panel = within(screen.getByRole("dialog", { name: "Backdrop" }));
    expect(panel.getByRole("button", { name: "No backdrop" })).toHaveAttribute("aria-pressed", "true");
    expect(panel.getByRole("slider", { name: "Padding" })).toBeDisabled();

    fireEvent.click(panel.getByRole("button", { name: "Sunset gradient" }));
    await waitFor(() => expect(last(saved)?.backdrop).toMatchObject({ fill: "sunset", shadow: true }));
    expect(screen.getByText(/^Output /)).toBeInTheDocument();

    // A drag previews each step and saves once, when the slider is let go.
    const writes = saved.length;
    const padding = panel.getByRole("slider", { name: "Padding" });
    fireEvent.change(padding, { target: { value: "100" } });
    fireEvent.change(padding, { target: { value: "120" } });
    expect(screen.getByText("Output 640×540")).toBeInTheDocument();
    fireEvent.pointerUp(padding);
    fireEvent.blur(padding);
    await waitFor(() => expect(last(saved)?.backdrop).toMatchObject({ fill: "sunset", padding: 120 }));
    expect(saved).toHaveLength(writes + 1);

    fireEvent.click(panel.getByRole("checkbox", { name: "Shadow" }));
    await waitFor(() => expect(last(saved)?.backdrop).toMatchObject({ shadow: false }));

    fireEvent.click(panel.getByRole("button", { name: "No backdrop" }));
    await waitFor(() => expect(last(saved)).not.toHaveProperty("backdrop"));
    expect(screen.queryByText(/^Output /)).not.toBeInTheDocument();

    fireEvent.keyDown(panel.getByRole("button", { name: "No backdrop" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Backdrop" })).not.toBeInTheDocument();
  });

  it("pins the flattened image, backdrop included", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    const backdrop = { fill: "ocean", padding: 40, radius: 8, shadow: true };
    mockEditor({ ...sidecar, backdrop }, calls);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(calls.map((call) => call.cmd)).toEqual(["editor_pin"]));
    expect(bytes(calls[0].payload)).toEqual(Array.from(FLATTENED));
    expect(flattened.calls).toEqual([{ crop: null, backdrop }]);
    expect(await screen.findByText("Pinned on top of other windows.")).toBeInTheDocument();
  });

  it("switches tools for good on a quick tap of a letter", async () => {
    mockEditor();
    await ready();
    holdKey("b", 50);
    expect(pressed("Blur")).toHaveAttribute("aria-pressed", "true");
  });

  it("brings the previous tool back when a held letter is let go", async () => {
    mockEditor();
    await ready();
    holdKey("b", 400);
    expect(pressed("Arrow")).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores key repeats while a letter is held", async () => {
    mockEditor();
    await ready();
    holdKey("b", 400, () => fireEvent.keyDown(window, { key: "b", repeat: true }));
    expect(pressed("Arrow")).toHaveAttribute("aria-pressed", "true");
  });

  it("uses a held tool once for a quick drag, then restores the old one", async () => {
    const saved = mockEditor();
    await ready();
    holdKey("r", 100, () => drag([10, 10], [80, 60]));
    expect(pressed("Arrow")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "rect", x: 10, y: 10, width: 70, height: 50 }));
  });

  it("draws a rectangle on ⌘-drag and an arrow on ⌥-drag, keeping the tool", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    drag([10, 10], [80, 60], { metaKey: true });
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "rect", width: 70, height: 50 }));
    drag([100, 100], [150, 120], { altKey: true });
    await waitFor(() => expect(last(saved)?.shapes[5]).toMatchObject({ type: "arrow", points: [100, 100, 150, 120] }));
    expect(pressed("Select")).toHaveAttribute("aria-pressed", "true");
  });

  it("holds lines to 45° and boxes to squares with Shift", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.keyDown(window, { key: "l" });
    drag([0, 0], [100, 10], { shiftKey: true });
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "line", points: [0, 0, 100, 0] }));
    fireEvent.keyDown(window, { key: "e" });
    drag([0, 0], [80, 30], { shiftKey: true });
    await waitFor(() => expect(last(saved)?.shapes[5]).toMatchObject({ type: "ellipse", width: 80, height: 80 }));
  });

  it("picks colour swatches with the number keys", async () => {
    mockEditor();
    await ready();
    fireEvent.keyDown(window, { key: "3" });
    expect(screen.getByRole("button", { name: "Colour #30a46c" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "7" });
    expect(screen.getByRole("button", { name: "Colour #ffffff" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a just-drawn shape selected, so it can be restyled or deleted", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.keyDown(window, { key: "r" });
    drag([10, 10], [80, 60]);
    expect(shapeIds()).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    fireEvent.keyDown(window, { key: "4" });
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "rect", color: "#0090ff" }));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);
  });

  it("moves an existing shape instead of drawing when a drawing tool drags it", async () => {
    mockEditor();
    await ready();
    expect(document.querySelector('[data-id="t1"]')).toHaveAttribute("data-draggable", "true");
    Object.assign(pointerAt, { x: 20, y: 200 });
    fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);
    Object.assign(pointerAt, { x: 120, y: 260 });
    fireEvent.mouseMove(stage());
    fireEvent.mouseUp(stage());
    expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(anchors()).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);

    fireEvent.keyDown(window, { key: "c" });
    expect(document.querySelector('[data-id="t1"]')).toHaveAttribute("data-draggable", "false");
  });

  it("opens a tool wheel on right-click and picks a tool from it", async () => {
    mockEditor();
    await ready();
    const canvas = document.querySelector(".editor-canvas") as Element;
    // The webview's own menu is suppressed.
    expect(fireEvent.contextMenu(canvas, { clientX: 300, clientY: 200 })).toBe(false);
    const wheel = within(screen.getByRole("menu", { name: "Tools" }));
    expect(wheel.getAllByRole("menuitemradio")).toHaveLength(13);
    expect(wheel.getByRole("menuitemradio", { name: "Arrow" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(wheel.getByRole("menuitemradio", { name: "Spotlight" }));
    expect(screen.queryByRole("menu", { name: "Tools" })).not.toBeInTheDocument();
    expect(pressed("Spotlight")).toHaveAttribute("aria-pressed", "true");
  });

  it("closes the tool wheel on Escape or a click away", async () => {
    mockEditor();
    await ready();
    const canvas = document.querySelector(".editor-canvas") as Element;
    fireEvent.contextMenu(canvas, { clientX: 300, clientY: 200 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Tools" })).not.toBeInTheDocument();

    fireEvent.contextMenu(canvas, { clientX: 300, clientY: 200 });
    fireEvent.pointerDown(screen.getByRole("toolbar", { name: "Style and actions" }));
    expect(screen.queryByRole("menu", { name: "Tools" })).not.toBeInTheDocument();
    expect(pressed("Arrow")).toHaveAttribute("aria-pressed", "true");
  });

  it("copies then closes the window on Ctrl+Enter", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    mockWindows("editor-1");
    mockEditor(sidecar, calls);
    await ready();
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(calls.map((call) => call.cmd)).toEqual(["editor_copy", "plugin:window|close"]));
    expect(bytes(calls[0].payload)).toEqual(Array.from(FLATTENED));
  });
});
