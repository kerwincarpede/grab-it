import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type Konva from "konva";
import { Image as KonvaImage, Layer, Rect as KonvaRect, Stage, Transformer } from "react-konva";
import { save } from "@tauri-apps/plugin-dialog";
import "./editor.css";
import { copyImage, editorImage, exportImage } from "./api";
import { exportTarget, flatten, type ExportFormat, type View } from "./flatten";
import { COLORS, DEFAULT_STYLE, STROKE_WIDTHS, TOOLS, type Point, type Shape, type Style, type Tool } from "./model";
import ShapeNode from "./ShapeNode";
import {
  addShape,
  anchorsFor,
  beginShape,
  cropFromDrag,
  deleteShape,
  dragShape,
  finishShape,
  newId,
  normalizeRect,
  replaceShape,
  restyleShape,
  stepNumbers,
  transformShape,
  type NodeTransform,
} from "./tools";
import { useAnnotations } from "./useAnnotations";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.2;
const clampZoom = (scale: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));

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

function fitView(image: { width: number; height: number }, size: { width: number; height: number }): View {
  const scale = clampZoom(Math.min(1, (size.width - 32) / image.width, (size.height - 32) / image.height));
  return {
    scale,
    x: Math.round((size.width - image.width * scale) / 2),
    y: Math.round((size.height - image.height * scale) / 2),
  };
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

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

  const [view, setView] = useState<View | null>(null);
  const [tool, setTool] = useState<Tool>("arrow");
  const [style, setStyle] = useState<Style>(DEFAULT_STYLE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [cropDrag, setCropDrag] = useState<{ start: Point; end: Point } | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const imageSize = useMemo(() => (image ? { width: image.width, height: image.height } : null), [image]);
  const currentView = useMemo(
    () => view ?? (imageSize ? fitView(imageSize, size) : { scale: 1, x: 0, y: 0 }),
    [view, imageSize, size],
  );
  const selected = doc.shapes.find((shape) => shape.id === selectedId) ?? null;
  const steps = useMemo(() => stepNumbers(doc.shapes), [doc.shapes]);
  const panning = tool === "pan" || spaceHeld;

  // Attach the resize handles to the selected node.
  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = selectedId && tool === "select" ? contentRef.current?.findOne(`#${selectedId}`) : null;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedId, tool, doc]);

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
        }),
      );
    }
    setTextDraft(null);
  }, [textDraft, doc, commit, style]);

  const onMouseDown = (event: Konva.KonvaEventObject<MouseEvent>) => {
    if (panning || event.evt.button !== 0) return;
    const at = pointer();
    if (!at) return;
    if (tool === "select") {
      if (event.target === event.target.getStage() || event.target.name() === "capture") setSelectedId(null);
      return;
    }
    // Clicking away blurs the text box, which commits it.
    if (textDraft) return;
    if (tool === "text") {
      // Opened on mouse up: mouse down's default action would blur it.
      textAt.current = at;
      return;
    }
    if (tool === "crop") {
      setCropDrag({ start: at, end: at });
      return;
    }
    const shape = beginShape(tool, at, style);
    if (shape?.type === "step") {
      commit(addShape(doc, shape));
    } else {
      setDraft(shape);
    }
  };

  const onMouseMove = () => {
    if (!draft && !cropDrag) return;
    const at = pointer();
    if (!at) return;
    if (draft) setDraft(dragShape(draft, at));
    if (cropDrag) setCropDrag({ ...cropDrag, end: at });
  };

  const onMouseUp = () => {
    if (textAt.current) {
      setTextDraft({ at: textAt.current, value: "" });
      textAt.current = null;
    }
    if (draft) {
      const shape = finishShape(draft);
      if (shape) commit(addShape(doc, shape));
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
    if (next !== "select") setSelectedId(null);
  }, []);

  const changeShape = (id: string, transform: NodeTransform) => {
    const shape = doc.shapes.find((candidate) => candidate.id === id);
    if (shape) commit(replaceShape(doc, transformShape(shape, transform)));
  };

  const changeStyle = (next: Partial<Style>) => {
    setStyle({ ...style, ...next });
    if (selected) commit(replaceShape(doc, restyleShape(selected, next)));
  };

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    commit(deleteShape(doc, selectedId));
    setSelectedId(null);
  }, [selectedId, doc, commit]);

  const render = useCallback(
    async (format: ExportFormat) => {
      const layer = contentRef.current;
      if (!layer || !imageSize) throw new Error("The capture has not loaded yet.");
      return flatten(layer, doc.crop, imageSize, currentView, format);
    },
    [doc.crop, imageSize, currentView],
  );

  const copy = useCallback(async () => {
    try {
      await copyImage(await render("png"));
      setMessage("Copied to the clipboard.");
    } catch (err) {
      setMessage(`Copy failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  }, [render]);

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
      setMessage(`Export failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
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
      } else if (event.key === "Delete" || event.key === "Backspace") {
        removeSelected();
      } else if (event.key === "Escape") {
        setSelectedId(null);
        setDraft(null);
        setCropDrag(null);
      } else if (event.key === " ") {
        event.preventDefault();
        setSpaceHeld(true);
      } else if (!mod && !event.altKey) {
        const match = TOOLS.find((entry) => entry.key === key);
        if (match) pickTool(match.tool);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [undoDoc, redoDoc, copy, removeSelected, pickTool]);

  const error = annotations.error ?? imageError;
  const cropPreview = cropDrag ? normalizeRect({ ...cropDrag.start, width: cropDrag.end.x - cropDrag.start.x, height: cropDrag.end.y - cropDrag.start.y }) : null;
  const crop = cropPreview ?? doc.crop ?? null;
  const shapes = draft ? [...doc.shapes, draft] : doc.shapes;
  const editable = tool === "select" && !panning;

  return (
    <main className="editor" data-testid="editor" data-ready={image ? "true" : "false"}>
      <div className="editor-toolbar" role="toolbar" aria-label="Annotation tools">
        <div className="tool-group">
          {TOOLS.map(({ tool: entry, label, key }) => (
            <button
              key={entry}
              type="button"
              className="tool"
              aria-pressed={tool === entry}
              title={`${label} (${key.toUpperCase()})`}
              onClick={() => pickTool(entry)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="tool-group">
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
          <input aria-label="Custom colour" type="color" value={style.color} onChange={(event) => changeStyle({ color: event.target.value })} />
          <select
            aria-label="Width"
            value={style.strokeWidth}
            onChange={(event) => changeStyle({ strokeWidth: Number(event.target.value) })}
          >
            {STROKE_WIDTHS.map((width) => (
              <option key={width} value={width}>
                {width}px
              </option>
            ))}
          </select>
        </div>
        <div className="tool-group">
          <button type="button" onClick={undoDoc} disabled={!annotations.canUndo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button type="button" onClick={redoDoc} disabled={!annotations.canRedo} title="Redo (Ctrl+Shift+Z)">
            Redo
          </button>
          <button type="button" onClick={removeSelected} disabled={!selectedId} title="Delete (Del)">
            Delete
          </button>
          <button type="button" onClick={() => commit({ ...doc, crop: null })} disabled={!doc.crop}>
            Reset crop
          </button>
        </div>
        <div className="tool-group">
          <button type="button" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out">
            −
          </button>
          <span className="zoom" aria-label="Zoom">
            {Math.round(currentView.scale * 100)}%
          </span>
          <button type="button" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={() => setView(null)}>
            Fit
          </button>
        </div>
        <div className="tool-group end">
          <button type="button" onClick={() => void copy()} disabled={!image} title="Copy (Ctrl+C)">
            Copy
          </button>
          <button type="button" className="primary" onClick={() => void exportAs()} disabled={!image}>
            Export…
          </button>
        </div>
      </div>
      <div ref={container} className={`editor-canvas tool-${panning ? "pan" : tool}`}>
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
            <Layer ref={contentRef}>
              <KonvaImage name="capture" image={image} listening={tool === "select"} />
              {shapes.map((shape) => (
                <ShapeNode
                  key={shape.id}
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
              ))}
            </Layer>
            <Layer>
              {crop && imageSize && (
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
      <footer className="editor-status">
        <span>{info?.fileName ?? "Loading…"}</span>
        {doc.crop && <span>
          Crop {doc.crop.width}×{doc.crop.height}
        </span>}
        <span role="status">{message ?? statusText(annotations.status)}</span>
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
