import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ReactNode, Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EditorWindow from "./EditorWindow";
import type { EditorPreferences } from "../settings/api";
import type { ShotText } from "../library/api";
import type { Annotations } from "./model";
import { PREFERENCES_DELAY_MS } from "./preferences";
import { AUTOSAVE_DELAY_MS } from "./useAnnotations";

/** Where the mocked stage reports the pointer, in capture pixels. */
const pointerAt = vi.hoisted(() => ({ x: 0, y: 0 }));
/** Where the editor last put a dragged node itself (a line handle snapping into place). */
const placed = vi.hoisted(() => ({ at: null as { x: number; y: number } | null }));

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
      x,
      y,
      points,
      bezier,
      onDragMove,
      onDragEnd,
    }: {
      children?: ReactNode;
      id?: string;
      name?: string;
      text?: string;
      enabledAnchors?: string[];
      draggable?: boolean;
      onMouseDown?: () => void;
      x?: number;
      y?: number;
      points?: number[];
      bezier?: boolean;
      onDragMove?: (event: unknown) => void;
      onDragEnd?: (event: unknown) => void;
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
          "data-x": x,
          "data-y": y,
          "data-points": points?.join(" "),
          "data-bezier": bezier === undefined ? undefined : String(bezier),
          onMouseDown: id ? () => onMouseDown?.() : undefined,
          // A DOM drag stands in for a Konva drag: the node lands where `pointerAt` says.
          onDrag: onDragMove ? (event: { nativeEvent: MouseEvent }) => onDragMove(dragEvent(event.nativeEvent)) : undefined,
          onDragEnd: onDragEnd ? (event: { nativeEvent: MouseEvent }) => onDragEnd(dragEvent(event.nativeEvent)) : undefined,
        },
        children,
      );
  // The dragged node is at `pointerAt` (for an annotation, its offset from where it was drawn).
  const dragEvent = (evt: MouseEvent) => ({
    evt,
    cancelBubble: false,
    target: {
      x: () => pointerAt.x,
      y: () => pointerAt.y,
      scaleX: () => 1,
      scaleY: () => 1,
      scale: () => undefined,
      position: (to?: { x: number; y: number }) => {
        if (!to) return { ...pointerAt };
        placed.at = { ...to };
        return undefined;
      },
    },
  });
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
    onWheel,
  }: {
    ref?: Ref<unknown>;
    children?: ReactNode;
    onMouseDown?: Handler;
    onMouseMove?: Handler;
    onMouseUp?: Handler;
    onWheel?: Handler;
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
      if (element instanceof Element && element.closest('[data-name~="line-handle"]')) {
        return {
          getStage: () => stage,
          getParent: () => null,
          getClassName: () => "Circle",
          hasName: (name: string) => name === "line-handle",
          name: () => "line-handle",
          draggable: () => true,
        };
      }
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
      {
        "data-konva": "Stage",
        onMouseDown: forward(onMouseDown),
        onMouseMove: forward(onMouseMove),
        onMouseUp: forward(onMouseUp),
        onWheel: forward(onWheel),
      },
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

/**
 * The editor preferences in settings.json: `stored` is what loading gives
 * (an Error makes it fail), and `saved` collects every write.
 */
interface PreferencesMock {
  stored?: EditorPreferences | Error;
  saved?: EditorPreferences[];
  /** What the backdrop image picker returns. */
  picked?: string | null;
  /** The capture's recorded scale factor. */
  scaleFactor?: number;
  /** What `library_text` answers for the capture; it is not in the library when unset. */
  shotText?: ShotText;
}

/** The capture's id in the mocked library. */
const SHOT_ID = 7;

/** Mocks the editor commands; returns every sidecar written. `calls` records output commands in order. */
function mockEditor(
  annotations: Annotations | null = sidecar,
  calls: { cmd: string; payload: unknown }[] = [],
  preferences: PreferencesMock = {},
): Annotations[] {
  const saved: Annotations[] = [];
  mockIPC((cmd, payload) => {
    switch (cmd) {
      case "get_editor_preferences":
        if (preferences.stored instanceof Error) throw preferences.stored;
        return preferences.stored ?? {};
      case "set_editor_preferences":
        preferences.saved?.push((payload as { preferences: EditorPreferences }).preferences);
        return (payload as { preferences: EditorPreferences }).preferences;
      case "editor_info":
        return { path: "/p/originals/shot.png", fileName: "shot.png", annotations, scaleFactor: preferences.scaleFactor ?? null };
      case "plugin:dialog|open":
        return preferences.picked ?? null;
      case "editor_backdrop_image":
        calls.push({ cmd, payload });
        return new ArrayBuffer(4);
      case "editor_image":
        return new ArrayBuffer(8);
      case "editor_save_annotations":
        saved.push((payload as { annotations: Annotations }).annotations);
        return null;
      case "library_shot_id":
        return preferences.shotText ? SHOT_ID : null;
      case "library_text":
        return preferences.shotText;
      case "library_copy_text":
        calls.push({ cmd, payload });
        return preferences.shotText?.state === "read" ? preferences.shotText.text : "";
      case "plugin:event|listen":
      case "plugin:event|unlisten":
        return 1;
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

/** A selected arrow or line's handle: "start", "end" or "bend". */
const lineHandle = (which: string) => document.querySelector(`[data-name~="line-handle-${which}"]`) as Element;
const handleAt = (which: string) => [Number(lineHandle(which).getAttribute("data-x")), Number(lineHandle(which).getAttribute("data-y"))];
/** Drags a line handle to `to` (capture pixels): live moves, then one drag end. */
function dragHandle(which: string, to: [number, number], keys: { shiftKey?: boolean } = {}) {
  Object.assign(pointerAt, { x: to[0], y: to[1] });
  // jsdom has no DragEvent, so the drag is sent as a MouseEvent, which carries the modifier keys.
  for (const type of ["drag", "dragend"]) fireEvent(lineHandle(which), new MouseEvent(type, { bubbles: true, ...keys }));
}

const shapeIds = () =>
  Array.from(document.querySelectorAll("[data-konva] [data-id]")).map((element) => element.getAttribute("data-id"));

const stage = () => document.querySelector('[data-konva="Stage"]') as Element;
/** The width button in the top bar, by what it sets ("Width", "Text size" or "Badge size"). */
const widthButton = (name: string) =>
  within(screen.getByRole("toolbar", { name: "Style and actions" })).getByRole("button", { name });
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
    const badges = Array.from(document.querySelectorAll('[data-konva="Group"][data-id] [data-text]')).map((element) =>
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

  it("gives a selected arrow bend and end handles instead of the box", async () => {
    mockEditor();
    await ready();
    expect(lineHandle("bend")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    expect(handleAt("start")).toEqual([10, 10]);
    expect(handleAt("end")).toEqual([100, 80]);
    // The bend handle sits halfway along the (still straight) arrow.
    expect(handleAt("bend")).toEqual([55, 45]);
    // Pressing a handle keeps the arrow selected.
    fireEvent.mouseDown(lineHandle("bend"));
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    // Other shapes keep the box.
    fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);
    expect(lineHandle("bend")).toBeNull();
  });

  it("bends an arrow from its middle handle, straightens it near the line, and undoes each drag", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    const arrow = () => document.querySelector('[data-id="a1"]') as Element;
    const savedArrow = () => last(saved)?.shapes.find((shape) => shape.id === "a1");

    // A live drag previews the curve without saving it.
    Object.assign(pointerAt, { x: 55, y: 15 });
    fireEvent.drag(lineHandle("bend"));
    expect(arrow()).toHaveAttribute("data-bezier", "true");
    expect(handleAt("bend")).toEqual([55, 15]);
    fireEvent.dragEnd(lineHandle("bend"));
    // The curve runs through the handle: control = 2H − (P0 + P2) / 2.
    await waitFor(() => expect(savedArrow()).toMatchObject({ points: [10, 10, 100, 80], control: [55, -15] }));
    expect(arrow().getAttribute("data-points")?.split(" ")).toHaveLength(8);

    // Back within a few pixels of the straight line's middle, it goes straight.
    dragHandle("bend", [57, 47]);
    await waitFor(() => expect(savedArrow()).not.toHaveProperty("control"));
    // The handle is put back on the line, not left under the pointer.
    expect(placed.at).toEqual({ x: 55, y: 45 });
    expect(arrow()).toHaveAttribute("data-bezier", "false");
    expect(handleAt("bend")).toEqual([55, 45]);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(handleAt("bend")).toEqual([55, 15]);
    expect(arrow()).toHaveAttribute("data-bezier", "true");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(handleAt("bend")).toEqual([55, 45]);
    expect(arrow()).toHaveAttribute("data-bezier", "false");
  });

  it("moves an arrow's end from its handle, keeping the bend, as one undo step", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    const savedArrow = () => last(saved)?.shapes.find((shape) => shape.id === "a1");

    dragHandle("end", [200, 80]);
    await waitFor(() => expect(savedArrow()).toMatchObject({ points: [10, 10, 200, 80] }));
    expect(savedArrow()).not.toHaveProperty("control");
    expect(handleAt("end")).toEqual([200, 80]);

    dragHandle("bend", [105, 20]);
    await waitFor(() => expect(savedArrow()).toHaveProperty("control"));
    dragHandle("start", [10, 80]);
    await waitFor(() => expect(savedArrow()).toMatchObject({ points: [10, 80, 200, 80] }));
    expect(savedArrow()).toHaveProperty("control");

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(handleAt("start")).toEqual([10, 10]);
    expect(handleAt("end")).toEqual([200, 80]);
  });

  it("holds a dragged end to 45° steps from the other end with Shift", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    // From (10, 10), (200, 40) is nearest the horizontal: the end lands at (200, 10).
    dragHandle("end", [200, 40], { shiftKey: true });
    await waitFor(() => expect(last(saved)?.shapes.find((shape) => shape.id === "a1")).toMatchObject({ points: [10, 10, 200, 10] }));
    expect(placed.at).toEqual({ x: 200, y: 10 });
    expect(handleAt("end")).toEqual([200, 10]);
  });

  it("keeps a selected arrow's handles on it while it is dragged", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    const arrow = () => document.querySelector('[data-id="a1"]') as Element;
    fireEvent.mouseDown(arrow());
    // Dragged 5px right and 20px down, not yet dropped.
    Object.assign(pointerAt, { x: 5, y: 20 });
    fireEvent.drag(arrow());
    expect(handleAt("start")).toEqual([15, 30]);
    expect(handleAt("end")).toEqual([105, 100]);
    expect(handleAt("bend")).toEqual([60, 65]);
    fireEvent.dragEnd(arrow());
    await waitFor(() => expect(last(saved)?.shapes.find((shape) => shape.id === "a1")).toMatchObject({ points: [15, 30, 105, 100] }));
    expect(handleAt("start")).toEqual([15, 30]);
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

  it("rotates the capture from the top bar, one undo step each", async () => {
    const saved = mockEditor();
    await ready();
    const bar = within(screen.getByRole("toolbar", { name: "Style and actions" }));
    fireEvent.click(bar.getByRole("button", { name: "Rotate right" }));
    await waitFor(() => expect(last(saved)).toMatchObject({ rotation: 90 }));
    // The 400×300 capture now shows 300×400; the shapes stay in capture pixels.
    expect(screen.getByText("Output 300×400")).toBeInTheDocument();
    expect(last(saved)?.shapes).toEqual(sidecar.shapes);

    fireEvent.click(bar.getByRole("button", { name: "Rotate left" }));
    fireEvent.click(bar.getByRole("button", { name: "Rotate left" }));
    await waitFor(() => expect(last(saved)).toMatchObject({ rotation: 270 }));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(last(saved)).not.toHaveProperty("rotation"));
    expect(screen.queryByText(/^Output /)).not.toBeInTheDocument();
  });

  it("rotates with Ctrl+[ and Ctrl+] without changing the width", async () => {
    const saved = mockEditor();
    await ready();
    expect(widthButton("Width")).toHaveTextContent("4px");
    fireEvent.keyDown(window, { key: "]", ctrlKey: true });
    await waitFor(() => expect(last(saved)).toMatchObject({ rotation: 90 }));
    fireEvent.keyDown(window, { key: "[", ctrlKey: true });
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    await waitFor(() => expect(last(saved)).toMatchObject({ rotation: 270 }));
    expect(widthButton("Width")).toHaveTextContent("4px");
  });

  it("flips the capture both ways, and a turn keeps how it shows", async () => {
    const saved = mockEditor();
    await ready();
    const bar = within(screen.getByRole("toolbar", { name: "Style and actions" }));
    fireEvent.click(bar.getByRole("button", { name: "Flip horizontal" }));
    await waitFor(() => expect(last(saved)).toMatchObject({ flipX: true }));
    expect(bar.getByRole("button", { name: "Flip horizontal" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(bar.getByRole("button", { name: "Flip vertical" }));
    await waitFor(() => expect(last(saved)).toMatchObject({ flipX: true, flipY: true }));
    fireEvent.click(bar.getByRole("button", { name: "Flip horizontal" }));
    await waitFor(() => expect(last(saved)).not.toHaveProperty("flipX"));
    // A turn of an image mirrored top to bottom mirrors it left to right instead.
    fireEvent.click(bar.getByRole("button", { name: "Rotate right" }));
    await waitFor(() => expect(last(saved)).toMatchObject({ rotation: 90, flipX: true }));
    expect(last(saved)).not.toHaveProperty("flipY");
  });

  it("draws where the pointer is on the turned capture", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    fireEvent.click(screen.getByRole("button", { name: "Rectangle" }));
    // On show at 10,20 → 110,70; on the capture that is 20,290 → 70,190.
    drag([10, 20], [110, 70]);
    await waitFor(() =>
      expect(last(last(saved)?.shapes ?? [])).toMatchObject({ type: "rect", x: 20, y: 190, width: 50, height: 100 }),
    );
  });

  it("resizes by width, ratio locked, or by a percentage, and undoes it", async () => {
    const saved = mockEditor();
    await ready();
    const toggle = screen.getByRole("button", { name: "Resize" });
    fireEvent.click(toggle);
    const panel = within(screen.getByRole("dialog", { name: "Resize" }));
    expect(panel.getByRole("spinbutton", { name: "Width" })).toHaveValue(400);
    expect(panel.getByRole("spinbutton", { name: "Height" })).toHaveValue(300);

    const width = panel.getByRole("spinbutton", { name: "Width" });
    fireEvent.change(width, { target: { value: "200" } });
    // The height follows as it is typed; nothing is kept yet.
    expect(panel.getByRole("spinbutton", { name: "Height" })).toHaveValue(150);
    fireEvent.keyDown(width, { key: "Enter" });
    await waitFor(() => expect(last(saved)).toMatchObject({ scale: 0.5 }));
    expect(screen.getByText("Output 200×150")).toBeInTheDocument();

    const percent = panel.getByRole("spinbutton", { name: "Percent" });
    fireEvent.change(percent, { target: { value: "1000" } });
    fireEvent.blur(percent);
    // Clamped to 400%.
    await waitFor(() => expect(last(saved)).toMatchObject({ scale: 4 }));
    expect(screen.getByText("Output 1600×1200")).toBeInTheDocument();

    fireEvent.click(panel.getByRole("button", { name: "100%" }));
    await waitFor(() => expect(last(saved)).not.toHaveProperty("scale"));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(last(saved)).toMatchObject({ scale: 4 }));

    fireEvent.keyDown(panel.getByRole("button", { name: "100%" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Resize" })).not.toBeInTheDocument();
  });

  it("copies the turned, flipped and resized capture", async () => {
    mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    fireEvent.click(screen.getByRole("button", { name: "Flip vertical" }));
    fireEvent.click(screen.getByRole("button", { name: "Resize" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Resize" })).getByRole("button", { name: "50%" }));
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    await waitFor(() => expect(last(flattened.calls)).toMatchObject({ rotation: 270, flipX: false, flipY: true, scale: 0.5 }));
  });

  it("steps the stroke width with [ and ]", async () => {
    mockEditor();
    await ready();
    expect(widthButton("Width")).toHaveTextContent("4px");
    fireEvent.keyDown(window, { key: "]" });
    expect(widthButton("Width")).toHaveTextContent("6px");
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.keyDown(window, { key: "[" });
    expect(widthButton("Width")).toHaveTextContent("2px");
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(window, { key: "[" });
    expect(widthButton("Width")).toHaveTextContent("1px");
  });

  it("picks a width from the popover, with a preview, and draws with it", async () => {
    const saved = mockEditor();
    await ready();
    const toggle = widthButton("Width");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const panel = within(screen.getByRole("dialog", { name: "Width" }));
    const slider = panel.getByRole("slider", { name: "Width" });
    // Nine presets, 1px to 24px; 4px is the fourth.
    expect(slider).toHaveAttribute("max", "8");
    expect(slider).toHaveValue("3");
    expect(panel.getByTestId("width-preview")).toHaveAttribute("data-width", "4");

    fireEvent.change(slider, { target: { value: "8" } });
    expect(panel.getByTestId("width-preview")).toHaveAttribute("data-width", "24");
    expect(toggle).toHaveTextContent("24px");

    drag([10, 10], [120, 90]);
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "arrow", strokeWidth: 24 }));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Width" })).not.toBeInTheDocument();
  });

  it("closes the width popover on a click away", async () => {
    mockEditor();
    await ready();
    fireEvent.click(widthButton("Width"));
    expect(screen.getByRole("dialog", { name: "Width" })).toBeInTheDocument();
    fireEvent.pointerDown(stage());
    expect(screen.queryByRole("dialog", { name: "Width" })).not.toBeInTheDocument();
  });

  it("keeps a width for each tool", async () => {
    mockEditor();
    await ready();
    fireEvent.keyDown(window, { key: "]" });
    expect(widthButton("Width")).toHaveTextContent("6px");
    fireEvent.keyDown(window, { key: "r" });
    expect(widthButton("Width")).toHaveTextContent("4px");
    fireEvent.keyDown(window, { key: "[" });
    expect(widthButton("Width")).toHaveTextContent("3px");
    fireEvent.keyDown(window, { key: "a" });
    expect(widthButton("Width")).toHaveTextContent("6px");
    // Tools without a width hide the control.
    fireEvent.keyDown(window, { key: "b" });
    expect(screen.queryByRole("button", { name: "Width" })).not.toBeInTheDocument();
  });

  it("changes the width with ⌥-scroll over the canvas instead of zooming", async () => {
    mockEditor();
    await ready();
    const zoom = screen.getByLabelText("Zoom").textContent;
    fireEvent.wheel(stage(), { deltaY: -100, altKey: true });
    expect(widthButton("Width")).toHaveTextContent("6px");
    fireEvent.wheel(stage(), { deltaY: 100, altKey: true });
    fireEvent.wheel(stage(), { deltaY: 100, altKey: true });
    expect(widthButton("Width")).toHaveTextContent("3px");
    expect(screen.getByLabelText("Zoom").textContent).toBe(zoom);
  });

  it("sizes text and step badges on their own, not from the stroke width", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.keyDown(window, { key: "]" });
    fireEvent.keyDown(window, { key: "]" });
    expect(widthButton("Width")).toHaveTextContent("8px");

    fireEvent.keyDown(window, { key: "n" });
    expect(widthButton("Badge size")).toHaveTextContent("20px");
    fireEvent.keyDown(window, { key: "]" });
    expect(widthButton("Badge size")).toHaveTextContent("24px");
    Object.assign(pointerAt, { x: 200, y: 150 });
    fireEvent.mouseDown(stage());
    fireEvent.mouseUp(stage());
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "step", radius: 24 }));

    fireEvent.keyDown(window, { key: "t" });
    expect(widthButton("Text size")).toHaveTextContent("30px");

    // A selected text shows and changes its own size.
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);
    expect(widthButton("Text size")).toHaveTextContent("24px");
    fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => expect(last(saved)?.shapes.find((shape) => shape.id === "t1")).toMatchObject({ fontSize: 30 }));
  });

  it("opens with the colour, tool, widths and options saved last time", async () => {
    mockEditor(sidecar, [], {
      stored: { color: "#30a46c", tool: "rect", widths: { rect: 12, text: 48 }, fill: true, textBackground: true, blurMode: "blur" },
    });
    await ready();
    await waitFor(() => expect(pressed("Rectangle")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("button", { name: "Colour #30a46c" })).toHaveAttribute("aria-pressed", "true");
    expect(widthButton("Width")).toHaveTextContent("12px");
    expect(screen.getByRole("button", { name: "Fill" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "t" });
    expect(widthButton("Text size")).toHaveTextContent("48px");
    expect(screen.getByRole("button", { name: "Text background" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "b" });
    expect(screen.getByRole("button", { name: "Smooth" })).toHaveAttribute("aria-pressed", "true");
  });

  it("saves changed preferences once they settle", async () => {
    const saved: EditorPreferences[] = [];
    mockEditor(sidecar, [], { stored: {}, saved });
    await ready();
    // Loading alone writes nothing.
    await new Promise((resolve) => setTimeout(resolve, PREFERENCES_DELAY_MS + 100));
    expect(saved).toEqual([]);

    fireEvent.keyDown(window, { key: "4" });
    fireEvent.keyDown(window, { key: "]" });
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      color: "#0090ff",
      tool: "rect",
      widths: { arrow: 6 },
      fill: false,
      textBackground: false,
      blurMode: "pixelate",
    });
  });

  it("keeps today's defaults and saves nothing when preferences cannot load", async () => {
    const saved: EditorPreferences[] = [];
    mockEditor(sidecar, [], { stored: new Error("no settings"), saved });
    await ready();
    expect(pressed("Arrow")).toHaveAttribute("aria-pressed", "true");
    expect(widthButton("Width")).toHaveTextContent("4px");
    fireEvent.keyDown(window, { key: "3" });
    expect(screen.getByRole("button", { name: "Colour #30a46c" })).toHaveAttribute("aria-pressed", "true");
    await new Promise((resolve) => setTimeout(resolve, PREFERENCES_DELAY_MS + 100));
    expect(saved).toEqual([]);
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

  it("does not draw with the click on the canvas that closes the tool wheel", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.keyDown(window, { key: "n" });
    const canvas = document.querySelector(".editor-canvas") as Element;
    fireEvent.contextMenu(canvas, { clientX: 300, clientY: 200 });
    Object.assign(pointerAt, { x: 150, y: 150 });
    fireEvent.pointerDown(stage());
    fireEvent.mouseDown(stage());
    fireEvent.mouseUp(stage());
    expect(screen.queryByRole("menu", { name: "Tools" })).not.toBeInTheDocument();
    expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);

    // The next click draws as usual.
    fireEvent.mouseDown(stage());
    fireEvent.mouseUp(stage());
    expect(shapeIds()).toHaveLength(5);
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "step", x: 150, y: 150 }));
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

  it("copies the capture's stored text from Copy text, beside Copy", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    mockEditor(sidecar, calls, { shotText: { state: "read", text: "Invoice 2026-031" } });
    await ready();
    const bar = within(screen.getByRole("toolbar", { name: "Style and actions" }));
    const copyText = await bar.findByRole("button", { name: "Copy text" });
    expect(copyText.previousElementSibling).toBe(bar.getByRole("button", { name: "Copy" }));

    fireEvent.click(copyText);

    await waitFor(() => expect(calls.map((call) => call.cmd)).toEqual(["library_copy_text"]));
    expect(calls[0].payload).toEqual({ id: SHOT_ID });
    expect(await screen.findByText("Copied 1 line of text.")).toBeInTheDocument();
  });

  it.each<[string, ShotText | undefined]>([
    ["not in the library", undefined],
    ["still waiting for OCR", { state: "waiting" }],
    ["OCR could not read", { state: "failed" }],
    ["without text", { state: "read", text: "  " }],
  ])("offers no Copy text for a capture %s", async (_, shotText) => {
    mockEditor(sidecar, [], { shotText });
    await ready();
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument());
    // Give the text lookup time to answer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: "Copy text" })).not.toBeInTheDocument();
  });

  const backdropPanel = () => {
    fireEvent.click(screen.getByRole("button", { name: "Backdrop" }));
    return within(screen.getByRole("dialog", { name: "Backdrop" }));
  };
  const fills = () => document.querySelectorAll('[data-name="backdrop-fill"]').length;

  it("offers gradients, meshes and solids, with a 36pt corner by default", async () => {
    const saved = mockEditor();
    await ready();
    const panel = backdropPanel();
    expect(panel.getByRole("group", { name: "Gradients" })).toBeInTheDocument();
    expect(panel.getByRole("group", { name: "Mesh" })).toBeInTheDocument();
    expect(panel.getByRole("group", { name: "Solids" })).toBeInTheDocument();
    expect(panel.getByRole("slider", { name: "Shadow size" })).toBeDisabled();

    fireEvent.click(panel.getByRole("button", { name: "Bloom mesh" }));
    await waitFor(() => expect(last(saved)?.backdrop).toEqual({ fill: "mesh-bloom", padding: 64, radius: 36, radiusUnit: "pt", shadow: true }));
    expect(panel.getByRole("slider", { name: "Corner radius" })).toHaveValue("36");
    expect(panel.getByText("36pt")).toBeInTheDocument();
    // A base colour and three blobs, as the export paints them.
    expect(fills()).toBe(4);

    fireEvent.click(panel.getByRole("button", { name: "Flamingo gradient" }));
    await waitFor(() => expect(last(saved)?.backdrop?.fill).toBe("flamingo"));
    expect(fills()).toBe(1);
  });

  it("sizes and strengthens the shadow with its sliders", async () => {
    const saved = mockEditor({ ...sidecar, backdrop: { fill: "ocean", padding: 40, radius: 12, shadow: true } });
    await ready();
    const panel = backdropPanel();
    const size = panel.getByRole("slider", { name: "Shadow size" });
    const strength = panel.getByRole("slider", { name: "Shadow strength" });
    // An old sidecar shows the shadow it always had.
    expect(size).toHaveValue("50");
    expect(strength).toHaveValue("35");

    fireEvent.change(size, { target: { value: "80" } });
    fireEvent.pointerUp(size);
    await waitFor(() => expect(last(saved)?.backdrop).toMatchObject({ shadowSize: 80 }));
    fireEvent.change(strength, { target: { value: "60" } });
    fireEvent.pointerUp(strength);
    await waitFor(() => expect(last(saved)?.backdrop).toMatchObject({ shadowSize: 80, shadowStrength: 60 }));

    fireEvent.click(panel.getByRole("checkbox", { name: "Shadow" }));
    await waitFor(() => expect(last(saved)?.backdrop).toMatchObject({ shadow: false }));
    expect(size).toBeDisabled();
  });

  it("pads the output to the aspect ratio picked", async () => {
    const saved = mockEditor({ ...sidecar, backdrop: { fill: "ocean", padding: 64, radius: 12, shadow: true } });
    await ready();
    const panel = backdropPanel();
    const aspects = within(panel.getByRole("group", { name: "Aspect ratio" }));
    expect(aspects.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Output 528×428")).toBeInTheDocument();

    fireEvent.click(aspects.getByRole("button", { name: "1:1" }));
    await waitFor(() => expect(last(saved)?.backdrop).toMatchObject({ aspect: "1:1" }));
    expect(screen.getByText("Output 528×528")).toBeInTheDocument();
    fireEvent.click(aspects.getByRole("button", { name: "16:9" }));
    expect(screen.getByText("Output 761×428")).toBeInTheDocument();
  });

  it("mixes a custom gradient from two colours and an angle", async () => {
    const saved = mockEditor();
    await ready();
    const panel = backdropPanel();
    expect(panel.queryByRole("slider", { name: "Angle" })).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole("button", { name: "Custom gradient" }));
    await waitFor(() =>
      expect(last(saved)?.backdrop).toMatchObject({ fill: "custom", gradient: { from: "#4c8dff", to: "#ff6ac1", angle: 135 } }),
    );

    const start = panel.getByLabelText("Gradient start colour");
    fireEvent.change(start, { target: { value: "#00ff00" } });
    fireEvent.blur(start);
    await waitFor(() => expect(last(saved)?.backdrop?.gradient).toMatchObject({ from: "#00ff00" }));
    const angle = panel.getByRole("slider", { name: "Angle" });
    fireEvent.change(angle, { target: { value: "90" } });
    fireEvent.pointerUp(angle);
    await waitFor(() => expect(last(saved)?.backdrop?.gradient).toEqual({ from: "#00ff00", to: "#ff6ac1", angle: 90 }));
  });

  it("fills the backdrop with the blurred capture or nothing at all", async () => {
    const saved = mockEditor();
    await ready();
    const panel = backdropPanel();
    fireEvent.click(panel.getByRole("button", { name: "Blurred capture" }));
    await waitFor(() => expect(last(saved)?.backdrop?.fill).toBe("blur"));
    fireEvent.click(panel.getByRole("button", { name: "Transparent" }));
    await waitFor(() => expect(last(saved)?.backdrop?.fill).toBe("transparent"));
    // Nothing is painted behind the capture.
    expect(fills()).toBe(0);
  });

  it("fills the backdrop with a picked image, read through the editor", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    const saved = mockEditor(sidecar, calls, { picked: "/home/me/Pictures/beach.jpg" });
    await ready();
    const panel = backdropPanel();
    fireEvent.click(panel.getByRole("button", { name: "Image" }));
    await waitFor(() => expect(last(saved)?.backdrop).toMatchObject({ fill: "image", image: "/home/me/Pictures/beach.jpg" }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "editor_backdrop_image", payload: { path: "/home/me/Pictures/beach.jpg" } }));
    await waitFor(() => expect(document.querySelector('[data-name="backdrop-image"]')).not.toBeNull());
  });

  it("keeps the backdrop when the image picker is cancelled", async () => {
    const saved = mockEditor(sidecar, [], { picked: null });
    await ready();
    const panel = backdropPanel();
    fireEvent.click(panel.getByRole("button", { name: "Image" }));
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    expect(saved).toEqual([]);
  });

  it("remembers the last backdrop and starts new ones from it", async () => {
    const prefs: EditorPreferences[] = [];
    const remembered = { fill: "dusk", padding: 32, radius: 20, shadow: false, aspect: "4:3" as const };
    mockEditor(sidecar, [], { stored: { backdrop: remembered }, saved: prefs });
    await ready();
    const panel = backdropPanel();
    // Off, but its sliders show the last backdrop's sizes.
    expect(panel.getByRole("slider", { name: "Padding" })).toHaveValue("32");

    fireEvent.click(panel.getByRole("button", { name: "Sunset gradient" }));
    await waitFor(() => expect(last(prefs)?.backdrop).toEqual({ ...remembered, fill: "sunset" }));
  });

  it("frames a capture opened for the first time with the last backdrop when asked to", async () => {
    const backdrop = { fill: "aurora", padding: 48, radius: 36, shadow: true };
    const saved = mockEditor(null, [], { stored: { autoBackdrop: true, backdrop } });
    await ready();
    await waitFor(() => expect(last(saved)?.backdrop).toEqual(backdrop));
    expect(screen.getByText("Output 496×396")).toBeInTheDocument();
    // It came with the capture, so there is nothing to undo.
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("leaves captures with annotations, and captures when auto-apply is off, as they are", async () => {
    const backdrop = { fill: "aurora", padding: 48, radius: 36, shadow: true };
    const saved = mockEditor(sidecar, [], { stored: { autoBackdrop: true, backdrop } });
    await ready();
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    expect(saved).toEqual([]);
    expect(screen.queryByText(/^Output /)).not.toBeInTheDocument();
  });

  it("does not frame a new capture while auto-apply is off", async () => {
    const saved = mockEditor(null, [], { stored: { backdrop: { fill: "aurora", padding: 48, radius: 36, shadow: true } } });
    await ready();
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    expect(saved).toEqual([]);
  });
});
