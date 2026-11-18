import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ReactNode, Ref } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EditorWindow from "./EditorWindow";
import type { BackdropPreset, EditorPreferences } from "../settings/api";
import type { OcrLine, ShotText } from "../library/api";
import type { CapturedPointer } from "./api";
import type { Annotations, Shape } from "./model";
import { PREFERENCES_DELAY_MS } from "./preferences";
import { AUTOSAVE_DELAY_MS } from "./useAnnotations";

/** Where the mocked stage reports the pointer, in capture pixels. */
const pointerAt = vi.hoisted(() => ({ x: 0, y: 0 }));
/** Where the editor last put a dragged node itself (a line handle snapping into place). */
/** What the content layer was rendered over, outside flatten (which is mocked): the preview's shadow silhouette. */
const layerRenders = vi.hoisted(() => ({ areas: [] as { x: number; y: number; width: number; height: number; pixelRatio: number }[] }));
const placed = vi.hoisted(() => ({ at: null as { x: number; y: number } | null }));
/** What a node reports when a Transformer resize or turn ends on it. */
const transformTo = vi.hoisted(() => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }));

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
      onDblClick,
      x,
      y,
      points,
      data,
      bezier,
      rotation,
      scaleX,
      scaleY,
      onDragMove,
      onDragEnd,
      onTransformEnd,
      rotateEnabled,
      keepRatio,
      rotationSnaps,
      stroke,
      shadowColor,
      fill,
    }: {
      children?: ReactNode;
      id?: string;
      name?: string;
      text?: string;
      enabledAnchors?: string[];
      draggable?: boolean;
      onMouseDown?: () => void;
      onDblClick?: () => void;
      x?: number;
      y?: number;
      points?: number[];
      data?: string;
      bezier?: boolean;
      rotation?: number;
      scaleX?: number;
      scaleY?: number;
      onDragMove?: (event: unknown) => void;
      onDragEnd?: (event: unknown) => void;
      onTransformEnd?: (event: unknown) => void;
      rotateEnabled?: boolean;
      keepRatio?: boolean;
      rotationSnaps?: number[];
      stroke?: string;
      shadowColor?: string;
      fill?: string;
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
          "data-path": data,
          "data-bezier": bezier === undefined ? undefined : String(bezier),
          "data-rotation": rotation,
          "data-scale-x": scaleX,
          "data-scale-y": scaleY,
          "data-rotate-enabled": rotateEnabled === undefined ? undefined : String(rotateEnabled),
          "data-keep-ratio": keepRatio === undefined ? undefined : String(keepRatio),
          "data-rotation-snaps": rotationSnaps?.length,
          "data-stroke": stroke,
          "data-shadow": shadowColor,
          "data-fill": fill,
          onMouseDown: id ? () => onMouseDown?.() : undefined,
          onDoubleClick: onDblClick ? () => onDblClick() : undefined,
          // A DOM transitionend stands in for the end of a Konva transform: the node reports `transformTo`.
          onTransitionEnd: onTransformEnd ? () => onTransformEnd(transformEvent()) : undefined,
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
  const transformEvent = () => ({
    target: {
      x: () => transformTo.x,
      y: () => transformTo.y,
      scaleX: () => transformTo.scaleX,
      scaleY: () => transformTo.scaleY,
      rotation: () => transformTo.rotation,
      scale: () => undefined,
      position: () => undefined,
    },
  });
  const LayerNode = node("Layer");
  // The editor needs a layer to flatten (flatten itself is mocked below).
  const Layer = ({ ref, ...props }: { ref?: Ref<unknown>; children?: ReactNode; name?: string }) => {
    useImperativeHandle(
      ref,
      () => ({
        findOne: () => undefined,
        toCanvas: (area: { x: number; y: number; width: number; height: number; pixelRatio: number }) => {
          layerRenders.areas.push(area);
          return document.createElement("canvas");
        },
      }),
      [],
    );
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
    scaleX,
  }: {
    ref?: Ref<unknown>;
    children?: ReactNode;
    scaleX?: number;
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
      // The crop rect reports its name, and its drag can be turned off and back on.
      if (element instanceof Element && element.closest('[data-name="crop-box"]')) {
        let draggable = true;
        return {
          getStage: () => stage,
          getParent: () => null,
          getClassName: () => "Rect",
          hasName: (name: string) => name === "crop-box",
          name: () => "crop-box",
          draggable: (value?: boolean) => (value === undefined ? draggable : ((draggable = value), undefined)),
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
        // CSS pixels per image pixel, so tests can tell the zoom apart from its label.
        "data-scale-x": scaleX,
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
    Path: node("Path"),
    Transformer: node("Transformer"),
  };
});

/** The editor's file-drop listener, so a test can drop files on it. */
const dropListener = vi.hoisted(() => ({
  handler: null as ((event: { payload: { type: string; paths?: string[]; position?: { x: number; y: number } } }) => void) | null,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: typeof dropListener.handler) => {
      dropListener.handler = handler;
      return Promise.resolve(() => {
        if (dropListener.handler === handler) dropListener.handler = null;
      });
    },
  }),
}));

const FLATTENED = new Uint8Array([1, 2, 3]);
const flattened = vi.hoisted(() => ({ calls: [] as unknown[], options: [] as unknown[], measured: [] as unknown[][] }));
/** The capture's plain border as measured: an empty 80px margin on the right (jsdom cannot read pixels). */
const MEASURED_BORDERS = vi.hoisted(() => ({ top: 0, right: 80, bottom: 0, left: 0 }));
vi.mock("./flatten", async (original) => ({
  ...(await original<typeof import("./flatten")>()),
  measureBorders: (...args: unknown[]) => {
    flattened.measured.push(args);
    return MEASURED_BORDERS;
  },
  flatten: async (_layer: unknown, doc: unknown, _image: unknown, _view: unknown, _format: unknown, options: unknown) => {
    flattened.calls.push(doc);
    flattened.options.push(options);
    return new Uint8Array([1, 2, 3]);
  },
}));

/** The line of text the highlighter finds under a drag (jsdom cannot read pixels), and what it was asked. */
const textBands = vi.hoisted(() => ({ band: null as { top: number; bottom: number } | null, asked: [] as unknown[][] }));
vi.mock("./textBand", async (original) => ({
  ...(await original<typeof import("./textBand")>()),
  imageTextBand: (...args: unknown[]) => {
    textBands.asked.push(args);
    return textBands.band;
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
  /** Collects every list of backdrop presets written. */
  presets?: BackdropPreset[][];
  /** Collects every list of favourite colours written. */
  favorites?: string[][];
  /** What `editor_words` answers (an Error makes it fail); no words when unset. */
  words?: OcrLine[] | Error | Promise<OcrLine[]>;
  /** What `editor_asset_image` answers; four bytes at once when unset. */
  asset?: Promise<ArrayBuffer>;
  /** What `editor_faces` answers; no faces when unset. */
  faces?: { x: number; y: number; width: number; height: number }[];
  /** The mouse pointer saved with the capture; none when unset. */
  pointer?: CapturedPointer;
}

/** The capture's id in the mocked library. */
const SHOT_ID = 7;

/** Where the mocked backend keeps a preset's copy of its image. */
const PRESET_COPY = "/data/grab-it/backdrop-presets/beach-1700000000000.jpg";

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
      case "set_backdrop_presets": {
        // Stored, so the next read sees them, as settings.json would.
        const presets = (payload as { presets: BackdropPreset[] }).presets;
        preferences.presets?.push(presets);
        if (!(preferences.stored instanceof Error)) preferences.stored = { ...preferences.stored, backdropPresets: presets };
        return presets;
      }
      case "set_favorite_colors": {
        // Stored, so the next read sees them, as settings.json would.
        const colors = (payload as { colors: string[] }).colors;
        preferences.favorites?.push(colors);
        if (!(preferences.stored instanceof Error)) preferences.stored = { ...preferences.stored, favoriteColors: colors };
        return colors;
      }
      case "save_backdrop_preset_image":
        calls.push({ cmd, payload });
        return PRESET_COPY;
      case "editor_info":
        return {
          path: "/p/originals/shot.png",
          fileName: "shot.png",
          annotations,
          scaleFactor: preferences.scaleFactor ?? null,
          pointer: preferences.pointer ?? null,
        };
      case "plugin:dialog|open":
        return preferences.picked ?? null;
      case "editor_backdrop_image":
        calls.push({ cmd, payload });
        return new ArrayBuffer(4);
      case "editor_image":
        return new ArrayBuffer(8);
      case "editor_add_image_file":
        calls.push({ cmd, payload });
        return "before-1700000000000.png";
      case "editor_add_clipboard_image":
        calls.push({ cmd, payload });
        return "pasted-1700000000000.png";
      case "editor_asset_image":
        calls.push({ cmd, payload });
        return preferences.asset ?? new ArrayBuffer(4);
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
      case "editor_words":
        calls.push({ cmd, payload });
        if (preferences.words instanceof Error) throw preferences.words;
        return preferences.words ?? [];
      case "editor_faces":
        calls.push({ cmd, payload });
        return preferences.faces ?? [];
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

/** Time for the file's first test, which also pays for the editor's first render. */
const COLD_START_TIMEOUT_MS = 20_000;

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
function drag(
  from: [number, number],
  to: [number, number],
  keys: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {},
) {
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

// Each test mounts the whole editor and takes about a second alone; in a
// full run beside the other files a slow one can pass the default 5s, and
// its own waits (asyncUtilTimeout in src/test/setup.ts) need room inside it.
describe("EditorWindow", { timeout: 20_000 }, () => {
  beforeEach(() => {
    flattened.calls = [];
    flattened.options = [];
    layerRenders.areas = [];
    flattened.measured = [];
    textBands.band = null;
    textBands.asked = [];
    vi.stubGlobal("Image", LoadedImage);
    URL.createObjectURL = vi.fn(() => "blob:capture");
    URL.revokeObjectURL = vi.fn();
  });

  // The first test in the file also renders the editor for the first time, which is slow on a busy machine.
  it("fits a highlighter drag over a line of text to it, and keeps the stroke where none is found", async () => {
    const saved = mockEditor({ version: 1, shapes: [], crop: null });
    await ready();
    fireEvent.click(pressed("Highlighter"));
    textBands.band = { top: 50, bottom: 64 };
    drag([20, 58], [120, 60]);
    await waitFor(() => expect(last(saved)?.shapes).toHaveLength(1));
    expect(last(saved)!.shapes[0]).toMatchObject({ type: "highlighter", points: [20, 57, 120, 57], strokeWidth: 14 });
    // It looked at the capture under the drag.
    expect(last(textBands.asked)?.[1]).toEqual([20, 58, 120, 60]);
    textBands.band = null;
    drag([20, 100], [120, 102]);
    await waitFor(() => expect(last(saved)?.shapes).toHaveLength(2));
    expect(last(saved)!.shapes[1]).toMatchObject({ type: "highlighter", points: [20, 100, 120, 102] });
    expect(last(saved)!.shapes[1]).not.toMatchObject({ strokeWidth: 14 });
  }, COLD_START_TIMEOUT_MS);

  it("draws with Z, selects the lens interior and saves its zoom, shape, line and spot", async () => {
    const saved = mockEditor({ version: 1, shapes: [], crop: null });
    await ready();
    holdKey("z", 10);
    expect(pressed("Magnify")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "2x" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Round" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Line to spot" })).toHaveAttribute("aria-pressed", "false");
    drag([20, 30], [100, 70]);
    await waitFor(() => expect(last(saved)?.shapes[0]).toMatchObject({ type: "magnify", x: 20, y: 30, width: 80, height: 80, spot: [60, 70], zoom: 2 }));
    const id = last(saved)!.shapes[0].id;
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(stage());
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    // The lens's custom hit surface is one annotation, including its interior.
    fireEvent.mouseDown(document.querySelector(`[data-id="${id}"]`) as Element);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(anchors()).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);
    fireEvent.click(screen.getByRole("button", { name: "3x" }));
    fireEvent.click(screen.getByRole("button", { name: "Square" }));
    fireEvent.click(screen.getByRole("button", { name: "Line to spot" }));
    expect(screen.getByRole("button", { name: "3x" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Square" })).toHaveAttribute("aria-pressed", "true");
    expect(handleAt("spot")).toEqual([60, 70]);
    dragHandle("spot", [10, 15]);
    await waitFor(() => expect(last(saved)?.shapes[0]).toMatchObject({ zoom: 3, lens: "square", line: true, spot: [10, 15], x: 20, y: 30 }));
    const line = () => document.querySelector('[data-name="magnify-line"]')!.getAttribute("data-points");
    const before = line();
    Object.assign(pointerAt, { x: 200, y: 140 });
    fireEvent(document.querySelector(`[data-id="${id}"]`)!, new MouseEvent("drag", { bubbles: true }));
    expect(line()).not.toEqual(before);
    fireEvent(document.querySelector(`[data-id="${id}"]`)!, new MouseEvent("dragend", { bubbles: true }));
    await waitFor(() => expect(last(saved)?.shapes[0]).toMatchObject({ x: 200, y: 140, spot: [10, 15] }));
    fireEvent.click(screen.getByRole("button", { name: "Round" }));
    fireEvent.click(screen.getByRole("button", { name: "Line to spot" }));
    await waitFor(() => {
      const shape = last(saved)?.shapes[0];
      expect(shape?.type).toBe("magnify");
      if (shape?.type === "magnify") {
        expect(shape.lens).toBeUndefined();
        expect(shape.line).toBeUndefined();
      }
    });
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
    for (const name of ["Arrow", "Rectangle", "Ellipse", "Line", "Freehand", "Text", "Callout", "Highlighter", "Blur", "Magnify", "Spotlight", "Step", "Stamp", "Crop", "Cut out", "Select", "Pan"]) {
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

  describe("captured pointer", () => {
    const pointer: CapturedPointer = { x: 120, y: 80, hotX: 2, hotY: 3, width: 12, height: 20, image: "iVBORw0KGgo=" };
    const node = () => document.querySelector('[data-id="captured-pointer"]');
    const pointerButton = () => screen.getByRole("button", { name: "Pointer" });

    it("is off without a pointer in the capture", async () => {
      mockEditor();
      await ready();
      expect(pointerButton()).toBeDisabled();
      expect(node()).toBeNull();
    });

    it("starts hidden unless the setting shows it, and the button shows it", async () => {
      const saved = mockEditor(null, [], { pointer });
      await ready();
      expect(pointerButton()).toBeEnabled();
      expect(pointerButton()).toHaveAttribute("aria-pressed", "false");
      expect(node()).toBeNull();

      fireEvent.click(pointerButton());
      await waitFor(() => expect(node()).not.toBeNull());
      expect(pointerButton()).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(last(saved)?.pointer).toEqual({ shown: true, x: 120, y: 80, scale: 1 }));
    });

    it("moves with Select, resizes from its corners, hides with Delete, and undoes each", async () => {
      const saved = mockEditor(null, [], { pointer, stored: { showPointer: true } });
      await ready();
      await waitFor(() => expect(node()).not.toBeNull());
      // Drawn with its hot spot on the captured position.
      expect(node()).toHaveAttribute("data-x", "118");
      expect(node()).toHaveAttribute("data-y", "77");

      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.mouseDown(node() as Element);
      expect(anchors()).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);

      Object.assign(pointerAt, { x: 40, y: 60 });
      fireEvent(node() as Element, new MouseEvent("dragend", { bubbles: true }));
      await waitFor(() => expect(last(saved)?.pointer).toEqual({ shown: true, x: 42, y: 63, scale: 1 }));

      fireEvent.keyDown(window, { key: "Delete" });
      expect(node()).toBeNull();
      await waitFor(() => expect(last(saved)?.pointer).toEqual({ shown: false, x: 42, y: 63, scale: 1 }));

      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      await waitFor(() => expect(node()).toHaveAttribute("data-x", "40"));
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      await waitFor(() => expect(node()).toHaveAttribute("data-x", "118"));
    });

    it("swaps for a built-in look that points at the same place, and back", async () => {
      const saved = mockEditor(null, [], { pointer, scaleFactor: 2 });
      await ready();
      expect(node()).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Pointer look" }));
      const picker = within(screen.getByRole("dialog", { name: "Pointer look" }));
      expect(picker.getByRole("button", { name: "Captured" })).toHaveAttribute("aria-pressed", "true");

      // Picking a look shows the pointer, its fingertip on the captured hot spot (16, 3 at twice the density).
      fireEvent.click(picker.getByRole("button", { name: "Hand" }));
      await waitFor(() => expect(node()).not.toBeNull());
      expect(node()).toHaveAttribute("data-x", "104");
      expect(node()).toHaveAttribute("data-y", "77");
      expect(picker.getByRole("button", { name: "Hand" })).toHaveAttribute("aria-pressed", "true");
      expect(pointerButton()).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(last(saved)?.pointer).toEqual({ shown: true, x: 120, y: 80, scale: 1, look: "hand" }));

      fireEvent.click(picker.getByRole("button", { name: "Text" }));
      await waitFor(() => expect(node()).toHaveAttribute("data-x", "110"));
      expect(node()).toHaveAttribute("data-y", "60");

      fireEvent.click(picker.getByRole("button", { name: "Captured" }));
      await waitFor(() => expect(node()).toHaveAttribute("data-x", "118"));
      await waitFor(() => expect(last(saved)?.pointer).toEqual({ shown: true, x: 120, y: 80, scale: 1 }));

      // Each pick is one undo step.
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      await waitFor(() => expect(node()).toHaveAttribute("data-x", "110"));

      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog", { name: "Pointer look" })).toBeNull();
    });

    it("has no look picker without a pointer in the capture", async () => {
      mockEditor();
      await ready();
      expect(screen.getByRole("button", { name: "Pointer look" })).toBeDisabled();
    });

    it("moves up with the image when a strip above it is cut out, and back down on Restore strips", async () => {
      mockEditor(null, [], { pointer, stored: { showPointer: true } });
      await ready();
      await waitFor(() => expect(node()).toHaveAttribute("data-y", "77"));
      fireEvent.keyDown(window, { key: "x" });
      fireEvent.keyUp(window, { key: "x" });
      // Rows 30 to 70 go: the hot spot at y 80 moves up to 40.
      drag([50, 30], [300, 70]);
      await waitFor(() => expect(node()).toHaveAttribute("data-y", "37"));
      fireEvent.click(screen.getByRole("button", { name: "Restore strips" }));
      await waitFor(() => expect(node()).toHaveAttribute("data-y", "77"));

      // A strip over the hot spot takes the pointer with it.
      drag([50, 60], [300, 100]);
      await waitFor(() => expect(node()).toBeNull());
      expect(pointerButton()).toHaveAttribute("aria-pressed", "false");
    });
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

  it("turns and mirrors the line handles with the capture, and bends in capture pixels", async () => {
    const saved = mockEditor();
    await ready();
    const transform = (name: string) => {
      const group = document.querySelector(`[data-konva="Group"][data-name="${name}"]`) as Element;
      return ["data-x", "data-y", "data-rotation", "data-scale-x", "data-scale-y"].map((attr) => group.getAttribute(attr));
    };
    const savedArrow = () => last(saved)?.shapes.find((shape) => shape.id === "a1");
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    // The 400×300 capture turned right: shifted 300 across, a quarter turn.
    expect(transform("oriented")).toEqual(["300", "0", "90", "1", "1"]);
    expect(transform("oriented-handles")).toEqual(transform("oriented"));
    // The handles stay in capture pixels; the group turns them onto the line.
    expect(handleAt("bend")).toEqual([55, 45]);

    fireEvent.click(screen.getByRole("button", { name: "Flip horizontal" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    expect(transform("oriented-handles")).toEqual(transform("oriented"));
    expect(transform("oriented")).toEqual(["0", "0", "270", "-1", "1"]);

    // A dragged handle reports where it is in its group: capture pixels.
    const writes = saved.length;
    dragHandle("bend", [55, 15]);
    await waitFor(() => expect(savedArrow()).toMatchObject({ points: [10, 10, 100, 80], control: [55, -15] }));
    expect(saved).toHaveLength(writes + 1);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(savedArrow()).not.toHaveProperty("control"));
    expect(last(saved)).toMatchObject({ rotation: 90, flipX: true });
  });

  it("bends an arrow from its middle handle, straightens it near the line, and undoes each drag", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    const shaft = () => document.querySelector('[data-id="a1"] [data-path]')?.getAttribute("data-path");
    const savedArrow = () => last(saved)?.shapes.find((shape) => shape.id === "a1");

    // A live drag previews the curve without saving it.
    Object.assign(pointerAt, { x: 55, y: 15 });
    fireEvent.drag(lineHandle("bend"));
    expect(shaft()).toBe("M 10 10 Q 55 -15 100 80");
    expect(handleAt("bend")).toEqual([55, 15]);
    fireEvent.dragEnd(lineHandle("bend"));
    // The curve runs through the handle: control = 2H − (P0 + P2) / 2.
    await waitFor(() => expect(savedArrow()).toMatchObject({ points: [10, 10, 100, 80], control: [55, -15] }));

    // Back within a few pixels of the straight line's middle, it goes straight.
    dragHandle("bend", [57, 47]);
    await waitFor(() => expect(savedArrow()).not.toHaveProperty("control"));
    // The handle is put back on the line, not left under the pointer.
    expect(placed.at).toEqual({ x: 55, y: 45 });
    expect(shaft()).toBe("M 10 10 L 100 80");
    expect(handleAt("bend")).toEqual([55, 45]);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(handleAt("bend")).toEqual([55, 15]);
    expect(shaft()).toBe("M 10 10 Q 55 -15 100 80");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(handleAt("bend")).toEqual([55, 45]);
    expect(shaft()).toBe("M 10 10 L 100 80");
  });

  it("sets a session default using the keyboard and uses it for Arrow and Alt-drag", async () => {
    const saved = mockEditor();
    await ready();
    const user = userEvent.setup();
    const picker = widthButton("Style");
    picker.focus();
    await user.keyboard(" ");
    const dialog = screen.getByRole("dialog", { name: "Arrow style" });
    expect(within(dialog).getAllByRole("button")).toHaveLength(12);
    const classic = within(dialog).getByRole("button", { name: "Classic", pressed: true });
    expect(classic).toHaveFocus();
    fireEvent.keyDown(classic, { key: "Escape" });
    expect(picker).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Arrow style" })).toBeNull();

    await user.keyboard(" ");
    const open = screen.getByRole("button", { name: "Open" });
    await user.keyboard("{ArrowRight}");
    expect(open).toHaveFocus();
    await user.keyboard(" ");
    expect(picker).toHaveFocus();
    drag([20, 40], [180, 70]);
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "arrow", arrowStyle: "open" }));

    fireEvent.click(pressed("Select"));
    drag([40, 100], [180, 130], { altKey: true });
    await waitFor(() => expect(last(saved)?.shapes[5]).toMatchObject({ type: "arrow", arrowStyle: "open" }));
  });

  it("restyles a curve in one undo step and edits an elbow after rotating and flipping the capture", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    fireEvent.click(screen.getByRole("button", { name: "Flip horizontal" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    dragHandle("bend", [55, 15]);
    const savedArrow = () => last(saved)?.shapes.find((shape) => shape.id === "a1");
    await waitFor(() => expect(savedArrow()).toHaveProperty("control", [55, -15]));

    const pick = (name: string) => {
      fireEvent.click(widthButton("Style"));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Arrow style" })).getByRole("button", { name }));
    };
    pick("Outline");
    expect(handleAt("bend")).toEqual([55, 15]);
    await waitFor(() => expect(savedArrow()).toMatchObject({ arrowStyle: "outline", control: [55, -15] }));
    fireEvent.keyDown(window, { ctrlKey: true, key: "z" });
    await waitFor(() => expect(savedArrow()).not.toHaveProperty("arrowStyle"));
    fireEvent.keyDown(window, { ctrlKey: true, key: "y" });
    await waitFor(() => expect(savedArrow()).toHaveProperty("arrowStyle", "outline"));

    pick("Elbow");
    expect(handleAt("bend")).toEqual([55, 45]);
    dragHandle("bend", [80, 110]);
    expect(handleAt("bend")).toEqual([55, 110]);
    expect(handleAt("start")).toEqual([10, 10]);
    expect(handleAt("end")).toEqual([100, 80]);
    await waitFor(() => expect(savedArrow()).toMatchObject({
      arrowStyle: "elbow", elbow: { axis: "y", at: 110 }, points: [10, 10, 100, 80],
      color: "#e5484d", strokeWidth: 4,
    }));
    fireEvent.keyDown(window, { ctrlKey: true, key: "z" });
    expect(handleAt("bend")).toEqual([55, 45]);
    fireEvent.keyDown(window, { ctrlKey: true, key: "y" });
    expect(handleAt("bend")).toEqual([55, 110]);
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

  it("changes the selected text's style", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);
    const styles = within(screen.getByRole("group", { name: "Text style" }));
    const savedText = () => last(saved)?.shapes.find((shape) => shape.id === "t1");
    expect(styles.getByRole("button", { name: "Plain" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(styles.getByRole("button", { name: "Pill" }));
    expect(styles.getByRole("button", { name: "Pill" })).toHaveAttribute("aria-pressed", "true");
    expect(styles.getByRole("button", { name: "Plain" })).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector('[data-konva="Label"][data-id="t1"] [data-text="Click here"]')).toBeInTheDocument();
    await waitFor(() => expect(savedText()).toMatchObject({ background: true }));

    // Outline clears the pill, and draws the text with a contrasting stroke.
    fireEvent.click(styles.getByRole("button", { name: "Outline" }));
    expect(styles.getByRole("button", { name: "Outline" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector('[data-konva="Label"][data-id="t1"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-konva="Text"][data-id="t1"]')).toHaveAttribute("data-stroke", "#ffffff");
    await waitFor(() => expect(savedText()).toMatchObject({ textStyle: "outline" }));
    expect(savedText()).not.toHaveProperty("background");

    fireEvent.click(styles.getByRole("button", { name: "Shadow" }));
    expect(document.querySelector('[data-konva="Text"][data-id="t1"]')).toHaveAttribute("data-shadow");
    expect(document.querySelector('[data-konva="Text"][data-id="t1"]')).not.toHaveAttribute("data-stroke");
    await waitFor(() => expect(savedText()).toMatchObject({ textStyle: "shadow" }));

    // Plain stores neither, so the text matches one saved before text styles.
    fireEvent.click(styles.getByRole("button", { name: "Plain" }));
    await waitFor(() => expect(savedText()).not.toHaveProperty("textStyle"));
    expect(savedText()).not.toHaveProperty("background");
  });

  it("draws a text saved with both a pill and a text style as Pill", async () => {
    mockEditor({
      ...sidecar,
      shapes: [{ id: "t2", type: "text", color: "#0090ff", x: 20, y: 20, text: "Both", fontSize: 24, background: true, textStyle: "outline" }],
    });
    await ready();
    expect(document.querySelector('[data-konva="Label"][data-id="t2"] [data-text="Both"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="t2"]') as Element);
    expect(within(screen.getByRole("group", { name: "Text style" })).getByRole("button", { name: "Pill" })).toHaveAttribute("aria-pressed", "true");
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

  it("adds a dropped image file at its own size, selected, and draws it", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    const saved = mockEditor(sidecar, calls);
    await ready();
    await waitFor(() => expect(dropListener.handler).not.toBeNull());
    dropListener.handler?.({ payload: { type: "over", position: { x: 10, y: 10 } } });
    dropListener.handler?.({ payload: { type: "drop", paths: ["/home/me/before.png"], position: { x: 100, y: 100 } } });

    await waitFor(() => expect(last(saved)?.shapes).toHaveLength(5));
    expect(calls.filter((call) => call.cmd === "editor_add_image_file").map((call) => call.payload)).toEqual([{ path: "/home/me/before.png" }]);
    // The mocked image element is 400×300; the shape sits in front of the others.
    expect(last(saved)?.shapes[4]).toMatchObject({ type: "image", src: "before-1700000000000.png", width: 400, height: 300 });
    const id = last(saved)?.shapes[4].id as string;
    expect(document.querySelector(`[data-konva="Image"][data-id="${id}"]`)).not.toBeNull();
    // Selected: it keeps its ratio from the corners, and Delete removes it.
    expect(anchors()).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => expect(last(saved)?.shapes).toHaveLength(4));
  });

  it("says so when a dropped file cannot be added", async () => {
    mockIPC((cmd) => {
      if (cmd === "editor_add_image_file") throw "the image must be a PNG, JPEG, WebP or GIF image";
      if (cmd === "editor_info") return { path: "/p/originals/shot.png", fileName: "shot.png", annotations: sidecar, scaleFactor: null };
      if (cmd === "editor_image") return new ArrayBuffer(8);
      if (cmd === "get_editor_preferences") return {};
      return null;
    });
    await ready();
    await waitFor(() => expect(dropListener.handler).not.toBeNull());
    dropListener.handler?.({ payload: { type: "drop", paths: ["C:\\Users\\me\\notes.txt"], position: { x: 0, y: 0 } } });
    expect(await screen.findByText(/Could not add notes\.txt/)).toBeInTheDocument();
  });

  it("pastes the clipboard's image just right of the capture and exports the grown canvas", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    const saved = mockEditor({ version: 1, shapes: [], crop: null }, calls);
    await ready();
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    await waitFor(() =>
      expect(last(saved)?.shapes).toEqual([
        expect.objectContaining({ type: "image", src: "pasted-1700000000000.png", x: 400, y: 0, width: 400, height: 300 }),
      ]),
    );
    expect(calls.map((call) => call.cmd)).toContain("editor_add_clipboard_image");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    // The 400×300 capture and the 400×300 image beside it.
    await waitFor(() => expect(last(flattened.calls)).toMatchObject({ crop: null }));
    expect(last(flattened.options)).toMatchObject({ canvas: { x: 0, y: 0, width: 800, height: 300 } });
  });

  describe("side by side", () => {
    /** A second 400×300 screenshot just right of the capture. */
    const beside: Annotations = {
      version: 1,
      shapes: [{ id: "i1", type: "image", x: 400, y: 0, width: 400, height: 300, src: "after.png" }],
      crop: null,
    };
    it("exports both screenshots on the grown canvas", async () => {
      mockEditor(beside);
      await ready();
      // The size label is the canvas, not the capture alone.
      expect(screen.getByText("800×300")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(flattened.calls).toHaveLength(1));
      expect(last(flattened.calls)).toMatchObject({ crop: null, backdrop: null, rotation: 0 });
      expect(last(flattened.options)).toMatchObject({ canvas: { x: 0, y: 0, width: 800, height: 300 } });
    });

    it("pads a backdrop around the whole canvas", async () => {
      const backdrop = { fill: "ocean", padding: 40, radius: 8, shadow: true };
      mockEditor({ ...beside, backdrop });
      await ready();
      expect(screen.getByText("Output 880×380")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(flattened.calls).toHaveLength(1));
      expect(last(flattened.calls)).toMatchObject({ crop: null, backdrop });
      // The whole canvas goes out, framed whole.
      expect(last(flattened.options)).toMatchObject({ canvas: { x: 0, y: 0, width: 800, height: 300 }, borders: null });
    });

    it("casts the preview's shadow from the whole content layer, annotations included, as the export does", async () => {
      const backdrop = { fill: "ocean", padding: 40, radius: 8, shadow: true };
      // A shorter image beside the capture leaves a clear corner, with an arrow drawn into it.
      const arrow: Shape = { id: "a9", type: "arrow", points: [450, 250, 700, 280], color: "#e5484d", strokeWidth: 4 };
      mockEditor({ ...beside, shapes: [{ id: "i1", type: "image", x: 400, y: 0, width: 400, height: 200, src: "after.png" }, arrow], backdrop });
      await ready();
      // The silhouette comes from the content layer (where the arrow is drawn), over the exported 800×300 area at screen resolution.
      await waitFor(() => expect(layerRenders.areas.length).toBeGreaterThan(0));
      const area = layerRenders.areas[layerRenders.areas.length - 1];
      expect(area.pixelRatio).toBe(1);
      expect(area.width / area.height).toBeCloseTo(800 / 300);
    });

    it("keeps the plain shadow plate for a capture with nothing past it", async () => {
      const arrow: Shape = { id: "a9", type: "arrow", points: [50, 50, 300, 280], color: "#e5484d", strokeWidth: 4 };
      mockEditor({ version: 1, shapes: [arrow], crop: null, backdrop: { fill: "ocean", padding: 40, radius: 8, shadow: true } });
      await ready();
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The capture is opaque all over: no silhouette is rendered from the content layer.
      expect(layerRenders.areas).toEqual([]);
    });

    it("turns the whole canvas", async () => {
      mockEditor({ ...beside, rotation: 90 });
      await ready();
      // Turned a quarter, the pair shows one above the other.
      expect(screen.getByText("Output 300×800")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(flattened.calls).toHaveLength(1));
      expect(last(flattened.calls)).toMatchObject({ crop: null, rotation: 90 });
      expect(last(flattened.options)).toMatchObject({ canvas: { x: 0, y: 0, width: 800, height: 300 } });
    });

    it("crops across both screenshots", async () => {
      const saved = mockEditor(beside);
      await ready();
      fireEvent.click(pressed("Crop"));
      // From inside the capture to well inside the image beside it.
      drag([350, 0], [700, 300]);
      await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 350, y: 0, width: 350, height: 300 }));
      expect(screen.getByText("Crop 350×300")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(flattened.calls).toHaveLength(1));
      expect(last(flattened.calls)).toMatchObject({ crop: { x: 350, y: 0, width: 350, height: 300 } });
    });

    it("crops past a turned capture up to the canvas edge", async () => {
      const saved = mockEditor({ ...beside, rotation: 90 });
      await ready();
      fireEvent.click(pressed("Crop"));
      // On show the canvas is 300×800; the drag runs past its bottom and is held to it.
      drag([0, 200], [300, 900]);
      // The bottom 600 on show is the capture's right 200 and the image beside it.
      await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 200, y: 0, width: 600, height: 300 }));
    });
  });

  it("reads a saved image from the capture's assets folder", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    mockEditor({ version: 1, shapes: [{ id: "i1", type: "image", x: -50, y: 0, width: 40, height: 30, src: "kept.png" }], crop: null }, calls);
    await ready();
    await waitFor(() => expect(document.querySelector('[data-konva="Image"][data-id="i1"]')).not.toBeNull());
    expect(calls.filter((call) => call.cmd === "editor_asset_image").map((call) => call.payload)).toEqual([{ name: "kept.png" }]);
  });

  it("waits for a saved cursor stamp to appear on the layer before copying", async () => {
    let finish: (() => void) | undefined;
    vi.stubGlobal("Image", class extends LoadedImage {
      override set src(url: string) {
        if (url === "blob:capture") super.src = url;
        else finish = () => this.onload?.();
      }
    });
    const calls: { cmd: string; payload: unknown }[] = [];
    mockEditor({ version: 1, shapes: [{ id: "cursor", type: "stamp", name: "cursor-text", x: 50, y: 50, size: 32 }], crop: null }, calls);
    await ready();
    await waitFor(() => expect(finish).toBeDefined());
    const selector = '[data-id="cursor"] [data-konva="Image"]';
    const snapshot = vi.spyOn(await import("./flatten"), "flatten").mockImplementationOnce(async () => {
      expect(document.querySelector(selector)).not.toBeNull();
      return FLATTENED;
    });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => {});
    expect(snapshot).not.toHaveBeenCalled();
    expect(document.querySelector(selector)).toBeNull();
    await act(async () => finish?.());
    await waitFor(() => expect(calls.some(({ cmd }) => cmd === "editor_copy")).toBe(true));
    expect(snapshot).toHaveBeenCalledOnce();
    snapshot.mockRestore();
  });

  it("waits for an added image still being read before copying and closing", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    let finishRead: (bytes: ArrayBuffer) => void = () => undefined;
    const asset = new Promise<ArrayBuffer>((resolve) => {
      finishRead = resolve;
    });
    mockWindows("editor-1");
    mockEditor({ version: 1, shapes: [{ id: "i1", type: "image", x: 400, y: 0, width: 40, height: 30, src: "big.png" }], crop: null }, calls, { asset });
    await ready();
    await waitFor(() => expect(calls.map((call) => call.cmd)).toContain("editor_asset_image"));

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.map((call) => call.cmd)).not.toContain("editor_copy");

    finishRead(new ArrayBuffer(4));
    await waitFor(() => expect(calls.map((call) => call.cmd)).toEqual(["editor_asset_image", "editor_copy", "plugin:window|close"]));
    // By then the image is drawn, and the output takes it in.
    expect(document.querySelector('[data-konva="Image"][data-id="i1"]')).not.toBeNull();
    expect(last(flattened.calls)).toMatchObject({ crop: null });
    expect(last(flattened.options)).toMatchObject({ canvas: { x: 0, y: 0, width: 440, height: 300 } });
  });

  it("copies without an added image whose file is gone", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    const gone = Promise.reject(new Error("the added image is missing"));
    // Handled here so the test runner does not flag it before the editor reads it.
    gone.catch(() => undefined);
    mockEditor({ version: 1, shapes: [{ id: "i1", type: "image", x: 0, y: 0, width: 40, height: 30, src: "gone.png" }], crop: null }, calls, {
      asset: gone,
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(calls.map((call) => call.cmd)).toContain("editor_copy"));
  });

  it("brings the selected annotation forward and sends it backward", async () => {
    const saved = mockEditor();
    await ready();
    const bar = within(screen.getByRole("toolbar", { name: "Style and actions" }));
    expect(bar.getByRole("button", { name: "Bring forward" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);

    fireEvent.click(bar.getByRole("button", { name: "Bring forward" }));
    await waitFor(() => expect(last(saved)?.shapes.map((shape) => shape.id)).toEqual(["a1", "s1", "t1", "s2"]));
    fireEvent.keyDown(window, { key: "]", code: "BracketRight", ctrlKey: true, altKey: true });
    await waitFor(() => expect(last(saved)?.shapes.map((shape) => shape.id)).toEqual(["a1", "s1", "s2", "t1"]));
    // In front of everything: only Send backward is left.
    expect(bar.getByRole("button", { name: "Bring forward" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true });
    fireEvent.click(bar.getByRole("button", { name: "Send backward" }));
    await waitFor(() => expect(last(saved)?.shapes.map((shape) => shape.id)).toEqual(["a1", "t1", "s1", "s2"]));
    // Ordering does not turn the capture.
    expect(last(saved)?.rotation).toBeUndefined();
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

  it("nudges the selected shape the way it shows once turned or flipped", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Rotate right" }));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="s1"]') as Element);
    // Turned right, right on show is up the capture.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(last(saved)?.shapes.find((shape) => shape.id === "s1")).toMatchObject({ x: 50, y: 49 }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate left" }));
    fireEvent.click(screen.getByRole("button", { name: "Flip horizontal" }));
    // Mirrored, left on show is right on the capture.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(last(saved)?.shapes.find((shape) => shape.id === "s1")).toMatchObject({ x: 51, y: 49 }));
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

  // Ninety clicks, each re-rendering the whole editor, outlast the default timeout under jsdom on a busy machine.
  it("opens a 2x capture at its on-screen size, calls it 100%, and zooms from 5% to 1600% of it", async () => {
    // 400 × 300 image pixels at 2x were 200 × 150 points on screen, which fit the 800 × 600 canvas.
    mockEditor(sidecar, [], { scaleFactor: 2 });
    await ready();
    const zoom = () => screen.getByLabelText("Zoom").textContent;
    const scale = () => Number(stage().getAttribute("data-scale-x"));
    await waitFor(() => expect(zoom()).toBe("100%"));
    expect(scale()).toBe(0.5);

    for (let i = 0; i < 30; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoom()).toBe("1600%");
    expect(scale()).toBe(8);
    fireEvent.wheel(stage(), { deltaY: -100 });
    expect(zoom()).toBe("1600%");

    for (let i = 0; i < 60; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(zoom()).toBe("5%");
    expect(scale()).toBeCloseTo(0.025);
    fireEvent.wheel(stage(), { deltaY: 100 });
    expect(zoom()).toBe("5%");

    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(zoom()).toBe("100%");
    expect(scale()).toBe(0.5);
  }, 20_000);

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
    expect(within(screen.getByRole("group", { name: "Text style" })).getByRole("button", { name: "Pill" })).toHaveAttribute("aria-pressed", "true");
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

  it("remembers the text style picked", async () => {
    const saved: EditorPreferences[] = [];
    mockEditor(sidecar, [], { stored: {}, saved });
    await ready();
    fireEvent.keyDown(window, { key: "t" });
    fireEvent.click(within(screen.getByRole("group", { name: "Text style" })).getByRole("button", { name: "Outline" }));
    await waitFor(() => expect(last(saved)).toMatchObject({ textBackground: false, textStyle: "outline" }));
  });

  it("opens with the text style saved last time", async () => {
    mockEditor(sidecar, [], { stored: { tool: "text", textStyle: "shadow" } });
    await ready();
    await waitFor(() =>
      expect(within(screen.getByRole("group", { name: "Text style" })).getByRole("button", { name: "Shadow" })).toHaveAttribute("aria-pressed", "true"),
    );
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
    expect(flattened.calls).toEqual([{ crop: null, backdrop, rotation: 0, flipX: false, flipY: false, scale: 1 }]);
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

  it("saves the colour on show as a favourite after the swatches, and removes one on right-click", async () => {
    const favorites: string[][] = [];
    const saved: EditorPreferences[] = [];
    mockEditor(sidecar, [], { stored: { favoriteColors: ["#ff8800"] }, favorites, saved });
    await ready();
    const colours = () => within(screen.getByRole("group", { name: "Colour" }));
    const favourite = await waitFor(() => colours().getByRole("button", { name: "Favourite colour #ff8800" }));
    const save = colours().getByRole("button", { name: "Save colour as favourite" });
    // A built-in colour is not saved again.
    expect(save).toBeDisabled();

    fireEvent.click(favourite);
    expect(favourite).toHaveAttribute("aria-pressed", "true");
    // Saved already.
    expect(save).toBeDisabled();

    fireEvent.change(colours().getByLabelText("Custom colour"), { target: { value: "#123abc" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(colours().getByRole("button", { name: "Favourite colour #123abc" })).toHaveAttribute("aria-pressed", "true");
    expect(save).toBeDisabled();
    await waitFor(() => expect(favorites).toEqual([["#ff8800", "#123abc"]]));

    fireEvent.contextMenu(colours().getByRole("button", { name: "Favourite colour #ff8800" }));
    expect(colours().queryByRole("button", { name: "Favourite colour #ff8800" })).not.toBeInTheDocument();
    await waitFor(() => expect(last(favorites)).toEqual(["#123abc"]));
    // The editor's own saves leave the favourites to their command.
    await waitFor(() => expect(last(saved)).toMatchObject({ color: "#123abc" }));
    for (const preferences of saved) expect(preferences).not.toHaveProperty("favoriteColors");
    // The keys still pick the built-in swatches.
    fireEvent.keyDown(window, { key: "1" });
    expect(colours().getByRole("button", { name: "Colour #e5484d" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps at most 8 favourites", async () => {
    const full = Array.from({ length: 8 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
    mockEditor(sidecar, [], { stored: { color: "#123abc", favoriteColors: full } });
    await ready();
    await waitFor(() => expect(screen.getByRole("button", { name: "Favourite colour #000007" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save colour as favourite" })).toBeDisabled();
  });

  describe("eyedropper", () => {
    /** The canvas reads every pixel as #1a2b3c (jsdom has no canvas). */
    function mockCanvas() {
      const context = {
        imageSmoothingEnabled: true,
        fillStyle: "",
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([26, 43, 60, 255]) })),
      };
      canvas.spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
      return context;
    }
    const canvas: { spy: { mockRestore: () => void } | null } = { spy: null };

    afterEach(() => {
      canvas.spy?.mockRestore();
      canvas.spy = null;
    });

    const dropper = () => screen.getByRole("button", { name: "Pick colour from capture" });
    const moveTo = (at: [number, number]) => {
      Object.assign(pointerAt, { x: at[0], y: at[1] });
      fireEvent.mouseMove(stage());
    };
    const clickAt = (at: [number, number]) => {
      Object.assign(pointerAt, { x: at[0], y: at[1] });
      fireEvent.mouseDown(stage());
      fireEvent.mouseUp(stage());
    };

    it("picks a colour from the capture with a loupe, then goes back to the tool", async () => {
      mockCanvas();
      const saved = mockEditor();
      await ready();
      fireEvent.click(pressed("Rectangle"));
      fireEvent.click(dropper());
      expect(dropper()).toHaveAttribute("aria-pressed", "true");

      moveTo([120.4, 80.6]);
      expect(screen.getByTestId("overlay-loupe")).toBeInTheDocument();
      expect(screen.getByTestId("overlay-position")).toHaveTextContent("120, 80");
      // Off the capture the loupe goes, and a click there takes nothing.
      moveTo([500, 80]);
      expect(screen.queryByTestId("overlay-loupe")).not.toBeInTheDocument();
      clickAt([500, 80]);
      expect(dropper()).toHaveAttribute("aria-pressed", "true");

      clickAt([120, 80]);
      expect(dropper()).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByTestId("overlay-loupe")).not.toBeInTheDocument();
      expect(pressed("Rectangle")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByLabelText("Custom colour")).toHaveValue("#1a2b3c");
      // The click picked; it drew nothing.
      expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);

      // The next shape is drawn in the picked colour.
      drag([20, 20], [80, 60]);
      await waitFor(() => expect(last(last(saved)?.shapes ?? [])).toMatchObject({ type: "rect", color: "#1a2b3c" }));
    });

    it("recolours the selected shape with the picked colour, keeping it selected", async () => {
      mockCanvas();
      const saved = mockEditor();
      await ready();
      fireEvent.click(pressed("Select"));
      fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);
      fireEvent.keyDown(window, { key: "i" });
      expect(dropper()).toHaveAttribute("aria-pressed", "true");

      clickAt([300, 150]);
      await waitFor(() => expect(last(saved)?.shapes.find((shape) => shape.id === "t1")).toMatchObject({ color: "#1a2b3c" }));
      expect(pressed("Select")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });

    it("cancels on Esc, keeping the colour and the selection", async () => {
      mockCanvas();
      mockEditor();
      await ready();
      fireEvent.click(pressed("Select"));
      fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
      fireEvent.keyDown(window, { key: "i" });
      moveTo([120, 80]);
      expect(screen.getByTestId("overlay-loupe")).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(dropper()).toHaveAttribute("aria-pressed", "false");
      expect(screen.queryByTestId("overlay-loupe")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Colour #e5484d" })).toHaveAttribute("aria-pressed", "true");
      // With the eyedropper away, a click no longer picks.
      clickAt([120, 80]);
      expect(screen.getByLabelText("Custom colour")).toHaveValue("#e5484d");
    });

    it("puts the eyedropper away when a tool is picked, or I is pressed again", async () => {
      mockEditor();
      await ready();
      fireEvent.keyDown(window, { key: "i" });
      expect(dropper()).toHaveAttribute("aria-pressed", "true");
      fireEvent.keyDown(window, { key: "i" });
      expect(dropper()).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(dropper());
      fireEvent.click(pressed("Arrow"));
      expect(dropper()).toHaveAttribute("aria-pressed", "false");
    });
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
    expect(wheel.getAllByRole("menuitemradio")).toHaveLength(17);
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

  /** A line of words 10px per character and 5px apart, at `y`. */
  const wordLine = (text: string, y: number): OcrLine => {
    let x = 10;
    const words = text.split(" ").map((word) => {
      const box = { text: word, x, y, width: word.length * 10, height: 12 };
      x += box.width + 5;
      return box;
    });
    return { text, x: 10, y, width: x - 15, height: 12, words };
  };
  const PRIVATE_WORDS = [wordLine("Mail jane@example.com", 20), wordLine("Call +1 555 010 0199", 50)];
  const FACE = { x: 300, y: 100, width: 60, height: 70 };
  const privateToggle = () =>
    within(screen.getByRole("toolbar", { name: "Style and actions" })).getByRole("button", { name: "Blur private details" });
  const blurs = (doc?: Annotations) => (doc?.shapes ?? []).filter((shape) => shape.type === "blur");

  it("blurs every private detail and face as one undo step, and removes its blurs when turned off", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    const saved = mockEditor({ version: 1, shapes: [], crop: null }, calls, { words: PRIVATE_WORDS, faces: [FACE] });
    await ready();
    const toggle = privateToggle();
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);

    await waitFor(() => expect(blurs(last(saved))).toHaveLength(3));
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(blurs(last(saved))).toEqual([
      // The email, the phone number's four words as one rect, then the face, each padded by 2px.
      expect.objectContaining({ x: 53, y: 18, width: 164, height: 16 }),
      expect.objectContaining({ x: 53, y: 48, width: 139, height: 16 }),
      expect.objectContaining({ x: 298, y: 98, width: 64, height: 74 }),
    ]);
    expect(calls.map((call) => call.cmd).sort()).toEqual(["editor_faces", "editor_words"]);

    // One undo removes them all.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(blurs(last(saved))).toHaveLength(0));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(blurs(last(saved))).toHaveLength(3));

    // Off removes the blurs it added, keeping a blur drawn by hand.
    fireEvent.click(pressed("Blur"));
    drag([10, 200], [60, 240]);
    await waitFor(() => expect(blurs(last(saved))).toHaveLength(4));
    fireEvent.click(toggle);
    await waitFor(() => expect(blurs(last(saved))).toEqual([expect.objectContaining({ x: 10, y: 200, width: 50, height: 40 })]));
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    // On again adds them once more, never twice, and reads the words only once.
    fireEvent.click(toggle);
    await waitFor(() => expect(blurs(last(saved))).toHaveLength(4));
    expect(calls.filter((call) => call.cmd === "editor_words")).toHaveLength(1);
  });

  it("shows the toggle busy while finding, then notes when nothing was found", async () => {
    let answer: (lines: OcrLine[]) => void = () => {};
    const words = new Promise<OcrLine[]>((resolve) => (answer = resolve));
    const saved = mockEditor({ version: 1, shapes: [], crop: null }, [], { words });
    await ready();
    // Shown whatever the tool.
    fireEvent.click(pressed("Arrow"));
    fireEvent.click(privateToggle());

    await waitFor(() => expect(privateToggle()).toHaveAttribute("aria-busy", "true"));
    expect(privateToggle()).toBeDisabled();
    answer([wordLine("Order pineapple today", 20)]);

    expect(await screen.findByText("No private details found")).toBeInTheDocument();
    expect(privateToggle()).toHaveAttribute("aria-busy", "false");
    expect(privateToggle()).toBeEnabled();
    expect(privateToggle()).toHaveAttribute("aria-pressed", "false");
    expect(blurs(last(saved))).toHaveLength(0);
  });

  it("says why Blur private details failed", async () => {
    mockEditor({ version: 1, shapes: [], crop: null }, [], { words: new Error("no models") });
    await ready();
    fireEvent.click(privateToggle());
    expect(await screen.findByText("Blur private details failed: no models")).toBeInTheDocument();
    expect(privateToggle()).toHaveAttribute("aria-pressed", "false");
  });

  it("blurs a clicked word and every other place it appears with the Blur tool, as one undo step", async () => {
    const lines = [wordLine("Order pineapple today", 20), wordLine("Pineapple, again", 60), wordLine("pineapples", 100)];
    const saved = mockEditor({ version: 1, shapes: [], crop: null }, [], { words: lines });
    await ready();
    fireEvent.click(pressed("Blur"));
    // A click, not a drag, on "pineapple".
    drag([100, 25], [100, 25]);

    await waitFor(() => expect(blurs(last(saved))).toHaveLength(2));
    expect(blurs(last(saved))).toEqual([
      expect.objectContaining({ x: 63, y: 18, width: 94, height: 16 }),
      expect.objectContaining({ x: 8, y: 58, width: 104, height: 16 }),
    ]);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(blurs(last(saved))).toHaveLength(0));

    // A click on no word adds nothing; a drag still draws a blur.
    drag([390, 290], [390, 290]);
    drag([200, 150], [260, 190]);
    await waitFor(() => expect(blurs(last(saved))).toEqual([expect.objectContaining({ x: 200, y: 150, width: 60, height: 40 })]));
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

  it("balances a capture with an empty margin, in the preview and the pinned image", async () => {
    const calls: { cmd: string; payload: unknown }[] = [];
    const backdrop = { fill: "ocean", padding: 20, radius: 12, shadow: true };
    const saved = mockEditor({ ...sidecar, backdrop }, calls);
    await ready();
    const panel = backdropPanel();
    const balance = panel.getByRole("checkbox", { name: "Balance" });
    expect(balance).not.toBeChecked();
    expect(screen.getByText("Output 440×340")).toBeInTheDocument();

    fireEvent.click(balance);
    await waitFor(() => expect(last(saved)?.backdrop).toEqual({ ...backdrop, balance: true }));
    expect(balance).toBeChecked();
    // 20px of padding a side cannot absorb an 80px margin, so the output grows to 80px on the left and none on the right.
    expect(screen.getByText("Output 480×340")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(calls.map((call) => call.cmd)).toContain("editor_pin"));
    expect(flattened.calls).toEqual([{ crop: null, backdrop: { ...backdrop, balance: true }, rotation: 0, flipX: false, flipY: false, scale: 1 }]);
    expect(flattened.options).toEqual([expect.objectContaining({ borders: MEASURED_BORDERS })]);

    // Off again drops the field, as older sidecars have it.
    fireEvent.click(balance);
    await waitFor(() => expect(last(saved)?.backdrop).toEqual(backdrop));
    expect(screen.getByText("Output 440×340")).toBeInTheDocument();
  });

  it("measures Balance's borders on the crop as it is turned and mirrored", async () => {
    const crop = { x: 10, y: 20, width: 200, height: 100 };
    const backdrop = { fill: "ocean", padding: 20, radius: 12, shadow: true, balance: true };
    mockEditor({ ...sidecar, crop, backdrop });
    await ready();
    const size = { width: 400, height: 300 };
    const measuredWith = () => last(flattened.measured)?.slice(1);
    await waitFor(() => expect(measuredWith()).toEqual([crop, size, { rotation: 0, flipX: false, flipY: false }]));
    expect(last(flattened.measured)?.[0]).toBeInstanceOf(LoadedImage);
    // The 80px margin cannot fit in 20px a side: 200 + 80 by 100 + 40.
    expect(screen.getByText("Output 280×140")).toBeInTheDocument();

    const bar = within(screen.getByRole("toolbar", { name: "Style and actions" }));
    let count = flattened.measured.length;
    fireEvent.click(bar.getByRole("button", { name: "Rotate right" }));
    await waitFor(() => expect(measuredWith()).toEqual([crop, size, { rotation: 90, flipX: false, flipY: false }]));
    expect(flattened.measured.length).toBeGreaterThan(count);
    // Turned, the crop shows 100 by 200, and the margin is measured on its new right side.
    expect(screen.getByText("Output 180×240")).toBeInTheDocument();

    count = flattened.measured.length;
    fireEvent.click(bar.getByRole("button", { name: "Flip horizontal" }));
    await waitFor(() => expect(measuredWith()).toEqual([crop, size, { rotation: 90, flipX: true, flipY: false }]));
    expect(flattened.measured.length).toBeGreaterThan(count);
  });

  it("disables Balance while the backdrop is off", async () => {
    mockEditor();
    await ready();
    expect(backdropPanel().getByRole("checkbox", { name: "Balance" })).toBeDisabled();
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

  it("offers crop ratios with the Crop tool and reshapes the crop to the one picked", async () => {
    const saved = mockEditor({ ...sidecar, crop: { x: 0, y: 0, width: 320, height: 240 } });
    await ready();
    expect(screen.queryByRole("group", { name: "Crop ratio" })).not.toBeInTheDocument();

    fireEvent.click(pressed("Crop"));
    const ratios = within(screen.getByRole("group", { name: "Crop ratio" }));
    expect(ratios.getAllByRole("button").map((button) => button.textContent)).toEqual(["Free", "Original", "16:9", "4:3", "1:1", "9:16"]);
    expect(ratios.getByRole("button", { name: "Free" })).toHaveAttribute("aria-pressed", "true");
    // Crop has no colour: the picker takes the swatches' place.
    expect(screen.queryByRole("group", { name: "Colour" })).not.toBeInTheDocument();

    // The largest 16:9 box inside the crop, centred.
    fireEvent.click(ratios.getByRole("button", { name: "16:9" }));
    expect(ratios.getByRole("button", { name: "16:9" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Crop 320×180")).toBeInTheDocument();
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 0, y: 30, width: 320, height: 180 }));

    // One change: a single undo brings the old crop back.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.getByText("Crop 320×240")).toBeInTheDocument();

    // Original is the capture's own 4:3, which this crop already has.
    fireEvent.click(ratios.getByRole("button", { name: "Original" }));
    expect(screen.getByText("Crop 320×240")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();

    // Free leaves the crop alone.
    fireEvent.click(ratios.getByRole("button", { name: "Free" }));
    expect(screen.getByText("Crop 320×240")).toBeInTheDocument();
    fireEvent.click(pressed("Arrow"));
    expect(screen.queryByRole("group", { name: "Crop ratio" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Colour" })).toBeInTheDocument();
  });

  it("holds a crop drag to the picked ratio, and Shift squares a Free crop", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(pressed("Crop"));
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    drag([10, 10], [110, 60]);
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 10, y: 10, width: 100, height: 100 }));

    // 16:9 shrinks to fit: only 100px are left below the start.
    fireEvent.click(screen.getByRole("button", { name: "16:9" }));
    drag([0, 200], [400, 300]);
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 0, y: 200, width: 178, height: 100 }));

    fireEvent.click(screen.getByRole("button", { name: "Free" }));
    drag([20, 20], [70, 120], { shiftKey: true });
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 20, y: 20, width: 100, height: 100 }));
    drag([0, 0], [50, 20]);
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 0, y: 0, width: 50, height: 20 }));
  });

  it("crops a turned capture as it shows", async () => {
    // The 400×300 capture, turned a quarter, shows 300×400; the stage reports the pointer on show.
    const saved = mockEditor({ ...sidecar, rotation: 90 });
    await ready();
    fireEvent.click(pressed("Crop"));
    fireEvent.click(screen.getByRole("button", { name: "16:9" }));
    drag([0, 0], [160, 10]);
    // 16:9 on show is 9:16 in capture pixels.
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 0, y: 140, width: 90, height: 160 }));
    expect(screen.getByText("Crop 160×90")).toBeInTheDocument();
    expect(document.querySelector('[data-name="crop-box"]')).toHaveAttribute("data-draggable", "true");

    // Reshaping fits the crop as it shows, too.
    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 0, y: 175, width: 90, height: 90 }));
    expect(screen.getByText("Crop 90×90")).toBeInTheDocument();
  });

  it("moves the crop on a plain press inside it, and draws over it with Ctrl", async () => {
    const saved = mockEditor({ ...sidecar, crop: { x: 0, y: 0, width: 320, height: 240 } });
    await ready();
    fireEvent.click(pressed("Crop"));
    const cropBox = document.querySelector('[data-name="crop-box"]') as Element;

    // A plain press is the crop's own drag: no new crop is started.
    Object.assign(pointerAt, { x: 10, y: 10 });
    fireEvent.mouseDown(cropBox);
    Object.assign(pointerAt, { x: 110, y: 60 });
    fireEvent.mouseMove(stage());
    fireEvent.mouseUp(stage());
    expect(screen.getByText("Crop 320×240")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

    // Ctrl still draws a rectangle, and the crop stays where it was.
    Object.assign(pointerAt, { x: 10, y: 10 });
    fireEvent.mouseDown(cropBox, { ctrlKey: true });
    Object.assign(pointerAt, { x: 110, y: 60 });
    fireEvent.mouseMove(stage(), { ctrlKey: true });
    fireEvent.mouseUp(stage(), { ctrlKey: true });
    await waitFor(() => expect(last(saved)?.shapes).toHaveLength(5));
    expect(last(saved)?.shapes[4]).toMatchObject({ type: "rect", x: 10, y: 10, width: 100, height: 50 });
    expect(last(saved)?.crop).toEqual({ x: 0, y: 0, width: 320, height: 240 });

    // ⌥ over the crop is still the crop's own (unsnapped) drag: no arrow, no new crop.
    Object.assign(pointerAt, { x: 10, y: 10 });
    fireEvent.mouseDown(cropBox, { altKey: true });
    Object.assign(pointerAt, { x: 110, y: 60 });
    fireEvent.mouseMove(stage(), { altKey: true });
    fireEvent.mouseUp(stage(), { altKey: true });
    expect(screen.getByText("Crop 320×240")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 50));
    expect(last(saved)?.shapes).toHaveLength(5);
  });

  it("snaps a crop drag to the image borders, and crops without snapping while ⌥ is held", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(pressed("Crop"));
    drag([3, 3], [397, 150]);
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 0, y: 0, width: 400, height: 150 }));

    // ⌥ no longer draws an arrow with the Crop tool.
    drag([3, 3], [397, 150], { altKey: true });
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 3, y: 3, width: 394, height: 147 }));
    expect(last(saved)?.shapes).toHaveLength(4);
    expect(pressed("Crop")).toHaveAttribute("aria-pressed", "true");
  });

  it("snaps a crop to the borders as the capture shows when it is turned 90°", async () => {
    // 400×300 turned right shows 300 wide and 400 tall.
    const saved = mockEditor({ ...sidecar, rotation: 90 });
    await ready();
    fireEvent.click(pressed("Crop"));
    drag([3, 3], [297, 396]);
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 0, y: 0, width: 400, height: 300 }));
    drag([3, 3], [297, 396], { altKey: true });
    await waitFor(() => expect(last(saved)?.crop).toEqual({ x: 3, y: 3, width: 393, height: 294 }));
  });

  it("still draws a rectangle on Ctrl-drag with the Crop tool, leaving the crop alone", async () => {
    const saved = mockEditor({ ...sidecar, crop: { x: 0, y: 0, width: 320, height: 240 } });
    await ready();
    fireEvent.click(pressed("Crop"));
    drag([10, 10], [80, 60], { ctrlKey: true });
    await waitFor(() => expect(last(saved)?.shapes[4]).toMatchObject({ type: "rect", x: 10, y: 10, width: 70, height: 50 }));
    expect(last(saved)?.crop).toEqual({ x: 0, y: 0, width: 320, height: 240 });
    expect(pressed("Crop")).toHaveAttribute("aria-pressed", "true");
  });

  it("gives the crop move and resize handles with the Crop tool, corners only with a ratio", async () => {
    mockEditor({ ...sidecar, crop: { x: 0, y: 0, width: 320, height: 240 } });
    await ready();
    const cropBox = () => document.querySelector('[data-name="crop-box"]');
    const cropHandles = () => document.querySelector('[data-konva="Transformer"][data-name="crop-handles"]');
    expect(cropBox()).toHaveAttribute("data-draggable", "false");
    expect(cropHandles()).not.toBeInTheDocument();

    fireEvent.click(pressed("Crop"));
    expect(cropBox()).toHaveAttribute("data-draggable", "true");
    expect(cropHandles()?.getAttribute("data-anchors")?.split(" ")).toContain("middle-left");

    fireEvent.click(screen.getByRole("button", { name: "4:3" }));
    expect(cropHandles()?.getAttribute("data-anchors")?.split(" ")).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);

    fireEvent.click(pressed("Arrow"));
    expect(cropHandles()).not.toBeInTheDocument();
  });

  describe("callouts", () => {
    const withCallout: Annotations = {
      ...sidecar,
      shapes: [...sidecar.shapes, { id: "c1", type: "callout", color: "#e5484d", x: 100, y: 50, text: "Look", fontSize: 24, tail: { x: 40, y: 120 } }],
    };
    const callout = (saved: Annotations[]) => last(saved)?.shapes.find((shape) => shape.id === "c1");
    /** Types into the open text box and presses Enter. */
    const type = (value: string) => {
      const input = screen.getByRole("textbox", { name: "Text" });
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
    };

    it("offers Callout after Text, on K", async () => {
      mockEditor();
      await ready();
      const rail = within(screen.getByRole("toolbar", { name: "Annotation tools" }));
      const names = rail.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
      expect(names.indexOf("Callout")).toBe(names.indexOf("Text") + 1);
      expect(rail.getByRole("button", { name: "Callout" })).toHaveAttribute("title", "Callout (K)");
      fireEvent.keyDown(window, { key: "k" });
      expect(pressed("Callout")).toHaveAttribute("aria-pressed", "true");
      expect(widthButton("Text size")).toHaveTextContent("30px");
      expect(screen.getByRole("button", { name: "Text background" })).toHaveAttribute("aria-pressed", "false");
    });

    it("points the tail where the drag starts and puts the bubble where it ends", async () => {
      const saved = mockEditor({ version: 1, shapes: [], crop: null });
      await ready();
      fireEvent.keyDown(window, { key: "k" });
      drag([60, 200], [150, 80]);
      // While typing, a line shows where the tail will go.
      expect(document.querySelector('[data-name="callout-preview"]')).toBeInTheDocument();
      type("Save here");
      await waitFor(() =>
        expect(last(saved)?.shapes[0]).toMatchObject({ type: "callout", x: 150, y: 80, text: "Save here", fontSize: 30, tail: { x: 60, y: 200 } }),
      );
      expect(last(saved)?.shapes[0]).not.toHaveProperty("background");
      expect(document.querySelector('[data-name="callout-preview"]')).not.toBeInTheDocument();
      expect(document.querySelector('[data-name="callout-bubble"]')).toBeInTheDocument();
      expect(document.querySelector('[data-text="Save here"]')).toBeInTheDocument();
      // The new callout is selected, its tip ready to drag.
      expect(handleAt("tail")).toEqual([60, 200]);
    });

    it("gives a plain click a tail below and left of the bubble", async () => {
      const saved = mockEditor({ version: 1, shapes: [], crop: null });
      await ready();
      fireEvent.keyDown(window, { key: "k" });
      drag([200, 100], [200, 100]);
      type("Note");
      await waitFor(() => expect(last(saved)?.shapes[0]).toMatchObject({ type: "callout", x: 200, y: 100, tail: { x: 170, y: 175 } }));
    });

    it("adds nothing when the text is left empty", async () => {
      mockEditor({ version: 1, shapes: [], crop: null });
      await ready();
      fireEvent.keyDown(window, { key: "k" });
      drag([60, 200], [150, 80]);
      type("  ");
      expect(screen.queryByRole("textbox", { name: "Text" })).not.toBeInTheDocument();
      expect(document.querySelector('[data-name="callout-bubble"]')).not.toBeInTheDocument();
      expect(document.querySelector('[data-name="callout-preview"]')).not.toBeInTheDocument();
      expect(shapeIds()).toEqual([]);
    });

    it("edits the text on double-click, and clearing it deletes the callout", async () => {
      const saved = mockEditor(withCallout);
      await ready();
      fireEvent.doubleClick(document.querySelector('[data-id="c1"]') as Element);
      expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("Look");
      type("Look again");
      await waitFor(() => expect(callout(saved)).toMatchObject({ text: "Look again", x: 100, y: 50, tail: { x: 40, y: 120 } }));
      fireEvent.doubleClick(document.querySelector('[data-id="c1"]') as Element);
      type("");
      await waitFor(() => expect(last(saved)?.shapes.map((shape) => shape.id)).not.toContain("c1"));
    });

    it("moves the tip from its handle as one undo step", async () => {
      const saved = mockEditor(withCallout);
      await ready();
      expect(lineHandle("tail")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.mouseDown(document.querySelector('[data-id="c1"]') as Element);
      expect(handleAt("tail")).toEqual([40, 120]);
      dragHandle("tail", [10, 260]);
      await waitFor(() => expect(callout(saved)).toMatchObject({ x: 100, y: 50, tail: { x: 10, y: 260 } }));
      expect(handleAt("tail")).toEqual([10, 260]);
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(callout(saved)).toMatchObject({ tail: { x: 40, y: 120 } }));
    });

    it("moves the bubble and tip together, the handle following the drag", async () => {
      const saved = mockEditor(withCallout);
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      const node = document.querySelector('[data-id="c1"]') as Element;
      fireEvent.mouseDown(node);
      Object.assign(pointerAt, { x: 130, y: 60 });
      fireEvent(node, new MouseEvent("drag", { bubbles: true }));
      expect(handleAt("tail")).toEqual([70, 130]);
      fireEvent(node, new MouseEvent("dragend", { bubbles: true }));
      await waitFor(() => expect(callout(saved)).toMatchObject({ x: 130, y: 60, tail: { x: 70, y: 130 } }));
    });

    it("restyles the selected callout: background, text size and colour, from the corners only", async () => {
      const saved = mockEditor(withCallout);
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.mouseDown(document.querySelector('[data-id="c1"]') as Element);
      expect(anchors()).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);
      expect(widthButton("Text size")).toHaveTextContent("24px");
      fireEvent.click(screen.getByRole("button", { name: "Text background" }));
      expect(screen.getByRole("button", { name: "Text background" })).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(callout(saved)).toMatchObject({ background: true }));
      fireEvent.keyDown(window, { key: "]" });
      await waitFor(() => expect(callout(saved)).toMatchObject({ fontSize: 30 }));
      fireEvent.click(screen.getByRole("button", { name: "Colour #0090ff" }));
      await waitFor(() => expect(callout(saved)).toMatchObject({ color: "#0090ff", tail: { x: 40, y: 120 } }));
    });

    it("duplicates a callout with its tip", async () => {
      const saved = mockEditor(withCallout);
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Select" }));
      fireEvent.mouseDown(document.querySelector('[data-id="c1"]') as Element);
      fireEvent.keyDown(window, { key: "d", ctrlKey: true });
      await waitFor(() => expect(last(saved)?.shapes[5]).toMatchObject({ type: "callout", x: 112, y: 62, tail: { x: 52, y: 132 } }));
    });
  });

  it("cuts out a dragged strip, closing the gap, and undoes and restores it", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyUp(window, { key: "x" });
    expect(pressed("Cut out")).toHaveAttribute("aria-pressed", "true");
    expect(pressed("Cut out")).toHaveAttribute("title", "Cut out (X)");
    // Cut out has no colour: its pickers take the swatches' place.
    expect(screen.queryByRole("group", { name: "Colour" })).not.toBeInTheDocument();
    const directions = within(screen.getByRole("group", { name: "Strip direction" }));
    expect(directions.getAllByRole("button").map((button) => button.textContent)).toEqual(["Horizontal", "Vertical"]);
    expect(directions.getByRole("button", { name: "Horizontal" })).toHaveAttribute("aria-pressed", "true");
    const edges = within(screen.getByRole("group", { name: "Cut edge" }));
    expect(edges.getAllByRole("button").map((button) => button.textContent)).toEqual(["Straight", "Zigzag", "Torn"]);
    expect(screen.getByRole("button", { name: "Restore strips" })).toBeDisabled();

    // Rows 30 to 70 go: the steps inside go with them, the arrow crossing them shortens, and the text moves up.
    drag([50, 30], [300, 70]);
    expect(document.querySelector('[data-name="cut-strip"]')).not.toBeInTheDocument();
    await waitFor(() => expect(last(saved)?.cuts).toEqual([{ axis: "y", start: 30, end: 70, edge: "straight" }]));
    expect(last(saved)?.shapes.map((shape) => shape.id)).toEqual(["a1", "t1"]);
    expect(last(saved)?.shapes[0]).toMatchObject({ points: [10, 10, 100, 40] });
    expect(last(saved)?.shapes[1]).toMatchObject({ x: 20, y: 160 });
    expect(screen.getByText("400×260")).toBeInTheDocument();

    // One undo step brings the strip, the steps and the text back.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.getByText("400×300")).toBeInTheDocument();
    expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(screen.getByText("400×260")).toBeInTheDocument();

    // Restore strips puts the strip back and the text with it; the removed steps stay removed.
    fireEvent.click(screen.getByRole("button", { name: "Restore strips" }));
    await waitFor(() => expect(last(saved)).not.toHaveProperty("cuts"));
    expect(last(saved)?.shapes.map((shape) => shape.id)).toEqual(["a1", "t1"]);
    expect(last(saved)?.shapes[1]).toMatchObject({ y: 200 });
    expect(screen.getByText("400×300")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore strips" })).toBeDisabled();
  });

  it("shades the strip while it is dragged, as wide as the capture", async () => {
    mockEditor();
    await ready();
    fireEvent.click(pressed("Cut out"));
    Object.assign(pointerAt, { x: 50, y: 100 });
    fireEvent.mouseDown(stage());
    Object.assign(pointerAt, { x: 60, y: 150 });
    fireEvent.mouseMove(stage());
    const strip = document.querySelector('[data-name="cut-strip"]');
    expect(strip).toHaveAttribute("data-x", "0");
    expect(strip).toHaveAttribute("data-y", "100");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector('[data-name="cut-strip"]')).not.toBeInTheDocument();
  });

  it("cuts a vertical strip with a torn edge, saving its pattern", async () => {
    const saved = mockEditor({ version: 1, shapes: [{ id: "r", type: "rect", color: "#e5484d", strokeWidth: 4, x: 300, y: 10, width: 50, height: 50 }], crop: null });
    await ready();
    fireEvent.click(pressed("Cut out"));
    fireEvent.click(screen.getByRole("button", { name: "Vertical" }));
    fireEvent.click(screen.getByRole("button", { name: "Torn" }));
    drag([100, 20], [200, 250]);
    await waitFor(() => expect(last(saved)?.cuts?.[0]).toMatchObject({ axis: "x", start: 100, end: 200, edge: "torn" }));
    expect(Number.isInteger(last(saved)?.cuts?.[0].seed)).toBe(true);
    // A torn join leaves an 8px gap: the rectangle moves back by the strip less the gap.
    expect(last(saved)?.shapes[0]).toMatchObject({ x: 208, width: 50 });
    expect(screen.getByText("308×300")).toBeInTheDocument();
  });

  it("cuts a turned capture as it shows", async () => {
    // 400×300 turned right shows 300 wide and 400 tall: a horizontal strip on show removes columns of the capture.
    const saved = mockEditor({
      version: 1,
      shapes: [{ id: "r", type: "rect", color: "#e5484d", strokeWidth: 4, x: 200, y: 10, width: 50, height: 50 }],
      crop: null,
      rotation: 90,
    });
    await ready();
    fireEvent.click(pressed("Cut out"));
    drag([10, 100], [290, 160]);
    await waitFor(() => expect(last(saved)?.cuts).toEqual([{ axis: "x", start: 100, end: 160, edge: "straight" }]));
    expect(last(saved)?.shapes[0]).toMatchObject({ x: 140, y: 10 });
    expect(last(saved)?.rotation).toBe(90);
  });

  it("cuts without snapping on ⌥-drag instead of drawing an arrow, and ignores a stray click or a strip at the edge", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(pressed("Cut out"));
    drag([50, 100], [50, 101]);
    drag([50, 0], [50, 40]);
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

    drag([50, 100], [50, 150], { altKey: true });
    await waitFor(() => expect(last(saved)?.cuts).toEqual([{ axis: "y", start: 100, end: 150, edge: "straight" }]));
    expect(last(saved)?.shapes).toHaveLength(4);
    expect(pressed("Cut out")).toHaveAttribute("aria-pressed", "true");
  });

  it("loads a capture's saved cuts and copies the joined image", async () => {
    mockEditor({ ...sidecar, cuts: [{ axis: "y", start: 100, end: 160, edge: "zigzag" }] });
    await ready();
    expect(screen.getByText("400×248")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(flattened.options).toHaveLength(1));
    expect(flattened.options[0]).toMatchObject({ seeThrough: true });
  });

  describe("backdrop presets", () => {
    const ocean = { fill: "ocean", padding: 40, radius: 12, shadow: true };
    const sunset = { fill: "sunset", padding: 64, radius: 36, radiusUnit: "pt" as const, shadow: false, aspect: "16:9" as const };
    const saved = (id: string, name: string, backdrop: object) => ({ id, name, backdrop });

    it("saves the backdrop on show as a preset, then applies it again", async () => {
      const lists: BackdropPreset[][] = [];
      const sidecars = mockEditor({ ...sidecar, backdrop: ocean }, [], { presets: lists });
      await ready();
      const panel = backdropPanel();
      const row = within(panel.getByRole("group", { name: "Saved" }));
      expect(row.getAllByRole("button")).toHaveLength(1);
      expect(panel.queryByRole("textbox", { name: "Preset name" })).not.toBeInTheDocument();

      fireEvent.click(row.getByRole("button", { name: "Save as preset" }));
      await waitFor(() => expect(last(lists)).toEqual([{ id: expect.any(String), name: "Preset 1", backdrop: ocean }]));
      // The new preset is the one in use: its name and Delete show.
      expect(row.getByRole("button", { name: "Preset 1" })).toHaveAttribute("aria-pressed", "true");
      expect(panel.getByRole("textbox", { name: "Preset name" })).toHaveValue("Preset 1");
      expect(panel.getByRole("button", { name: "Delete preset" })).toBeInTheDocument();

      fireEvent.click(panel.getByRole("button", { name: "Sunset gradient" }));
      await waitFor(() => expect(last(sidecars)?.backdrop?.fill).toBe("sunset"));
      expect(panel.queryByRole("textbox", { name: "Preset name" })).not.toBeInTheDocument();
      fireEvent.click(row.getByRole("button", { name: "Save as preset" }));
      await waitFor(() => expect(last(lists)?.map((preset) => preset.name)).toEqual(["Preset 1", "Preset 2"]));

      fireEvent.click(row.getByRole("button", { name: "Preset 1" }));
      await waitFor(() => expect(last(sidecars)?.backdrop).toEqual(ocean));
      expect(panel.getByRole("textbox", { name: "Preset name" })).toHaveValue("Preset 1");
      expect(row.getByRole("button", { name: "Preset 2" })).toHaveAttribute("aria-pressed", "false");
    });

    it("builds each change on the stored presets, so another window's presets are kept", async () => {
      const lists: BackdropPreset[][] = [];
      const prefs: PreferencesMock = { presets: lists };
      mockEditor({ ...sidecar, backdrop: ocean }, [], prefs);
      await ready();
      // Another editor window saves a preset after this one loaded.
      prefs.stored = { backdropPresets: [saved("other", "House", sunset)] };

      const panel = backdropPanel();
      // Opening the panel shows it.
      await waitFor(() => expect(panel.getByRole("button", { name: "House" })).toBeInTheDocument());
      prefs.stored = { backdropPresets: [saved("other", "House", sunset), saved("late", "Docs", sunset)] };

      fireEvent.click(panel.getByRole("button", { name: "Save as preset" }));
      await waitFor(() =>
        expect(last(lists)).toEqual([
          saved("other", "House", sunset),
          saved("late", "Docs", sunset),
          { id: expect.any(String), name: "Preset 3", backdrop: ocean },
        ]),
      );
      await waitFor(() => expect(panel.getByRole("button", { name: "Docs" })).toBeInTheDocument());

      // A rename and a delete keep them too.
      const name = panel.getByRole("textbox", { name: "Preset name" });
      fireEvent.change(name, { target: { value: "Ocean" } });
      await waitFor(() => expect(last(lists)?.map((preset) => preset.name)).toEqual(["House", "Docs", "Ocean"]));
      fireEvent.click(panel.getByRole("button", { name: "Delete preset" }));
      await waitFor(() => expect(last(lists)?.map((preset) => preset.name)).toEqual(["House", "Docs"]));
    });

    it("applies a preset saved in an earlier session, every setting included", async () => {
      const sidecars = mockEditor(sidecar, [], { stored: { backdropPresets: [saved("p1", "House", sunset)] } });
      await ready();
      const panel = backdropPanel();
      fireEvent.click(panel.getByRole("button", { name: "House" }));
      await waitFor(() => expect(last(sidecars)?.backdrop).toEqual(sunset));
      expect(screen.getByText("Output 761×428")).toBeInTheDocument();
    });

    it("keeps its own copy of an image fill", async () => {
      const calls: { cmd: string; payload: unknown }[] = [];
      const lists: BackdropPreset[][] = [];
      const image = { ...ocean, fill: "image", image: "/home/me/Pictures/beach.jpg" };
      const sidecars = mockEditor({ ...sidecar, backdrop: image }, calls, { presets: lists });
      await ready();
      const panel = backdropPanel();
      fireEvent.click(panel.getByRole("button", { name: "Save as preset" }));
      await waitFor(() => expect(last(lists)?.[0]?.backdrop).toEqual({ ...image, image: PRESET_COPY }));
      expect(calls).toContainEqual({ cmd: "save_backdrop_preset_image", payload: { path: "/home/me/Pictures/beach.jpg" } });
      // The capture moves to the copy too, so the preset shows as in use.
      await waitFor(() => expect(last(sidecars)?.backdrop).toEqual({ ...image, image: PRESET_COPY }));
      expect(panel.getByRole("textbox", { name: "Preset name" })).toHaveValue("Preset 1");
    });

    it("renames the preset in use, and puts a cleared name back", async () => {
      const lists: BackdropPreset[][] = [];
      mockEditor({ ...sidecar, backdrop: ocean }, [], {
        stored: { backdropPresets: [saved("p1", "Sunset", sunset), saved("p2", "Preset 2", ocean)] },
        presets: lists,
      });
      await ready();
      const panel = backdropPanel();
      const name = panel.getByRole("textbox", { name: "Preset name" });
      expect(name).toHaveValue("Preset 2");

      fireEvent.change(name, { target: { value: "Docs" } });
      await waitFor(() => expect(last(lists)?.map((preset) => preset.name)).toEqual(["Sunset", "Docs"]));
      expect(panel.getByRole("button", { name: "Docs" })).toHaveAttribute("aria-pressed", "true");

      fireEvent.change(name, { target: { value: "  " } });
      expect(lists).toHaveLength(1);
      fireEvent.blur(name);
      expect(name).toHaveValue("Docs");
    });

    it("deletes the preset in use and keeps the backdrop", async () => {
      const lists: BackdropPreset[][] = [];
      const sidecars = mockEditor({ ...sidecar, backdrop: ocean }, [], {
        stored: { backdropPresets: [saved("p1", "Sunset", sunset), saved("p2", "Ocean", ocean)] },
        presets: lists,
      });
      await ready();
      const panel = backdropPanel();
      fireEvent.click(panel.getByRole("button", { name: "Delete preset" }));
      await waitFor(() => expect(last(lists)).toEqual([saved("p1", "Sunset", sunset)]));
      expect(panel.queryByRole("button", { name: "Ocean" })).not.toBeInTheDocument();
      expect(panel.queryByRole("textbox", { name: "Preset name" })).not.toBeInTheDocument();
      // The capture keeps its backdrop.
      await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
      expect(sidecars).toEqual([]);
    });

    it("saves only while a backdrop is on", async () => {
      mockEditor(sidecar, [], { stored: { backdropPresets: [saved("p1", "House", ocean)] } });
      await ready();
      expect(backdropPanel().getByRole("button", { name: "Save as preset" })).toBeDisabled();
    });

    it("hides Save as preset once 24 are saved", async () => {
      const full = Array.from({ length: 24 }, (_, i) => saved(`p${i}`, `Preset ${i + 1}`, ocean));
      mockEditor({ ...sidecar, backdrop: ocean }, [], { stored: { backdropPresets: full } });
      await ready();
      const panel = backdropPanel();
      expect(within(panel.getByRole("group", { name: "Saved" })).getAllByRole("button")).toHaveLength(24);
      expect(panel.queryByRole("button", { name: "Save as preset" })).not.toBeInTheDocument();
    });

    it("hides the saved presets when settings could not be read", async () => {
      mockEditor({ ...sidecar, backdrop: ocean }, [], { stored: new Error("unreadable") });
      await ready();
      expect(backdropPanel().queryByRole("group", { name: "Saved" })).not.toBeInTheDocument();
    });
  });
});

describe("stamps", () => {
  beforeEach(() => {
    flattened.calls = [];
    vi.stubGlobal("Image", LoadedImage);
    URL.createObjectURL = vi.fn(() => "blob:capture");
    URL.revokeObjectURL = vi.fn();
    Object.assign(transformTo, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
  });

  const topBar = () => within(screen.getByRole("toolbar", { name: "Style and actions" }));
  /** Opens the stamp picker and picks `name`. */
  const pickStamp = (name: string) => {
    fireEvent.click(topBar().getByRole("button", { name: "Choose stamp" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Stamps" })).getByRole("button", { name }));
  };
  const click = (x: number, y: number) => {
    Object.assign(pointerAt, { x, y });
    fireEvent.mouseDown(stage());
    fireEvent.mouseUp(stage());
  };
  const transformer = () => document.querySelector('[data-konva="Transformer"]') as Element;
  const stampOf = (saved: Annotations[], id?: string) =>
    last(saved)?.shapes.find((shape) => shape.type === "stamp" && (id === undefined || shape.id === id));

  it("places the picked stamp centred on a click with G, and keeps it selected", async () => {
    const saved = mockEditor({ version: 1, shapes: [], crop: null });
    await ready();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyUp(window, { key: "g" });
    expect(pressed("Stamp")).toHaveAttribute("aria-pressed", "true");
    expect(pressed("Stamp")).toHaveAttribute("title", "Stamp (G)");
    expect(widthButton("Stamp size")).toHaveTextContent("48px");
    pickStamp("Star");
    expect(topBar().getByRole("button", { name: "Choose stamp" })).toHaveAttribute("title", "Stamp: Star");
    click(200, 150);
    await waitFor(() => expect(stampOf(saved)).toMatchObject({ type: "stamp", name: "star", x: 200, y: 150, size: 48, color: "#e5484d" }));
    // Selected straight away, with corner handles that keep its ratio and a rotate handle.
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(anchors()).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);
    expect(transformer()).toHaveAttribute("data-rotate-enabled", "true");
    expect(transformer()).toHaveAttribute("data-keep-ratio", "true");
    // The size steps with ] like any width, and resizes the selected stamp.
    fireEvent.keyDown(window, { key: "]" });
    await waitFor(() => expect(stampOf(saved)).toMatchObject({ size: 64 }));
  });

  it("recolours icons, and hides the colours for emoji", async () => {
    const saved = mockEditor({ version: 1, shapes: [{ id: "c1", type: "stamp", name: "check", x: 50, y: 60, size: 48, color: "#e5484d" }], crop: null });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="c1"]') as Element);
    expect(topBar().getByRole("button", { name: "Choose stamp" })).toHaveAttribute("title", "Stamp: Check mark");
    fireEvent.click(screen.getByRole("button", { name: "Colour #0090ff" }));
    await waitFor(() => expect(stampOf(saved, "c1")).toMatchObject({ name: "check", color: "#0090ff" }));
    expect(document.querySelector('[data-id="c1"] [data-konva="Path"][data-stroke="#0090ff"]')).toBeInTheDocument();

    pickStamp("Thumbs up emoji");
    await waitFor(() => expect(stampOf(saved, "c1")).toMatchObject({ name: "emoji-1f44d", size: 48 }));
    expect(stampOf(saved, "c1")).not.toHaveProperty("color");
    expect(screen.queryByRole("button", { name: "Colour #0090ff" })).not.toBeInTheDocument();
    // Drawn as its image once loaded.
    await waitFor(() => expect(document.querySelector('[data-id="c1"] [data-konva="Image"]')).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(stampOf(saved, "c1")).toMatchObject({ name: "check", color: "#0090ff" }));
  });

  it("saves a stamp's rotation from the rotate handle, snapping to 15° while Shift is held", async () => {
    const saved = mockEditor({ version: 1, shapes: [{ id: "c1", type: "stamp", name: "check", x: 50, y: 60, size: 48, color: "#e5484d" }], crop: null });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="c1"]') as Element);
    expect(transformer()).toHaveAttribute("data-rotation-snaps", "0");
    fireEvent.keyDown(window, { key: "Shift" });
    expect(transformer()).toHaveAttribute("data-rotation-snaps", "24");
    fireEvent.keyUp(window, { key: "Shift" });
    expect(transformer()).toHaveAttribute("data-rotation-snaps", "0");

    Object.assign(transformTo, { x: 50, y: 60, scaleX: 1, scaleY: 1, rotation: 30 });
    fireEvent.transitionEnd(document.querySelector('[data-id="c1"]') as Element);
    await waitFor(() => expect(stampOf(saved, "c1")).toMatchObject({ rotation: 30, size: 48 }));
    expect(document.querySelector('[data-id="c1"]')).toHaveAttribute("data-rotation", "30");

    // Other shapes still never turn.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(transformer()).toHaveAttribute("data-rotate-enabled", "false");
  });

  it("asks for a blank keycap's label, and edits it on a double-click", async () => {
    const saved = mockEditor({ version: 1, shapes: [], crop: null });
    await ready();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyUp(window, { key: "g" });
    pickStamp("Blank key");
    click(120, 80);
    const box = screen.getByRole("textbox", { name: "Text" });
    fireEvent.change(box, { target: { value: "F5" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(stampOf(saved)).toMatchObject({ name: "keycap", label: "F5", x: 120, y: 80, color: "#e5484d" }));
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    const id = stampOf(saved)!.id;
    expect(document.querySelector(`[data-id="${id}"] [data-text="F5"]`)).toBeInTheDocument();

    fireEvent.doubleClick(document.querySelector(`[data-id="${id}"]`) as Element);
    const edit = screen.getByRole("textbox", { name: "Text" });
    expect(edit).toHaveValue("F5");
    fireEvent.change(edit, { target: { value: "Esc" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    await waitFor(() => expect(stampOf(saved, id)).toMatchObject({ label: "Esc" }));
  });

  it("places a keycap preset straight away, and drops a blank one left empty", async () => {
    const saved = mockEditor({ version: 1, shapes: [], crop: null });
    await ready();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyUp(window, { key: "g" });
    pickStamp("Blank key");
    click(10, 10);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Text" }), { key: "Enter" });
    expect(screen.queryByRole("textbox", { name: "Text" })).not.toBeInTheDocument();

    pickStamp("Ctrl key");
    click(60, 40);
    await waitFor(() => expect(last(saved)?.shapes).toEqual([expect.objectContaining({ name: "keycap", label: "Ctrl", x: 60, y: 40 })]));
  });

  it("remembers the last-picked stamp with the editor preferences", async () => {
    const stored: EditorPreferences[] = [];
    mockEditor(sidecar, [], { stored: { tool: "stamp", stamp: "emoji-1f525" }, saved: stored });
    await ready();
    await waitFor(() => expect(pressed("Stamp")).toHaveAttribute("aria-pressed", "true"));
    expect(topBar().getByRole("button", { name: "Choose stamp" })).toHaveAttribute("title", "Stamp: Fire emoji");
    expect(screen.queryByRole("button", { name: "Colour #0090ff" })).not.toBeInTheDocument();
    pickStamp("Warning");
    await waitFor(() => expect(last(stored)).toMatchObject({ stamp: "warning", tool: "stamp" }));
  });
});
