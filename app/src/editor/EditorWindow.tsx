import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type Konva from "konva";
import { Image as KonvaImage, Layer, Rect as KonvaRect, Stage, Transformer } from "react-konva";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import "./editor.css";
import { copyImage, editorImage, exportImage, pinImage } from "./api";
import BackdropPanel from "./BackdropPanel";
import { backdropLayout, exportTarget, flatten, gradientStops, roundedRectPath, type ExportFormat, type View } from "./flatten";
import {
  BackdropIcon,
  CopyIcon,
  CropResetIcon,
  ExportIcon,
  FillIcon,
  FitIcon,
  PinIcon,
  RedoIcon,
  TextBackgroundIcon,
  ToolIcon,
  TrashIcon,
  UndoIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./icons";
import {
  backdropColors,
  COLORS,
  DEFAULT_STYLE,
  sameBackdrop,
  STROKE_WIDTHS,
  TOOLS,
  type Backdrop,
  type BlurMode,
  type Point,
  type Rect,
  type Shape,
  type Style,
  type Tool,
} from "./model";
import ShapeNode, { SpotlightDim } from "./ShapeNode";
import ToolWheel, { clampWheel } from "./ToolWheel";
import {
  addShape,
  anchorsFor,
  beginShape,
  colorForKey,
  cropFromDrag,
  deleteShape,
  dragShape,
  duplicateShape,
  finishShape,
  modifierTool,
  moveShape,
  newId,
  normalizeRect,
  nudgeDelta,
  releaseRestores,
  replaceShape,
  restyleShape,
  spotlightDim,
  stepNumbers,
  stepStrokeWidth,
  transformShape,
  type NodeTransform,
} from "./tools";
import { useAnnotations } from "./useAnnotations";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.2;
const clampZoom = (scale: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
/** How long a "Copied" or "Exported" note stays in the status bar. */
const MESSAGE_MS = 4000;
const BLUR_MODES: { mode: BlurMode; label: string }[] = [
  { mode: "pixelate", label: "Pixelate" },
  { mode: "blur", label: "Smooth" },
];
const errorText = (err: unknown) => String(err instanceof Error ? err.message : err);

interface TextDraft {
  /** Set when editing an existing text shape. */
  id?: string;
  at: Point;
  value: string;
}

function useCaptureImage(ready: boolean) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    let url: string | null = null;
    let cancelled = false;
    editorImage()
      .then((bytes) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        const img = new Image();
        img.onload = () => !cancelled && setImage(img);
        img.onerror = () => !cancelled && setError("Could not load the capture.");
        img.src = url;
      })
      .catch((err: unknown) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [ready]);
  return { image, error };
}

function useSize(ref: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        setSize({ width: element.clientWidth, height: element.clientHeight });
      }
    };
    // Observing reports the initial size too.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Centres `bounds` (capture pixels) in the canvas, shrunk to fit but never enlarged. */
function fitView(bounds: Rect, size: { width: number; height: number }): View {
  const scale = clampZoom(Math.min(1, (size.width - 32) / bounds.width, (size.height - 32) / bounds.height));
  return {
    scale,
    x: Math.round((size.width - bounds.width * scale) / 2 - bounds.x * scale),
    y: Math.round((size.height - bounds.height * scale) / 2 - bounds.y * scale),
  };
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

/** What a pointer went down on: an annotation (its draggable node), a resize handle, or neither. */
function hitTarget(target: Konva.Node): { annotation: Konva.Node | null; handle: boolean } {
  for (let node: Konva.Node | null = target; node; node = node.getParent()) {
    if (node.hasName("annotation")) return { annotation: node, handle: false };
    if (node.getClassName() === "Transformer") return { annotation: null, handle: true };
  }
  return { annotation: null, handle: false };
}

/** A tool key being held: the tool it replaced, when it went down, and whether it drew anything. */
interface ToolHold {
  key: string;
  previous: Tool;
  downAt: number;
  used: boolean;
}

/** The annotation editor: a react-konva stage over the original capture. */
export default function EditorWindow() {
  const annotations = useAnnotations();
  const { doc, commit, info, undo: undoDoc, redo: redoDoc } = annotations;
  const { image, error: imageError } = useCaptureImage(info !== null);
  const container = useRef<HTMLDivElement>(null);
  const size = useSize(container);
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<View | null>(null);
  const [tool, setTool] = useState<Tool>("arrow");
  const [style, setStyle] = useState<Style>(DEFAULT_STYLE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [cropDrag, setCropDrag] = useState<{ start: Point; end: Point } | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [backdropOpen, setBackdropOpen] = useState(false);
  /** A backdrop being adjusted (a slider mid-drag), shown but not yet committed. */
  const [backdropDraft, setBackdropDraft] = useState<Backdrop | null>(null);
  /** Where the right-click tool wheel is open, in canvas pixels. */
  const [wheelAt, setWheelAt] = useState<Point | null>(null);
  const hold = useRef<ToolHold | null>(null);
  /** A node whose own drag was turned off for a ⌘/⌥ drag, with the value to give back. */
  const suppressedDrag = useRef<{ node: Konva.Node; draggable: boolean } | null>(null);

  const imageSize = useMemo(() => (image ? { width: image.width, height: image.height } : null), [image]);
  const backdrop = backdropDraft ?? doc.backdrop ?? null;
  /**
   * The backdrop preview: the area that is exported (the crop, or the whole
   * capture), where the backdrop sits around it, and the fit bounds. The
   * crop tool shows the whole capture instead, so the crop can be redrawn.
   */
  const frame = useMemo(() => {
    if (!imageSize) return null;
    const whole = { x: 0, y: 0, ...imageSize };
    if (!backdrop || tool === "crop") return { area: whole, bounds: whole, layout: null };
    const area = doc.crop ?? whole;
    const layout = backdropLayout(area, backdrop);
    return { area, bounds: { x: area.x - layout.x, y: area.y - layout.y, width: layout.width, height: layout.height }, layout };
  }, [imageSize, backdrop, tool, doc.crop]);
  const currentView = useMemo(() => view ?? (frame ? fitView(frame.bounds, size) : { scale: 1, x: 0, y: 0 }), [view, frame, size]);
  const selected = doc.shapes.find((shape) => shape.id === selectedId) ?? null;
  const steps = useMemo(() => stepNumbers(doc.shapes), [doc.shapes]);
  const panning = tool === "pan" || spaceHeld;
  /**
   * Shapes can be selected, moved and resized: with Select, and with the
   * drawing tools too (a drag that starts on a shape moves it). Crop and
   * panning leave them alone.
   */
  const editable = !panning && tool !== "crop";

  // Attach the resize handles to the selected node.
  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = selectedId && editable ? contentRef.current?.findOne(`#${selectedId}`) : null;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedId, editable, doc]);

  // Notes about an action give way to the save status again.
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => window.clearTimeout(timer);
  }, [message]);

  // A click outside the backdrop panel closes it.
  useEffect(() => {
    if (!backdropOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !backdropRef.current?.contains(event.target)) setBackdropOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [backdropOpen]);

  const pointer = (): Point | null => stageRef.current?.getRelativePointerPosition() ?? null;

  /** Where a text click started, until mouse up opens the text box. */
  const textAt = useRef<Point | null>(null);
  // Enter and the blur that follows must not commit the same draft twice.
  const committedDraft = useRef<TextDraft | null>(null);
  const commitText = useCallback(() => {
    if (!textDraft || committedDraft.current === textDraft) return;
    committedDraft.current = textDraft;
    const value = textDraft.value.trim();
    const existing = textDraft.id ? doc.shapes.find((shape) => shape.id === textDraft.id) : undefined;
    if (existing && existing.type === "text") {
      commit(value ? replaceShape(doc, { ...existing, text: value }) : deleteShape(doc, existing.id));
    } else if (value) {
      commit(
        addShape(doc, {
          id: newId(),
          type: "text",
          color: style.color,
          x: textDraft.at.x,
          y: textDraft.at.y,
          text: value,
          fontSize: 14 + style.strokeWidth * 4,
          ...(style.background ? { background: true } : {}),
        }),
      );
    }
    setTextDraft(null);
  }, [textDraft, doc, commit, style]);

  /** Turns off `node`'s own drag until mouse up, so a ⌘/⌥ drag draws instead of moving it. */
  const suppressDrag = (node: Konva.Node) => {
    suppressedDrag.current = { node, draggable: node.draggable() };
    node.draggable(false);
  };

  const onMouseDown = (event: Konva.KonvaEventObject<MouseEvent>) => {
    // Right-click opens the tool wheel (see onContextMenu).
    if (event.evt.button !== 0) return;
    // ⌘-drag draws a rectangle and ⌥-drag an arrow from any tool; Space still pans.
    const override = modifierTool(event.evt);
    if (spaceHeld || (panning && !override)) return;
    const at = pointer();
    if (!at) return;
    // A tool key held while drawing was used once: letting go brings the old tool back.
    if (hold.current) hold.current.used = true;
    const hit = hitTarget(event.target);
    // Resize handles keep working with every tool.
    if (hit.handle) return;
    const drawWith = override ?? tool;
    if (override) {
      if (hit.annotation) suppressDrag(hit.annotation);
      else if (panning) suppressDrag(event.target.getStage() ?? event.target);
    } else if (hit.annotation) {
      // The shape selected itself; its own drag moves it.
      return;
    }
    if (drawWith === "select") {
      setSelectedId(null);
      return;
    }
    // Clicking away blurs the text box, which commits it.
    if (textDraft) return;
    setSelectedId(null);
    if (drawWith === "text") {
      // Opened on mouse up: mouse down's default action would blur it.
      textAt.current = at;
      return;
    }
    if (drawWith === "crop") {
      setCropDrag({ start: at, end: at });
      return;
    }
    const shape = beginShape(drawWith, at, style);
    if (shape?.type === "step") {
      commit(addShape(doc, shape));
      setSelectedId(shape.id);
    } else {
      setDraft(shape);
    }
  };

  const onMouseMove = (event: Konva.KonvaEventObject<MouseEvent>) => {
    if (!draft && !cropDrag) return;
    const at = pointer();
    if (!at) return;
    // Shift keeps lines to 45° steps and boxes square.
    if (draft) setDraft(dragShape(draft, at, event.evt.shiftKey));
    if (cropDrag) setCropDrag({ ...cropDrag, end: at });
  };

  const onMouseUp = () => {
    if (suppressedDrag.current) {
      suppressedDrag.current.node.draggable(suppressedDrag.current.draggable);
      suppressedDrag.current = null;
    }
    if (textAt.current) {
      setTextDraft({ at: textAt.current, value: "" });
      textAt.current = null;
    }
    if (draft) {
      const shape = finishShape(draft);
      if (shape) {
        commit(addShape(doc, shape));
        // The new shape keeps its handles, ready to adjust, move or restyle.
        setSelectedId(shape.id);
      }
      setDraft(null);
    }
    if (cropDrag && imageSize) {
      const crop = cropFromDrag(cropDrag.start, cropDrag.end, imageSize);
      if (crop) commit({ ...doc, crop });
      setCropDrag(null);
    }
  };

  const onWheel = (event: Konva.KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault();
    const stage = stageRef.current;
    const screen = stage?.getPointerPosition();
    if (!screen) return;
    const scale = clampZoom(event.evt.deltaY < 0 ? currentView.scale * ZOOM_STEP : currentView.scale / ZOOM_STEP);
    const anchor = { x: (screen.x - currentView.x) / currentView.scale, y: (screen.y - currentView.y) / currentView.scale };
    setView({ scale, x: screen.x - anchor.x * scale, y: screen.y - anchor.y * scale });
  };

  const zoomBy = (factor: number) => {
    const scale = clampZoom(currentView.scale * factor);
    const centre = { x: size.width / 2, y: size.height / 2 };
    const anchor = { x: (centre.x - currentView.x) / currentView.scale, y: (centre.y - currentView.y) / currentView.scale };
    setView({ scale, x: centre.x - anchor.x * scale, y: centre.y - anchor.y * scale });
  };

  /** Picks a tool; any tool but Select drops the selection, so nothing hidden is restyled or deleted. */
  const pickTool = useCallback((next: Tool) => {
    setTool(next);
    setWheelAt(null);
    if (next !== "select") setSelectedId(null);
  }, []);

  /**
   * Brings back the tool from before a held key. What was just drawn stays
   * selected unless the tool cannot edit shapes.
   */
  const restoreTool = useCallback((previous: Tool) => {
    setTool(previous);
    if (previous === "crop" || previous === "pan") setSelectedId(null);
  }, []);

  const closeWheel = useCallback(() => setWheelAt(null), []);

  /** Right-click on the canvas opens the tool wheel there instead of the webview's menu. */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isTyping(event.target)) return;
    event.preventDefault();
    // Control-click on macOS also reports a context menu: there it is a ⌘/Ctrl drag.
    if (event.ctrlKey || !image) return;
    const box = event.currentTarget.getBoundingClientRect();
    setDraft(null);
    setCropDrag(null);
    setWheelAt(clampWheel({ x: event.clientX - box.left, y: event.clientY - box.top }, size));
  };

  const changeShape = (id: string, transform: NodeTransform) => {
    const shape = doc.shapes.find((candidate) => candidate.id === id);
    if (shape) commit(replaceShape(doc, transformShape(shape, transform)));
  };

  /** Sets the style for the next shape and applies what fits to the selected one. */
  const changeStyle = useCallback(
    (next: Partial<Style>) => {
      setStyle((now) => ({ ...now, ...next }));
      if (!selected) return;
      const restyled = restyleShape(selected, next);
      // A style the shape does not have (a colour for a blur) is not an edit.
      if (restyled !== selected) commit(replaceShape(doc, restyled));
    },
    [selected, doc, commit],
  );

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    commit(deleteShape(doc, selectedId));
    setSelectedId(null);
  }, [selectedId, doc, commit]);

  const duplicateSelected = useCallback(() => {
    if (!selected) return;
    const copy = duplicateShape(selected);
    commit(addShape(doc, copy));
    setSelectedId(copy.id);
  }, [selected, doc, commit]);

  const nudgeSelected = useCallback(
    (by: Point) => {
      if (selected) commit(replaceShape(doc, moveShape(selected, by.x, by.y)));
    },
    [selected, doc, commit],
  );

  const commitBackdrop = (next: Backdrop | null) => {
    setBackdropDraft(null);
    // Letting go of a slider that did not move is not an edit.
    if (!sameBackdrop(doc.backdrop, next)) commit({ ...doc, backdrop: next });
  };

  const render = useCallback(
    async (format: ExportFormat) => {
      const layer = contentRef.current;
      if (!layer || !imageSize) throw new Error("The capture has not loaded yet.");
      return flatten(layer, { crop: doc.crop, backdrop }, imageSize, currentView, format);
    },
    [doc.crop, backdrop, imageSize, currentView],
  );

  /** Copies the flattened image; false when it failed (and said so). */
  const copy = useCallback(async (): Promise<boolean> => {
    try {
      await copyImage(await render("png"));
      setMessage("Copied to the clipboard.");
      return true;
    } catch (err) {
      setMessage(`Copy failed: ${errorText(err)}`);
      return false;
    }
  }, [render]);

  const copyAndClose = useCallback(async () => {
    if (!(await copy())) return;
    try {
      await getCurrentWindow().close();
    } catch {
      // Outside a Tauri window there is nothing to close; the copy still happened.
    }
  }, [copy]);

  const pin = async () => {
    try {
      await pinImage(await render("png"));
      setMessage("Pinned on top of other windows.");
    } catch (err) {
      setMessage(`Pin failed: ${errorText(err)}`);
    }
  };

  const exportAs = async () => {
    try {
      const stem = (info?.fileName ?? "capture.png").replace(/\.[^.]+$/, "");
      const chosen = await save({
        defaultPath: `${stem} annotated.png`,
        filters: [
          { name: "PNG image", extensions: ["png"] },
          { name: "JPEG image", extensions: ["jpg", "jpeg"] },
        ],
      });
      if (!chosen) return;
      const target = exportTarget(chosen);
      await exportImage(target.path, await render(target.format));
      setMessage(`Exported to ${target.path}`);
    } catch (err) {
      setMessage(`Export failed: ${errorText(err)}`);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      // Before the typing check: it works from any control, and must not also press a focused button.
      if (mod && event.key === "Enter") {
        event.preventDefault();
        void copyAndClose();
        return;
      }
      if (isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const nudge = mod || event.altKey ? null : nudgeDelta(event.key, event.shiftKey);
      // 1–7 pick the colour swatches, in bar order.
      const swatch = mod || event.altKey ? null : colorForKey(event.key);
      if (mod && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoDoc();
        else undoDoc();
      } else if (mod && key === "y") {
        event.preventDefault();
        redoDoc();
      } else if (mod && key === "c") {
        event.preventDefault();
        void copy();
      } else if (mod && key === "d") {
        // Always prevented: the webview's own Ctrl+D (bookmark) has no place here.
        event.preventDefault();
        duplicateSelected();
      } else if (nudge) {
        if (!selectedId) return;
        event.preventDefault();
        nudgeSelected(nudge);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        removeSelected();
      } else if (event.key === "Escape") {
        setSelectedId(null);
        setDraft(null);
        setCropDrag(null);
        setBackdropOpen(false);
        setWheelAt(null);
      } else if (event.key === " ") {
        event.preventDefault();
        setSpaceHeld(true);
      } else if (!mod && !event.altKey && (event.key === "[" || event.key === "]")) {
        changeStyle({ strokeWidth: stepStrokeWidth(style.strokeWidth, event.key === "[" ? -1 : 1) });
      } else if (swatch) {
        changeStyle({ color: swatch });
      } else if (!mod && !event.altKey) {
        const match = TOOLS.find((entry) => entry.key === key);
        // A held key repeats: only the first press switches and starts the hold.
        if (!match || event.repeat) return;
        hold.current = { key, previous: tool, downAt: Date.now(), used: false };
        pickTool(match.tool);
      }
    };
    /** Ends a tool-key hold: a hold brings the old tool back, a tap keeps the new one. */
    const endHold = () => {
      const held = hold.current;
      hold.current = null;
      if (held && releaseRestores(Date.now() - held.downAt, held.used)) restoreTool(held.previous);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceHeld(false);
      if (hold.current?.key === event.key.toLowerCase()) endHold();
    };
    // A key let go in another window never reports its key up.
    const onBlur = () => endHold();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [undoDoc, redoDoc, copy, copyAndClose, removeSelected, duplicateSelected, nudgeSelected, selectedId, changeStyle, style.strokeWidth, pickTool, restoreTool, tool]);

  const error = annotations.error ?? imageError;
  const cropPreview = cropDrag ? normalizeRect({ ...cropDrag.start, width: cropDrag.end.x - cropDrag.start.x, height: cropDrag.end.y - cropDrag.start.y }) : null;
  const crop = cropPreview ?? doc.crop ?? null;
  const shapes = draft ? [...doc.shapes, draft] : doc.shapes;
  const spotlights = shapes.filter((shape) => shape.type === "spotlight");
  const dim = imageSize ? spotlightDim({ x: 0, y: 0, ...imageSize }, spotlights) : [];
  const framed = frame?.layout ? { area: frame.area, bounds: frame.bounds, layout: frame.layout } : null;
  const backdropFill = backdrop ? backdropColors(backdrop.fill) : [];

  // Options for the active tool, or for the selected shape when there is one.
  const optionsFor = selected?.type ?? tool;
  const boxOptions = optionsFor === "rect" || optionsFor === "ellipse";
  const fillOn = selected?.type === "rect" || selected?.type === "ellipse" ? Boolean(selected.fill) : Boolean(style.fill);
  const backgroundOn = selected?.type === "text" ? Boolean(selected.background) : Boolean(style.background);
  const blurMode = (selected?.type === "blur" ? selected.mode : style.blurMode) ?? "pixelate";

  return (
    <main className="editor" data-testid="editor" data-ready={image ? "true" : "false"}>
      <div className="editor-topbar" role="toolbar" aria-label="Style and actions">
        <div className="bar-group" role="group" aria-label="Colour">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="swatch"
              style={{ background: color }}
              aria-label={`Colour ${color}`}
              aria-pressed={style.color === color}
              onClick={() => changeStyle({ color })}
            />
          ))}
          <input
            className="swatch custom"
            aria-label="Custom colour"
            title="Custom colour"
            type="color"
            value={style.color}
            onChange={(event) => changeStyle({ color: event.target.value })}
          />
        </div>
        <div className="bar-group segmented" role="group" aria-label="Stroke width">
          {STROKE_WIDTHS.map((width) => (
            <button
              key={width}
              type="button"
              aria-label={`Width ${width}px`}
              title={`${width}px ([ and ])`}
              aria-pressed={style.strokeWidth === width}
              onClick={() => changeStyle({ strokeWidth: width })}
            >
              <span className="width-line" style={{ height: Math.min(width, 8) }} />
            </button>
          ))}
        </div>
        {boxOptions && (
          <div className="bar-group">
            <button type="button" className="icon-button" aria-label="Fill" title="Fill the shape" aria-pressed={fillOn} onClick={() => changeStyle({ fill: !fillOn })}>
              <FillIcon />
            </button>
          </div>
        )}
        {optionsFor === "text" && (
          <div className="bar-group">
            <button
              type="button"
              className="icon-button"
              aria-label="Text background"
              title="Text on a coloured background"
              aria-pressed={backgroundOn}
              onClick={() => changeStyle({ background: !backgroundOn })}
            >
              <TextBackgroundIcon />
            </button>
          </div>
        )}
        {optionsFor === "blur" && (
          <div className="bar-group segmented" role="group" aria-label="Blur style">
            {BLUR_MODES.map(({ mode, label }) => (
              <button key={mode} type="button" aria-pressed={blurMode === mode} onClick={() => changeStyle({ blurMode: mode })}>
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="bar-group">
          <button type="button" className="icon-button" onClick={undoDoc} disabled={!annotations.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
            <UndoIcon />
          </button>
          <button type="button" className="icon-button" onClick={redoDoc} disabled={!annotations.canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
            <RedoIcon />
          </button>
          <button type="button" className="icon-button" onClick={removeSelected} disabled={!selectedId} aria-label="Delete" title="Delete (Del)">
            <TrashIcon />
          </button>
        </div>
        <div
          className="bar-group backdrop-anchor"
          ref={backdropRef}
          onKeyDown={(event) => {
            // Escape on a slider never reaches the window shortcut (it is typing).
            if (event.key === "Escape") setBackdropOpen(false);
          }}
        >
          <button
            type="button"
            className="text-button"
            aria-haspopup="dialog"
            aria-expanded={backdropOpen}
            data-on={backdrop ? "true" : undefined}
            onClick={() => setBackdropOpen(!backdropOpen)}
          >
            <BackdropIcon />
            Backdrop
          </button>
          {backdropOpen && <BackdropPanel backdrop={backdrop} onPreview={setBackdropDraft} onCommit={commitBackdrop} />}
          {doc.crop && (
            <button type="button" className="icon-button" onClick={() => commit({ ...doc, crop: null })} aria-label="Reset crop" title="Reset crop">
              <CropResetIcon />
            </button>
          )}
        </div>
        <div className="bar-group end">
          <button type="button" className="text-button" onClick={() => void pin()} disabled={!image} title="Pin on top of other windows">
            <PinIcon />
            Pin
          </button>
          <button type="button" className="text-button" onClick={() => void copy()} disabled={!image} title="Copy (Ctrl+C) · Copy and close (Ctrl+Enter)">
            <CopyIcon />
            Copy
          </button>
          <button type="button" className="text-button primary" onClick={() => void exportAs()} disabled={!image}>
            <ExportIcon />
            Export…
          </button>
        </div>
      </div>
      <div className="editor-body">
        <div className="editor-rail" role="toolbar" aria-label="Annotation tools" aria-orientation="vertical">
          {TOOLS.map(({ tool: entry, label, key, group }, i) => (
            <Fragment key={entry}>
              {i > 0 && TOOLS[i - 1].group !== group && <span className="rail-separator" role="separator" />}
              <button
                type="button"
                className="icon-button"
                aria-label={label}
                aria-pressed={tool === entry}
                title={`${label} (${key.toUpperCase()})`}
                onClick={() => pickTool(entry)}
              >
                <ToolIcon tool={entry} />
              </button>
            </Fragment>
          ))}
        </div>
        <div ref={container} className={`editor-canvas tool-${panning ? "pan" : tool}`} onContextMenu={onContextMenu}>
          {error && <p className="editor-error">{error}</p>}
          {image && (
            <Stage
              ref={stageRef}
              width={size.width}
              height={size.height}
              scaleX={currentView.scale}
              scaleY={currentView.scale}
              x={currentView.x}
              y={currentView.y}
              draggable={panning}
              onDragEnd={(event) => {
                if (event.target === stageRef.current) {
                  setView({ scale: currentView.scale, x: event.target.x(), y: event.target.y() });
                }
              }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onWheel={onWheel}
            >
              {/* The backdrop preview; exports compose their own (see flatten.ts). */}
              <Layer name="backdrop" listening={false}>
                {framed && (
                  <>
                    <KonvaRect
                      {...framed.bounds}
                      {...(backdropFill.length > 1
                        ? {
                            fillLinearGradientStartPoint: { x: 0, y: 0 },
                            fillLinearGradientEndPoint: { x: framed.bounds.width, y: framed.bounds.height },
                            fillLinearGradientColorStops: gradientStops(backdropFill),
                          }
                        : { fill: backdropFill[0] })}
                    />
                    {framed.layout.shadow && (
                      <KonvaRect
                        {...framed.area}
                        cornerRadius={framed.layout.radius}
                        fill="#000000"
                        shadowColor="#000000"
                        shadowBlur={framed.layout.shadow.blur}
                        shadowOffsetY={framed.layout.shadow.offsetY}
                        shadowOpacity={framed.layout.shadow.opacity}
                      />
                    )}
                  </>
                )}
              </Layer>
              <Layer
                ref={contentRef}
                // With a backdrop, show the result: only the exported area, corners rounded.
                clipFunc={framed ? (ctx) => roundedRectPath(ctx, framed.area, framed.layout.radius) : undefined}
              >
                <KonvaImage name="capture" image={image} listening={tool === "select"} />
                {/* The shade covers the capture only: every annotation stays bright above it. */}
                {spotlights.length > 0 && <SpotlightDim dim={dim} />}
                {shapes.map((shape) => (
                  <Fragment key={shape.id}>
                    <ShapeNode
                      shape={shape}
                      image={image}
                      step={steps.get(shape.id)}
                      editable={editable && shape !== draft}
                      onSelect={setSelectedId}
                      onChange={changeShape}
                      onEditText={(id) => {
                        const text = doc.shapes.find((candidate) => candidate.id === id);
                        if (text?.type === "text") setTextDraft({ id, at: { x: text.x, y: text.y }, value: text.text });
                      }}
                    />
                  </Fragment>
                ))}
              </Layer>
              <Layer>
                {/* The backdrop preview already shows only the crop. */}
                {crop && imageSize && !framed && (
                  <>
                    {/* Dim everything outside the crop; the capture itself is untouched. */}
                    <KonvaRect x={0} y={0} width={imageSize.width} height={crop.y} fill="black" opacity={0.5} listening={false} />
                    <KonvaRect x={0} y={crop.y + crop.height} width={imageSize.width} height={imageSize.height - crop.y - crop.height} fill="black" opacity={0.5} listening={false} />
                    <KonvaRect x={0} y={crop.y} width={crop.x} height={crop.height} fill="black" opacity={0.5} listening={false} />
                    <KonvaRect x={crop.x + crop.width} y={crop.y} width={imageSize.width - crop.x - crop.width} height={crop.height} fill="black" opacity={0.5} listening={false} />
                    <KonvaRect {...crop} stroke="#ffffff" strokeWidth={1 / currentView.scale} dash={[6 / currentView.scale, 4 / currentView.scale]} listening={false} />
                  </>
                )}
                <Transformer
                  ref={transformerRef}
                  rotateEnabled={false}
                  ignoreStroke
                  keepRatio={selected?.type === "text" || selected?.type === "step"}
                  enabledAnchors={anchorsFor(selected)}
                />
              </Layer>
            </Stage>
          )}
          {wheelAt && <ToolWheel at={wheelAt} active={tool} onPick={pickTool} onClose={closeWheel} />}
          {textDraft && (
            <input
              className="text-draft"
              aria-label="Text"
              autoFocus
              value={textDraft.value}
              style={{
                left: currentView.x + textDraft.at.x * currentView.scale,
                top: currentView.y + textDraft.at.y * currentView.scale,
                color: style.color,
              }}
              onChange={(event) => setTextDraft({ ...textDraft, value: event.target.value })}
              onBlur={commitText}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitText();
                if (event.key === "Escape") {
                  committedDraft.current = textDraft;
                  setTextDraft(null);
                }
              }}
            />
          )}
        </div>
      </div>
      <footer className="editor-status">
        <span>{info?.fileName ?? "Loading…"}</span>
        {imageSize && (
          <span>
            {imageSize.width}×{imageSize.height}
          </span>
        )}
        {doc.crop && <span>
          Crop {doc.crop.width}×{doc.crop.height}
        </span>}
        {framed && (
          <span>
            Output {framed.layout.width}×{framed.layout.height}
          </span>
        )}
        <span className="status-message" role="status">
          {message ?? statusText(annotations.status)}
        </span>
        {/* Zoom lives down here, by the canvas it acts on, leaving the top bar to styling and output. */}
        <div className="status-zoom" role="group" aria-label="Zoom controls">
          <button type="button" className="icon-button" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out" title="Zoom out">
            <ZoomOutIcon />
          </button>
          <span className="zoom" aria-label="Zoom">
            {Math.round(currentView.scale * 100)}%
          </span>
          <button type="button" className="icon-button" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom in" title="Zoom in">
            <ZoomInIcon />
          </button>
          <button type="button" className="icon-button" onClick={() => setView(null)} aria-label="Fit" title="Fit to window">
            <FitIcon />
          </button>
        </div>
      </footer>
    </main>
  );
}

function statusText(status: ReturnType<typeof useAnnotations>["status"]): string {
  switch (status) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Annotations saved";
    case "error":
      return "Could not save annotations";
    default:
      return "";
  }
}
