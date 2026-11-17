import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type Konva from "konva";
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect as KonvaRect, Stage, Transformer } from "react-konva";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import "./editor.css";
import { getEditorPreferences, MAX_BACKDROP_PRESETS, setBackdropPresets } from "../settings/api";
import {
  chooseBackdropImage,
  copyImage,
  editorFaces,
  editorImage,
  editorWords,
  exportImage,
  pinImage,
  saveBackdropPresetImage,
} from "./api";
import BackdropPanel from "./BackdropPanel";
import { defaultTailOffset } from "./callout";
import { copyShotText, hasShotText, textCopied, watchShotText, type OcrLine, type ShotText } from "../library/api";
import { blursFor, findDetails, findWord, wordAt } from "./redact";
import { imageEdges, NO_EDGES, orientEdges, type Edges } from "./edges";
import { bandReach, fitToBand, imageTextBand } from "./textBand";
import {
  cutAnnotations,
  cutFromStrip,
  hasCutGaps,
  joinedImage,
  pointBeforeCuts,
  rectsThroughCuts,
  restoreStrips,
  stripBox,
  type CaptureImage,
  type StripDirection,
} from "./cut";
import {
  backdropLayout,
  backdropPaint,
  blurredBackdrop,
  coverCrop,
  exportTarget,
  fallbackScale,
  flatten,
  measureBorders,
  roundedRectPath,
  type ExportFormat,
  type PaintLayer,
  type View,
} from "./flatten";
import {
  BackdropIcon,
  ChevronDownIcon,
  CopyIcon,
  CopyTextIcon,
  CropResetIcon,
  ExportIcon,
  FillIcon,
  FitIcon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  PinIcon,
  PointerIcon,
  RedoIcon,
  ResizeIcon,
  RestoreStripsIcon,
  RotateLeftIcon,
  RotateRightIcon,
  TextBackgroundIcon,
  ToolIcon,
  TrashIcon,
  UndoIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "./icons";
import {
  BACKDROP_FILLS,
  COLORS,
  CROP_ASPECTS,
  sameBackdrop,
  TOOLS,
  widthFor,
  widthKind,
  type Backdrop,
  type BlurMode,
  type CalloutShape,
  type CropAspect,
  type CutEdge,
  type LineShape,
  type MagnifyShape,
  type Point,
  type PointerLook,
  type Rect,
  type Shape,
  type Style,
  type Tool,
  type Widths,
} from "./model";
import {
  displaySize,
  flip,
  groupTransform,
  isIdentity,
  orientationOf,
  orientedCanvas,
  orientRect,
  rotate,
  scaledSize,
  shownTextCorner,
  textCorner,
  toCapture,
  toCaptureDelta,
  withOrientation,
  withScale,
  type Orientation,
} from "./orient";
import { DEFAULT_CHOICES, parseBackdropPresets, presetName, type EditorChoices, type SavedBackdrop } from "./preferences";
import {
  builtInImage,
  changePointerLook,
  movePointer,
  POINTER_ID,
  POINTER_LOOKS,
  pointerBox,
  pointerImageSource,
  pointerSprite,
  pointerState,
  showPointer,
  transformPointer,
  withPointer,
} from "./pointer";
import ResizePanel from "./ResizePanel";
import ShapeNode, { SpotlightDim } from "./ShapeNode";
import ToolWheel from "./ToolWheel";
import {
  addShape,
  ALL_ANCHORS,
  ALL_SIDES,
  anchorSides,
  anchorsFor,
  beginShape,
  bendLine,
  clampWheel,
  colorForKey,
  CORNER_ANCHORS,
  cropAspectRatio,
  cropBox,
  cropDragRatio,
  cropToCapture,
  curveMidpoint,
  CROP_SNAP_PX,
  deleteShape,
  dragShape,
  duplicateShape,
  finishShape,
  fitCropToRatio,
  hasLineHandles,
  holdCropSides,
  MIN_SIZE,
  modifierTool,
  moveCrop,
  moveLineEnd,
  moveShape,
  nearestLine,
  newId,
  nudgeDelta,
  releaseRestores,
  replaceShape,
  resizeCrop,
  restyleShape,
  snapAngle,
  snapCropDrag,
  snapCropEdges,
  spotlightDim,
  stepNumbers,
  stepStrokeWidth,
  STRAIGHTEN_SNAP,
  transformShape,
  type NodeTransform,
} from "./tools";
import { useAnnotations } from "./useAnnotations";
import { useEditorPreferences } from "./useEditorPreferences";
import { useBackdropImage } from "./useBackdropImage";
import WidthControl from "./WidthControl";

/** The zoom limits as the label shows them: relative to the capture's on-screen size. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.2;
/**
 * Keeps a view scale (CSS pixels per image pixel) within the zoom limits.
 * The limits are in on-screen sizes, so a capture of `captureScale` image
 * pixels per point is held to 5%-1600% of the size it had on screen.
 */
const clampZoom = (scale: number, captureScale: number) =>
  Math.min(MAX_ZOOM / captureScale, Math.max(MIN_ZOOM / captureScale, scale));
/** How long a "Copied" or "Exported" note stays in the status bar. */
const MESSAGE_MS = 4000;
const BLUR_MODES: { mode: BlurMode; label: string }[] = [
  { mode: "pixelate", label: "Pixelate" },
  { mode: "blur", label: "Smooth" },
];
/** How much ⌥-scroll moves one width step: about one mouse-wheel notch, or a short trackpad swipe. */
const WIDTH_SCROLL_STEP = 40;
const errorText = (err: unknown) => String(err instanceof Error ? err.message : err);
const STRIP_DIRECTIONS: { direction: StripDirection; label: string }[] = [
  { direction: "horizontal", label: "Horizontal" },
  { direction: "vertical", label: "Vertical" },
];
const CUT_EDGES: { edge: CutEdge; label: string }[] = [
  { edge: "straight", label: "Straight" },
  { edge: "zigzag", label: "Zigzag" },
  { edge: "torn", label: "Torn" },
];
/** The crop rect's Konva name: pressing on it moves the crop instead of starting a new one. */
const CROP_BOX = "crop-box";

interface TextDraft {
  /** Set when editing an existing text or callout. */
  id?: string;
  /** The text's top-left corner as it shows: in display space, not capture pixels. */
  at: Point;
  value: string;
  /** Set for a new callout: where its tail points, in capture pixels. */
  tail?: Point;
}

/** A press-and-drag moving less than this, in screen pixels, places a callout with the default tail. */
const CALLOUT_CLICK_PX = 4;

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

/** The pointer's image (`src`, a data URL), once decoded; null while it loads or when there is none. */
function usePointerImage(src: string | null) {
  const [loaded, setLoaded] = useState<{ src: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => !cancelled && setLoaded({ src, image: img });
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  // A look that is still loading shows nothing rather than the last look in the new look's box.
  return src && loaded?.src === src ? loaded.image : null;
}

/** The built-in looks' names in the Pointer look picker, which lists Captured first. */
const LOOK_LABELS: Record<PointerLook, string> = { arrow: "Arrow", hand: "Hand", text: "Text" };

/** One layer of the backdrop preview, painted as the export compose paints it (see `paintBackdrop`). */
function PaintNode({
  layer,
  bounds,
  blurred,
  image,
}: {
  layer: PaintLayer;
  bounds: Rect;
  blurred: { canvas: HTMLCanvasElement; crop: Rect } | null;
  image: HTMLImageElement | null;
}) {
  switch (layer.kind) {
    case "solid":
      return <KonvaRect name="backdrop-fill" {...bounds} fill={layer.color} />;
    case "linear":
      return (
        <KonvaRect
          name="backdrop-fill"
          {...bounds}
          fillLinearGradientStartPoint={layer.start}
          fillLinearGradientEndPoint={layer.end}
          fillLinearGradientColorStops={layer.stops}
        />
      );
    case "radial":
      return (
        <KonvaRect
          name="backdrop-fill"
          {...bounds}
          fillRadialGradientStartPoint={layer.center}
          fillRadialGradientEndPoint={layer.center}
          fillRadialGradientStartRadius={0}
          fillRadialGradientEndRadius={layer.radius}
          fillRadialGradientColorStops={layer.stops}
        />
      );
    case "blurred":
      return blurred ? <KonvaImage name="backdrop-blurred" image={blurred.canvas} crop={blurred.crop} {...bounds} /> : null;
    case "image":
      return image ? (
        <KonvaImage
          name="backdrop-image"
          image={image}
          crop={coverCrop({ x: 0, y: 0, width: image.width, height: image.height }, bounds)}
          {...bounds}
        />
      ) : null;
  }
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

/**
 * Centres `bounds` (display space: the capture as it shows) in the canvas,
 * shrunk to fit but never shown larger than it was on screen: one image
 * pixel per `1 / captureScale` CSS pixels at most.
 */
function fitView(bounds: Rect, size: { width: number; height: number }, captureScale: number): View {
  const scale = clampZoom(
    Math.min(1 / captureScale, (size.width - 32) / bounds.width, (size.height - 32) / bounds.height),
    captureScale,
  );
  return {
    scale,
    x: Math.round((size.width - bounds.width * scale) / 2 - bounds.x * scale),
    y: Math.round((size.height - bounds.height * scale) / 2 - bounds.y * scale),
  };
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

/**
 * What a pointer went down on: an annotation (its draggable node), a resize
 * or line handle, the crop (which moves when dragged), or none of them.
 */
function hitTarget(target: Konva.Node): { annotation: Konva.Node | null; handle: boolean; crop: Konva.Node | null } {
  for (let node: Konva.Node | null = target; node; node = node.getParent()) {
    if (node.hasName("annotation")) return { annotation: node, handle: false, crop: null };
    if (node.getClassName() === "Transformer" || node.hasName(LINE_HANDLE)) return { annotation: null, handle: true, crop: null };
    if (node.hasName(CROP_BOX)) return { annotation: null, handle: false, crop: node };
  }
  return { annotation: null, handle: false, crop: null };
}

/** The box a node covers in its parent, with the scale a Transformer gave it applied. */
function scaledBox(node: Konva.Node): Rect {
  return { x: node.x(), y: node.y(), width: node.width() * node.scaleX(), height: node.height() * node.scaleY() };
}

/** Names the bend and end handles of a selected arrow or line. */
const LINE_HANDLE = "line-handle";
/** Line handle radius, in screen pixels. */
const LINE_HANDLE_RADIUS = 6;
/** The Transformer's own anchor colour, so line handles look like the box handles. */
const HANDLE_COLOR = "rgb(0, 161, 255)";

/**
 * A selected arrow or line's handles: one on the curve's midpoint that bends
 * it, and one on each end. `shape` is what is shown (a drag in progress
 * included); `base` is the shape the drag started from. A drag previews
 * live and commits once, when it ends.
 */
function LineHandles({
  shape,
  base,
  scale,
  onPreview,
  onCommit,
}: {
  shape: LineShape;
  base: LineShape;
  scale: number;
  onPreview: (shape: LineShape) => void;
  onCommit: (shape: LineShape) => void;
}) {
  /** Where each handle sits on a line: its ends, and the curve's midpoint. */
  const places: Record<string, (line: LineShape) => Point> = {
    start: (line) => ({ x: line.points[0], y: line.points[1] }),
    end: (line) => ({ x: line.points[2], y: line.points[3] }),
    bend: curveMidpoint,
  };
  const handle = (key: string, fill: string, update: (to: Point, shift: boolean) => LineShape) => {
    const at = places[key](shape);
    /**
     * Konva leaves a dragged node under the pointer, and react-konva only
     * re-applies x/y when they change, so a snapped result (Shift, or the
     * straighten snap) would leave the handle off the line: put it where
     * the line puts it.
     */
    const apply = (event: Konva.KonvaEventObject<DragEvent>) => {
      const next = update(event.target.position(), event.evt.shiftKey);
      event.target.position(places[key](next));
      return next;
    };
    return (
      <Circle
        key={key}
        name={`${LINE_HANDLE} ${LINE_HANDLE}-${key}`}
        x={at.x}
        y={at.y}
        radius={LINE_HANDLE_RADIUS / scale}
        fill={fill}
        stroke={HANDLE_COLOR}
        strokeWidth={1.5 / scale}
        draggable
        onDragMove={(event: Konva.KonvaEventObject<DragEvent>) => onPreview(apply(event))}
        onDragEnd={(event: Konva.KonvaEventObject<DragEvent>) => {
          event.cancelBubble = true;
          onCommit(apply(event));
        }}
      />
    );
  };
  const otherEnd = (end: 0 | 1): Point => (end === 0 ? { x: base.points[2], y: base.points[3] } : { x: base.points[0], y: base.points[1] });
  // Shift holds a dragged end to 45° steps from the other end, as when drawing.
  const moveEnd = (end: 0 | 1) => (to: Point, shift: boolean) => moveLineEnd(base, end, shift ? snapAngle(otherEnd(end), to) : to);
  return (
    <>
      {handle("start", "#ffffff", moveEnd(0))}
      {handle("end", "#ffffff", moveEnd(1))}
      {handle("bend", HANDLE_COLOR, (to) => bendLine(base, to, STRAIGHTEN_SNAP / scale))}
    </>
  );
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
  const { doc, commit, adopt, info, undo: undoDoc, redo: redoDoc } = annotations;
  const { image: capture, error: imageError } = useCaptureImage(info !== null);
  /**
   * The capture with its cuts made. It stands in for the capture everywhere:
   * shapes and the crop live in its pixels, and it is what shows, blurs and
   * is exported.
   */
  const image = useMemo<CaptureImage | null>(() => (capture ? joinedImage(capture, doc.cuts) : null), [capture, doc.cuts]);
  /** The cuts leave see-through gaps, which the backdrop shows through. */
  const seeThrough = hasCutGaps(doc.cuts);
  const container = useRef<HTMLDivElement>(null);
  const size = useSize(container);
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const cropBoxRef = useRef<Konva.Rect>(null);
  const cropTransformerRef = useRef<Konva.Transformer>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);
  const lookRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<View | null>(null);
  const [tool, setTool] = useState<Tool>(DEFAULT_CHOICES.tool);
  /** Colour and options for the next shape; each tool's width is in `widths`. */
  const [style, setStyle] = useState<Omit<Style, "strokeWidth">>(DEFAULT_CHOICES.style);
  const [widths, setWidths] = useState<Widths>(DEFAULT_CHOICES.widths);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  /** An arrow or line while one of its handles is dragged: shown, not yet committed. */
  const [bending, setBending] = useState<LineShape | null>(null);
  /** A lens's spot mid-drag, committed once when its handle is released. */
  const [spotting, setSpotting] = useState<MagnifyShape | null>(null);
  /** A callout's tip mid-drag, committed once when its handle is released. */
  const [tailing, setTailing] = useState<CalloutShape | null>(null);
  /**
   * A callout being placed: pressed on its target (`tip`, capture pixels),
   * dragged to where the bubble goes. `start` and `end` are on show.
   */
  const [calloutDrag, setCalloutDrag] = useState<{ tip: Point; start: Point; end: Point } | null>(null);
  /** A selected line, lens or callout mid-drag, so its handles or connector follow it. */
  const [moving, setMoving] = useState<{ id: string; transform: NodeTransform } | null>(null);
  /** A crop being drawn; `square` is Shift, which squares a Free crop, and `snap` is off while ⌥/Alt is held. */
  const [cropDrag, setCropDrag] = useState<{ start: Point; end: Point; square: boolean; snap: boolean } | null>(null);
  /** The crop shape for this session only; it is never saved. */
  const [cropAspect, setCropAspect] = useState<CropAspect>("free");
  /** The crop mid-move or mid-resize, shown but not yet committed. */
  const [cropEdit, setCropEdit] = useState<Rect | null>(null);
  /** Which way Cut out's strips run as the capture shows, and the edge their join gets. Chosen per session, never saved. */
  const [cutDirection, setCutDirection] = useState<StripDirection>("horizontal");
  const [cutEdge, setCutEdge] = useState<CutEdge>("straight");
  /** A strip being marked, along the way it is dragged on show; `snap` is off while ⌥/Alt is held. */
  const [cutDrag, setCutDrag] = useState<{ start: number; end: number; snap: boolean } | null>(null);
  const cropEditRef = useRef<Rect | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The ids of the blurs Blur private details added while on, with the capture they are for; null while off. */
  const [privateFor, setPrivateFor] = useState<{ path: string | null; ids: string[] } | null>(null);
  /** Blur private details is finding text and faces. */
  const [findingPrivate, setFindingPrivate] = useState(false);
  /** The capture's library id and stored OCR text; null when the library does not know it. */
  const [storedFor, setStoredFor] = useState<{ path: string; id: number; text: ShotText } | null>(null);
  const [backdropOpen, setBackdropOpen] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);
  /** The Pointer look picker is open. */
  const [lookOpen, setLookOpen] = useState(false);
  /** A backdrop being adjusted (a slider mid-drag), shown but not yet committed. */
  const [backdropDraft, setBackdropDraft] = useState<Backdrop | null>(null);
  /** The backdrop last picked, here or in an earlier session: new backdrops start from it. */
  const [lastBackdrop, setLastBackdrop] = useState<Backdrop | null>(DEFAULT_CHOICES.backdrop);
  /** The backdrop to frame a capture without annotations with, when Settings asks for that. */
  const [autoBackdrop, setAutoBackdrop] = useState<Backdrop | null>(null);
  /**
   * The backdrops saved by name; null until settings.json is read, so
   * presets that could not be read are never overwritten.
   */
  const [presets, setPresets] = useState<SavedBackdrop[] | null>(null);
  /** `presets` as last set, for a save that finishes after copying its image. */
  const presetsRef = useRef<SavedBackdrop[] | null>(null);
  /**
   * Preset reads and writes, one after another. Another editor window may
   * change the presets too, so each change is made on the list as
   * settings.json holds it at that moment, never on this window's copy.
   */
  const presetsQueue = useRef<Promise<void>>(Promise.resolve());
  const autoApplied = useRef(false);
  /** "Show the pointer in new captures": whether a pointer not yet edited shows. */
  const [pointerByDefault, setPointerByDefault] = useState(false);
  /** Where the right-click tool wheel is open, in canvas pixels. */
  const [wheelAt, setWheelAt] = useState<Point | null>(null);
  const hold = useRef<ToolHold | null>(null);
  /** Set when a click on the canvas closed the wheel: that click only dismisses it, it does not draw. */
  const swallowDown = useRef(false);
  /** A node whose own drag was turned off for a ⌘/⌥ drag, with the value to give back. */
  const suppressedDrag = useRef<{ node: Konva.Node; draggable: boolean } | null>(null);
  /** ⌥-scroll travelled since the last width step. */
  const widthScroll = useRef(0);

  // The colour, tool, widths and options come back from last time, and are saved as they change.
  const restoreChoices = useCallback((choices: EditorChoices) => {
    setTool(choices.tool);
    setStyle(choices.style);
    setWidths(choices.widths);
    setLastBackdrop(choices.backdrop);
    if (choices.autoBackdrop && choices.backdrop) setAutoBackdrop(choices.backdrop);
    setPointerByDefault(choices.showPointer === true);
    presetsRef.current = choices.backdropPresets ?? [];
    setPresets(presetsRef.current);
  }, []);
  const choices = useMemo(() => ({ tool, style, widths, backdrop: lastBackdrop }), [tool, style, widths, lastBackdrop]);
  useEditorPreferences(choices, restoreChoices);

  // With auto-apply on, a capture opened for the first time (no sidecar
  // yet) gets the last backdrop, as if it had been loaded with it: it is
  // saved to the sidecar, but is not an undo step. The capture file and
  // its clipboard copy stay unframed.
  useEffect(() => {
    if (autoApplied.current || !autoBackdrop || !info) return;
    autoApplied.current = true;
    if (info.annotations !== null && info.annotations !== undefined) return;
    // Anything done before the preferences arrived wins.
    if (annotations.canUndo || doc.backdrop) return;
    adopt({ ...doc, backdrop: autoBackdrop });
  }, [autoBackdrop, info, annotations.canUndo, doc, adopt]);

  /** Everything `drawWith` draws the next shape with: the style plus that tool's own width. */
  /** The latest document, for work that finishes after an await. */
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  const drawStyle = (drawWith: Tool): Style => ({
    ...style,
    strokeWidth: widthFor(widths, drawWith),
    fontSize: widthFor(widths, "text"),
    stepRadius: widthFor(widths, "step"),
  });

  const imageSize = useMemo(() => (image ? { width: image.width, height: image.height } : null), [image]);
  /**
   * How the capture is turned and mirrored. Display space is the capture as
   * it shows, top-left at 0, 0; shapes and the crop stay in capture pixels.
   */
  const orientation = useMemo<Orientation>(() => orientationOf(doc), [doc]);
  const { rotation, flipX, flipY } = orientation;
  const oriented = !isIdentity(orientation);
  const groupAttrs = useMemo(
    () => (imageSize ? groupTransform(imageSize, { rotation, flipX, flipY }) : undefined),
    [imageSize, rotation, flipX, flipY],
  );
  const outputScale = doc.scale ?? 1;
  /**
   * The capture's size as it shows. Crop ratios, drags, handles and moves all
   * work on show, so a 16:9 crop looks 16:9 however the capture is turned.
   */
  const shownSize = useMemo(() => (imageSize ? displaySize(imageSize, { rotation, flipX, flipY }) : null), [imageSize, rotation, flipX, flipY]);
  /** Width over height for the picked crop aspect, Original being the capture as it shows; null for a Free crop. */
  const cropRatio = useMemo(() => cropAspectRatio(cropAspect, shownSize), [cropAspect, shownSize]);
  /** The saved crop as it shows. */
  const shownCrop = useMemo(
    () => (doc.crop && imageSize ? orientRect(doc.crop, imageSize, { rotation, flipX, flipY }) : null),
    [doc.crop, imageSize, rotation, flipX, flipY],
  );
  /** A crop on show back in capture pixels, for `doc.crop`. */
  const shownToCapture = (shown: Rect): Rect => (imageSize ? cropToCapture(shown, imageSize, orientation) : shown);
  /** Strong lines in the capture (capture pixels) that crops and strips snap to, found once per image when Crop or Cut out is first picked. */
  const [foundEdges, setFoundEdges] = useState<{ image: CaptureImage; edges: Edges } | null>(null);
  // Adjusting state while rendering (not in an effect), so the first crop drag already snaps.
  if ((tool === "crop" || tool === "cut") && image && foundEdges?.image !== image) setFoundEdges({ image, edges: imageEdges(image) });
  const captureEdges = foundEdges && foundEdges.image === image ? foundEdges.edges : NO_EDGES;
  /** The same lines as they show: crops are drawn, moved and resized on show. */
  const snapLines = useMemo(
    () => (imageSize ? orientEdges(captureEdges, imageSize, { rotation, flipX, flipY }) : NO_EDGES),
    [captureEdges, imageSize, rotation, flipX, flipY],
  );
  const backdrop = backdropDraft ?? doc.backdrop ?? null;
  /** Image pixels per point: the corner radius is in points. Older captures do not say, so the window's density stands in. */
  const captureScale = info?.scaleFactor && info.scaleFactor > 0 ? info.scaleFactor : fallbackScale();
  const backdropImageEl = useBackdropImage(backdrop?.fill === BACKDROP_FILLS.image ? (backdrop.image ?? null) : null);
  const balance = backdrop?.balance === true;
  /**
   * The plain border of the capture's pixels inside the crop, turned and
   * mirrored as they are exported, measured only while Balance is on.
   */
  const borders = useMemo(() => {
    if (!balance || !image || !imageSize) return null;
    return measureBorders(image, doc.crop ?? { x: 0, y: 0, ...imageSize }, imageSize, { rotation, flipX, flipY });
  }, [balance, image, imageSize, doc.crop, rotation, flipX, flipY]);
  /**
   * The backdrop preview: the area that is exported (the crop, or the whole
   * capture), where the backdrop sits around it, and the fit bounds. Crop
   * and Cut out show the whole capture instead, so the crop can be redrawn
   * and a strip marked anywhere.
   */
  const frame = useMemo(() => {
    if (!imageSize) return null;
    const o = { rotation, flipX, flipY };
    const whole = { x: 0, y: 0, ...displaySize(imageSize, o) };
    if (!backdrop || tool === "crop" || tool === "cut") return { area: whole, bounds: whole, layout: null };
    // The exported area as it shows, in display space.
    const area = doc.crop ? orientRect(doc.crop, imageSize, o) : whole;
    const layout = backdropLayout(area, backdrop, captureScale, borders);
    return { area, bounds: { x: area.x - layout.x, y: area.y - layout.y, width: layout.width, height: layout.height }, layout };
  }, [imageSize, backdrop, tool, doc.crop, captureScale, rotation, flipX, flipY, borders]);
  /** The capture as it shows, for the blurred fill: the image itself when nothing is turned. */
  const shownCapture = useMemo(() => {
    if (!image || !imageSize || backdrop?.fill !== BACKDROP_FILLS.blur) return image;
    const o = { rotation, flipX, flipY };
    if (isIdentity(o)) return image;
    try {
      return orientedCanvas(image, { x: 0, y: 0, ...imageSize }, imageSize, o) ?? image;
    } catch {
      return image;
    }
  }, [image, imageSize, backdrop?.fill, rotation, flipX, flipY]);
  /** The blurred-capture fill for the preview, drawn as the export draws it. */
  const blurredFill = useMemo(() => {
    if (!shownCapture || !frame?.layout || backdrop?.fill !== BACKDROP_FILLS.blur) return null;
    try {
      return blurredBackdrop(shownCapture, frame.area, frame.layout);
    } catch {
      return null;
    }
  }, [shownCapture, frame, backdrop?.fill]);
  /**
   * With see-through gaps, the capture itself (as it shows, cropped) casts
   * the backdrop's shadow instead of an opaque plate, so the backdrop shows
   * through the gaps, as on export.
   */
  const shadowCaster = useMemo(() => {
    if (!seeThrough || !image || !imageSize || !frame?.layout?.shadow) return null;
    try {
      return orientedCanvas(image, doc.crop ?? { x: 0, y: 0, ...imageSize }, imageSize, { rotation, flipX, flipY });
    } catch {
      return null;
    }
  }, [seeThrough, image, imageSize, frame, doc.crop, rotation, flipX, flipY]);
  /** What copy and export put out before Resize: the crop as it shows, framed by any backdrop. */
  const outputBase = useMemo(() => {
    if (!imageSize) return null;
    const area = orientRect(doc.crop ?? { x: 0, y: 0, ...imageSize }, imageSize, { rotation, flipX, flipY });
    const layout = backdrop ? backdropLayout(area, backdrop, captureScale, borders) : area;
    return { width: layout.width, height: layout.height };
  }, [imageSize, doc.crop, backdrop, captureScale, rotation, flipX, flipY, borders]);
  // Recomputed when the capture's scale arrives with its info, so it opens at its on-screen size.
  const currentView = useMemo(
    () => view ?? (frame ? fitView(frame.bounds, size, captureScale) : { scale: 1 / captureScale, x: 0, y: 0 }),
    [view, frame, size, captureScale],
  );
  /** How near a line, in capture pixels, a crop edge snaps to it: a few screen pixels at the current zoom. */
  const snapThreshold = CROP_SNAP_PX / currentView.scale;
  /** The box a crop drag covers on show, snapped to the capture's edges unless ⌥/Alt is held. */
  const cropDragBox = (drag: { start: Point; end: Point; square: boolean; snap: boolean }, shown: { width: number; height: number }) => {
    const ratio = cropDragRatio(cropRatio, drag.square);
    return drag.snap ? snapCropDrag(drag.start, drag.end, shown, ratio, snapLines, snapThreshold) : cropBox(drag.start, drag.end, shown, ratio);
  };
  /** The strip a Cut out drag marks on show, its edges snapped to the capture's lines unless ⌥/Alt is held. */
  const cutStripBox = (drag: { start: number; end: number; snap: boolean }, shown: { width: number; height: number }) => {
    const lines = cutDirection === "horizontal" ? snapLines.y : snapLines.x;
    const snap = (value: number) => (drag.snap ? (nearestLine(value, lines, snapThreshold) ?? value) : value);
    return stripBox(snap(drag.start), snap(drag.end), cutDirection, shown);
  };
  const selected = useMemo(() => doc.shapes.find((shape) => shape.id === selectedId) ?? null, [doc.shapes, selectedId]);
  /** The pointer saved with the capture, and where and whether it shows; null when there is none. */
  const captured = info?.pointer ?? null;
  const capturePointer = useMemo(() => pointerState(doc, captured, pointerByDefault), [doc, captured, pointerByDefault]);
  const pointerSource = captured && capturePointer ? pointerImageSource(captured, capturePointer, captureScale) : null;
  const pointerImage = usePointerImage(pointerSource);
  /** The size and hot spot of the image the pointer shows as. */
  const sprite = captured && capturePointer ? pointerSprite(captured, capturePointer, captureScale) : null;
  const pointerSelected = selectedId === POINTER_ID && Boolean(capturePointer?.shown);
  const steps = useMemo(() => stepNumbers(doc.shapes), [doc.shapes]);
  const panning = tool === "pan" || spaceHeld;
  /**
   * Shapes can be selected, moved and resized: with Select, and with the
   * drawing tools too (a drag that starts on a shape moves it). Crop, Cut
   * out and panning leave them alone.
   */
  const editable = !panning && tool !== "crop" && tool !== "cut";

  /** Arrows and lines get their own bend and end handles (LineHandles) instead of the box. */
  const lineSelected = hasLineHandles(selected);

  // Attach the resize handles to the selected node.
  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = selectedId && editable && !lineSelected ? contentRef.current?.findOne(`#${selectedId}`) : null;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
    // The pointer's node is drawn anew when its look's image arrives.
  }, [selectedId, editable, lineSelected, doc, pointerImage]);

  /** The saved crop gets move and resize handles while the Crop tool is out and no new crop is being drawn. */
  const cropHandles = tool === "crop" && !panning && Boolean(doc.crop) && !cropDrag;
  useEffect(() => {
    // Handles going away under the pointer must not leave its move cursor behind.
    if (!cropHandles && container.current) container.current.style.cursor = "";
    const transformer = cropTransformerRef.current;
    if (!transformer) return;
    const node = cropHandles ? cropBoxRef.current : null;
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [cropHandles, doc.crop, cropRatio]);

  // Notes about an action give way to the save status again.
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => window.clearTimeout(timer);
  }, [message]);

  // A click outside the resize panel closes it.
  useEffect(() => {
    if (!resizeOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !resizeRef.current?.contains(event.target)) setResizeOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [resizeOpen]);

  // A click outside the pointer look picker closes it.
  useEffect(() => {
    if (!lookOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !lookRef.current?.contains(event.target)) setLookOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [lookOpen]);

  // A click outside the backdrop panel closes it.
  useEffect(() => {
    if (!backdropOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !backdropRef.current?.contains(event.target)) setBackdropOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [backdropOpen]);

  /** The pointer in display space: the capture as it shows. */
  const shownPointer = (): Point | null => stageRef.current?.getRelativePointerPosition() ?? null;
  /** The pointer in capture pixels, where shapes and the crop live. */
  const pointer = (): Point | null => {
    const at = shownPointer();
    return at && imageSize ? toCapture(at, imageSize, orientation) : at;
  };

  /** Where a text click started, until mouse up opens the text box. */
  const textAt = useRef<Point | null>(null);
  // Enter and the blur that follows must not commit the same draft twice.
  const committedDraft = useRef<TextDraft | null>(null);
  const commitText = useCallback(() => {
    if (!textDraft || committedDraft.current === textDraft) return;
    committedDraft.current = textDraft;
    const value = textDraft.value.trim();
    const existing = textDraft.id ? doc.shapes.find((shape) => shape.id === textDraft.id) : undefined;
    // Upright text keeps the corner it shows at, however long it grows.
    const corner = (fontSize: number) =>
      imageSize ? textCorner(textDraft.at, value, fontSize, imageSize, orientation) : textDraft.at;
    if (existing && (existing.type === "text" || existing.type === "callout")) {
      const edited = isIdentity(orientation) ? { ...existing, text: value } : { ...existing, text: value, ...corner(existing.fontSize) };
      commit(value ? replaceShape(doc, edited) : deleteShape(doc, existing.id));
    } else if (value && textDraft.tail) {
      const fontSize = widthFor(widths, "callout");
      const at = corner(fontSize);
      const callout: CalloutShape = {
        id: newId(),
        type: "callout",
        color: style.color,
        x: at.x,
        y: at.y,
        text: value,
        fontSize,
        ...(style.background ? { background: true } : {}),
        tail: textDraft.tail,
      };
      commit(addShape(doc, callout));
      // Selected, so its tip can be dragged onto the target straight away.
      setSelectedId(callout.id);
    } else if (value) {
      const at = corner(widthFor(widths, "text"));
      commit(
        addShape(doc, {
          id: newId(),
          type: "text",
          color: style.color,
          x: at.x,
          y: at.y,
          text: value,
          fontSize: widthFor(widths, "text"),
          ...(style.background ? { background: true } : {}),
        }),
      );
    }
    setTextDraft(null);
  }, [textDraft, doc, commit, style, widths, imageSize, orientation]);

  /** Turns off `node`'s own drag until mouse up, so a ⌘/⌥ drag draws instead of moving it. */
  const suppressDrag = (node: Konva.Node) => {
    suppressedDrag.current = { node, draggable: node.draggable() };
    node.draggable(false);
  };

  const onMouseDown = (event: Konva.KonvaEventObject<MouseEvent>) => {
    if (swallowDown.current) {
      swallowDown.current = false;
      return;
    }
    // Right-click opens the tool wheel (see onContextMenu).
    if (event.evt.button !== 0) return;
    // ⌘-drag draws a rectangle and ⌥-drag an arrow from any tool (⌥ with Crop or Cut out works unsnapped); Space still pans.
    const override = modifierTool(event.evt, tool);
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
      // ⌘/⌥ draws over a shape or the crop rather than moving it (with Crop, ⌥ is no override: it moves the crop unsnapped).
      if (hit.annotation) suppressDrag(hit.annotation);
      else if (hit.crop) suppressDrag(hit.crop);
      else if (panning) suppressDrag(event.target.getStage() ?? event.target);
    } else if (hit.annotation || hit.crop) {
      // The shape selected itself, or the crop was grabbed; its own drag moves it.
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
      textAt.current = shownPointer() ?? at;
      return;
    }
    if (drawWith === "callout") {
      // Pressed on the target; the bubble goes where the drag ends.
      const shown = shownPointer() ?? at;
      setCalloutDrag({ tip: at, start: shown, end: shown });
      return;
    }
    if (drawWith === "crop") {
      // Drawn on show: see `shownSize`.
      const shown = shownPointer() ?? at;
      setCropDrag({ start: shown, end: shown, square: event.evt.shiftKey, snap: !event.evt.altKey });
      return;
    }
    if (drawWith === "cut") {
      // Marked on show, along the way the strip is dragged.
      const shown = shownPointer() ?? at;
      const along = cutDirection === "horizontal" ? shown.y : shown.x;
      setCutDrag({ start: along, end: along, snap: !event.evt.altKey });
      return;
    }
    const shape = beginShape(drawWith, at, drawStyle(drawWith));
    if (shape?.type === "step") {
      commit(addShape(doc, shape));
      setSelectedId(shape.id);
    } else {
      setDraft(shape);
    }
  };

  const onMouseMove = (event: Konva.KonvaEventObject<MouseEvent>) => {
    if (!draft && !cropDrag && !calloutDrag && !cutDrag) return;
    const at = pointer();
    if (!at) return;
    if (calloutDrag) setCalloutDrag({ ...calloutDrag, end: shownPointer() ?? at });
    // Shift keeps lines to 45° steps and boxes square.
    if (draft) setDraft(dragShape(draft, at, event.evt.shiftKey));
    if (cropDrag) setCropDrag({ ...cropDrag, end: shownPointer() ?? at, square: event.evt.shiftKey, snap: !event.evt.altKey });
    if (cutDrag) {
      const shown = shownPointer() ?? at;
      setCutDrag({ ...cutDrag, end: cutDirection === "horizontal" ? shown.y : shown.x, snap: !event.evt.altKey });
    }
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
    if (calloutDrag) {
      const end = shownPointer() ?? calloutDrag.end;
      const clicked = Math.hypot(end.x - calloutDrag.start.x, end.y - calloutDrag.start.y) * currentView.scale < CALLOUT_CLICK_PX;
      // A plain click puts the bubble there, with its tail pointing down and to the left as it shows.
      const offset = defaultTailOffset(widthFor(widths, "callout"));
      const shownTip = { x: end.x + offset.x, y: end.y + offset.y };
      const tail = clicked ? (imageSize ? toCapture(shownTip, imageSize, orientation) : shownTip) : calloutDrag.tip;
      setTextDraft({ at: end, value: "", tail });
      setCalloutDrag(null);
    }
    if (draft) {
      const finished = finishShape(draft);
      // A level highlighter drag over a line of text becomes a straight bar fitted to it.
      const band = finished?.type === "highlighter" && image ? imageTextBand(image, finished.points, bandReach(finished.strokeWidth)) : null;
      const shape = band && finished?.type === "highlighter" ? fitToBand(finished, band) : finished;
      if (shape) {
        commit(addShape(doc, shape));
        // The new shape keeps its handles, ready to adjust, move or restyle.
        setSelectedId(shape.id);
      } else if (draft.type === "blur") {
        // A click, not a drag, with the Blur tool blurs the word under it everywhere.
        void blurWord({ x: draft.x, y: draft.y });
      }
      setDraft(null);
    }
    if (cropDrag && shownSize) {
      // Snapped on show, then saved in capture pixels.
      const shown = cropDragBox(cropDrag, shownSize);
      // Anything smaller was a stray click.
      if (shown.width >= MIN_SIZE && shown.height >= MIN_SIZE) commit({ ...doc, crop: shownToCapture(shown) });
      setCropDrag(null);
    }
    if (cutDrag && shownSize && imageSize) {
      // Marked on show, then cut in the joined image's pixels; a thin strip or one leaving nothing on a side is ignored.
      const cut = cutFromStrip(cutStripBox(cutDrag, shownSize), imageSize, orientation, cutEdge);
      if (cut) commit(cutAnnotations(doc, cut));
      setCutDrag(null);
    }
  };

  /** Restore strips: every strip put back, with the shapes past them, as one undo step. */
  const restoreCuts = () => {
    if (!doc.cuts?.length) return;
    commit(restoreStrips(doc));
    setSelectedId(null);
  };

  const zoomBy = (factor: number) => {
    const scale = clampZoom(currentView.scale * factor, captureScale);
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
    if (previous === "crop" || previous === "cut" || previous === "pan") setSelectedId(null);
  }, []);

  const closeWheel = useCallback((event: PointerEvent) => {
    setWheelAt(null);
    // The stage's mouse down follows this pointer down; it must not draw.
    const target = event.target;
    swallowDown.current = target instanceof Node && Boolean(container.current?.contains(target)) && !isTyping(target);
  }, []);

  /** Right-click on the canvas opens the tool wheel there instead of the webview's menu. */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isTyping(event.target)) return;
    event.preventDefault();
    // Control-click on macOS also reports a context menu: there it is a ⌘/Ctrl drag.
    if (event.ctrlKey || !image) return;
    const box = event.currentTarget.getBoundingClientRect();
    setDraft(null);
    setCropDrag(null);
    setCalloutDrag(null);
    setCutDrag(null);
    setWheelAt(clampWheel({ x: event.clientX - box.left, y: event.clientY - box.top }, size));
  };

  /** Picks a crop aspect; a crop already in place is reshaped to the largest box of that ratio inside it. */
  const pickCropAspect = (aspect: CropAspect) => {
    setCropAspect(aspect);
    const ratio = cropAspectRatio(aspect, shownSize);
    if (!doc.crop || !shownCrop || !ratio) return;
    // Fitted as it shows, then saved in capture pixels.
    const fitted = shownToCapture(fitCropToRatio(shownCrop, ratio));
    const same = fitted.x === doc.crop.x && fitted.y === doc.crop.y && fitted.width === doc.crop.width && fitted.height === doc.crop.height;
    if (!same) commit({ ...doc, crop: fitted });
  };

  /** Shows a crop mid-edit, on show; the ref lets Konva's handlers read it before React re-renders. */
  const showCropEdit = (next: Rect | null) => {
    cropEditRef.current = next;
    setCropEdit(next);
  };

  /** Puts the crop rect where the move or resize left it, at scale 1, and shows that crop. */
  const placeCropBox = (node: Konva.Node, next: Rect) => {
    node.setAttrs({ ...next, scaleX: 1, scaleY: 1 });
    showCropEdit(next);
  };

  const onCropDragMove = (event: Konva.KonvaEventObject<DragEvent>) => {
    const from = cropEditRef.current ?? shownCrop;
    if (!from || !shownSize) return;
    const moved = moveCrop(from, event.target.position(), shownSize);
    placeCropBox(event.target, event.evt?.altKey ? moved : snapCropEdges(moved, ALL_SIDES, snapLines, snapThreshold, shownSize));
  };

  const onCropTransform = (event: Konva.KonvaEventObject<Event>) => {
    const from = cropEditRef.current ?? shownCrop;
    if (!from || !shownSize) return;
    const node = event.target;
    const anchor = cropTransformerRef.current?.getActiveAnchor();
    const sides = anchor ? anchorSides(anchor) : null;
    const box = scaledBox(node);
    const resized = resizeCrop(from, sides ? holdCropSides(from, box, sides) : box, shownSize, cropRatio);
    // ⌥/Alt resizes without snapping (and Konva's centred scaling is undone above).
    const unsnapped = (event.evt as MouseEvent | undefined)?.altKey;
    placeCropBox(node, !sides || unsnapped ? resized : snapCropEdges(resized, sides, snapLines, snapThreshold, shownSize, cropRatio));
  };

  /** Commits a finished move or resize of the crop, in capture pixels, as one change. */
  const commitCropEdit = () => {
    const edited = cropEditRef.current;
    showCropEdit(null);
    const now = doc.crop;
    if (!edited || !now) return;
    const next = shownToCapture(edited);
    if (next.x !== now.x || next.y !== now.y || next.width !== now.width || next.height !== now.height) commit({ ...doc, crop: next });
  };

  /** The move cursor over the crop (the handles set their own); "" gives back the tool's cursor. */
  const cropCursor = (cursor: string) => {
    if (container.current) container.current.style.cursor = cursor;
  };

  const changeShape = (id: string, transform: NodeTransform) => {
    setMoving(null);
    const shape = doc.shapes.find((candidate) => candidate.id === id);
    if (shape) commit(replaceShape(doc, transformShape(shape, transform)));
  };

  /** Follows a selected line, lens or callout while its annotation node is dragged. */
  const moveShapeLive = (id: string, transform: NodeTransform) => {
    if (id === selectedId && (lineSelected || selected?.type === "magnify" || selected?.type === "callout")) setMoving({ id, transform });
  };

  /** Ends a bend or end-handle drag: one undo step, unless nothing changed. */
  const commitLine = (shape: LineShape) => {
    setBending(null);
    const old = doc.shapes.find((candidate) => candidate.id === shape.id);
    if (old && JSON.stringify(old) !== JSON.stringify(shape)) commit(replaceShape(doc, shape));
  };

  /** Applies what fits of `next` to the selected shape. */
  const restyleSelected = useCallback(
    (next: Partial<Style>) => {
      if (!selected) return;
      const restyled = restyleShape(selected, next);
      // A style the shape does not have (a colour for a blur) is not an edit.
      if (restyled !== selected) commit(replaceShape(doc, restyled));
    },
    [selected, doc, commit],
  );

  /** Sets the colour or an option for the next shape and applies it to the selected one. */
  const changeStyle = useCallback(
    (next: Partial<Pick<Style, "color" | "fill" | "background" | "blurMode" | "zoom" | "lens" | "lensLine">>) => {
      setStyle((now) => ({ ...now, ...next }));
      restyleSelected(next);
    },
    [restyleSelected],
  );

  // Options for the active tool, or for the selected shape when there is one.
  const optionsFor = selected?.type ?? tool;
  /** What the width control sets: a stroke width, a font size, a badge size, or nothing. */
  const width = widthKind(optionsFor);
  /** The width on show: the selected shape's own, else the tool's remembered one. */
  const shownWidth = Math.round(
    selected?.type === "text" || selected?.type === "callout"
      ? selected.fontSize
      : selected?.type === "step"
        ? selected.radius
        : selected && "strokeWidth" in selected && selected.type !== "highlighter"
          ? selected.strokeWidth
          : widthFor(widths, optionsFor),
  );

  /** Remembers `next` as this tool's (or shape type's) width and resizes the selected shape. */
  const changeWidth = useCallback(
    (next: number) => {
      if (!width) return;
      setWidths((now) => ({ ...now, [optionsFor]: next }));
      restyleSelected(width.preview === "text" ? { fontSize: next } : width.preview === "step" ? { stepRadius: next } : { strokeWidth: next });
    },
    [width, optionsFor, restyleSelected],
  );

  /** One width preset thinner (-1) or wider (1): `[`, `]` and ⌥-scroll. */
  const stepWidth = useCallback(
    (direction: -1 | 1) => {
      if (width) changeWidth(stepStrokeWidth(shownWidth, direction, width.presets));
    },
    [width, shownWidth, changeWidth],
  );

  const onWheel = (event: Konva.KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault();
    // ⌥-scroll changes the width; a plain scroll zooms.
    if (event.evt.altKey) {
      widthScroll.current += event.evt.deltaY;
      if (Math.abs(widthScroll.current) < WIDTH_SCROLL_STEP) return;
      // Scrolling up (away from you) widens.
      stepWidth(widthScroll.current < 0 ? 1 : -1);
      widthScroll.current = 0;
      return;
    }
    const stage = stageRef.current;
    const screen = stage?.getPointerPosition();
    if (!screen) return;
    const scale = clampZoom(event.evt.deltaY < 0 ? currentView.scale * ZOOM_STEP : currentView.scale / ZOOM_STEP, captureScale);
    const anchor = { x: (screen.x - currentView.x) / currentView.scale, y: (screen.y - currentView.y) / currentView.scale };
    setView({ scale, x: screen.x - anchor.x * scale, y: screen.y - anchor.y * scale });
  };

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    // Delete hides the pointer; the Pointer button brings it back.
    if (selectedId === POINTER_ID) {
      if (capturePointer) commit(showPointer(doc, capturePointer, false));
    } else {
      commit(deleteShape(doc, selectedId));
    }
    setSelectedId(null);
  }, [selectedId, doc, commit, capturePointer]);

  /** Shows or hides the captured pointer: one undo step. */
  const togglePointer = () => {
    if (!capturePointer) return;
    commit(showPointer(doc, capturePointer, !capturePointer.shown));
    if (capturePointer.shown && selectedId === POINTER_ID) setSelectedId(null);
  };

  /** Draws the pointer as `look`, or as captured for null, and shows it: one undo step. */
  const pickPointerLook = (look: PointerLook | null) => {
    if (capturePointer) commit(changePointerLook(doc, capturePointer, look));
  };

  /** Ends a drag or resize of the pointer's node: one undo step, unless nothing changed. */
  const commitPointerNode = (node: Konva.Node) => {
    const transform = { x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY() };
    node.scale({ x: 1, y: 1 });
    if (!sprite || !capturePointer) return;
    commit(withPointer(doc, capturePointer, transformPointer(sprite, capturePointer, transform)));
  };

  const duplicateSelected = useCallback(() => {
    if (!selected) return;
    const copy = duplicateShape(selected);
    commit(addShape(doc, copy));
    setSelectedId(copy.id);
  }, [selected, doc, commit]);

  const nudgeSelected = useCallback(
    (by: Point) => {
      // Arrow keys move on screen; shapes live in capture pixels.
      const move = toCaptureDelta(by, orientation);
      if (selected) commit(replaceShape(doc, moveShape(selected, move.x, move.y)));
      else if (selectedId === POINTER_ID && capturePointer) commit(withPointer(doc, capturePointer, movePointer(capturePointer, move.x, move.y)));
    },
    [selected, selectedId, capturePointer, doc, commit, orientation],
  );

  /** Turns or mirrors the capture with everything on it: one undo step. */
  const reorient = useCallback(
    (next: Orientation) => {
      commit(withOrientation(doc, next));
      // A quarter turn swaps the width and height: fit it again.
      if (next.rotation !== orientation.rotation) setView(null);
    },
    [doc, commit, orientation.rotation],
  );
  const rotateBy = useCallback((direction: -1 | 1) => reorient(rotate(orientation, direction)), [reorient, orientation]);

  const commitScale = (next: number) => {
    const resized = withScale(doc, next);
    // The size it already has is not an edit.
    if ((resized.scale ?? 1) !== outputScale) commit(resized);
  };

  const commitBackdrop = (next: Backdrop | null) => {
    setBackdropDraft(null);
    // Remembered for next time; turning the backdrop off keeps the last one.
    if (next) setLastBackdrop(next);
    // Letting go of a slider that did not move is not an edit.
    if (!sameBackdrop(doc.backdrop, next)) commit({ ...doc, backdrop: next });
  };

  const showPresets = (next: SavedBackdrop[]) => {
    presetsRef.current = next;
    setPresets(next);
  };

  /** Runs `step` after the preset reads and writes already queued; a failure shows in the status bar. */
  const queuePresets = (step: () => Promise<void>) => {
    presetsQueue.current = presetsQueue.current
      .then(step)
      .catch((err: unknown) => setMessage(`Could not save presets: ${errorText(err)}`));
  };

  /** The presets as settings.json holds them now, perhaps changed by another editor window. */
  const storedPresets = async () => parseBackdropPresets((await getEditorPreferences()).backdropPresets);

  /** Shows the presets another editor window may have changed since they were read. */
  const refreshPresets = () => {
    if (!presetsRef.current) return;
    queuePresets(async () => showPresets(await storedPresets()));
  };

  /**
   * Changes the presets with `update`: on show straight away, then made
   * again on the stored list and written whole to settings.json, so a
   * change in another editor window is never lost.
   */
  const changePresets = (update: (presets: SavedBackdrop[]) => SavedBackdrop[]) => {
    if (!presetsRef.current) return;
    showPresets(update(presetsRef.current));
    queuePresets(async () => {
      const next = update(await storedPresets());
      showPresets(await setBackdropPresets(next).then(parseBackdropPresets));
    });
  };

  /**
   * Saves the backdrop on show as a new preset, "Preset N". An image fill
   * gets the preset's own copy of its file, and the capture switches to the
   * copy too, so the new preset shows as the one in use.
   */
  const savePreset = async () => {
    const current = doc.backdrop;
    if (!current || !presetsRef.current || presetsRef.current.length >= MAX_BACKDROP_PRESETS) return;
    let backdrop = current;
    if (current.fill === BACKDROP_FILLS.image && current.image) {
      try {
        backdrop = { ...current, image: await saveBackdropPresetImage(current.image) };
      } catch (err) {
        setMessage(`Could not save the preset: ${errorText(err)}`);
        return;
      }
    }
    // The same id on show and in the stored list, whatever else is there.
    const id = newId();
    changePresets((presets) =>
      presets.length >= MAX_BACKDROP_PRESETS ? presets : [...presets, { id, name: presetName(presets), backdrop }],
    );
    if (backdrop !== current) commitBackdrop(backdrop);
  };

  const render = useCallback(
    async (format: ExportFormat) => {
      const layer = contentRef.current;
      if (!layer || !imageSize) throw new Error("The capture has not loaded yet.");
      const o = { rotation, flipX, flipY };
      const whole = { x: 0, y: 0, ...imageSize };
      // The blurred fill blurs the capture as it shows: turned, then cropped.
      const shown = shownCapture && shownCapture !== image ? shownCapture : null;
      const area = shown ? orientRect(doc.crop ?? whole, imageSize, o) : (doc.crop ?? whole);
      return flatten(layer, { crop: doc.crop, backdrop, rotation, flipX, flipY, scale: outputScale }, imageSize, currentView, format, {
        scale: captureScale,
        capture: shown ? { image: shown, area } : image ? { image, area } : null,
        image: backdropImageEl,
        borders,
        seeThrough,
      });
    },
    [doc.crop, backdrop, imageSize, currentView, captureScale, image, shownCapture, backdropImageEl, rotation, flipX, flipY, outputScale, borders, seeThrough],
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

  // The original capture's stored text: crop and annotations do not change it.
  const capturePath = info?.path ?? null;
  useEffect(() => {
    if (!capturePath) return;
    return watchShotText(capturePath, (id, text) =>
      setStoredFor(id !== null && text ? { path: capturePath, id, text } : null),
    );
  }, [capturePath]);
  // Kept with the path it is for, so another capture never shows this one's text.
  const stored = storedFor !== null && storedFor.path === capturePath ? storedFor : null;

  const copyText = async () => {
    if (!stored) return;
    try {
      setMessage(`${textCopied(await copyShotText(stored.id))}.`);
    } catch (err) {
      setMessage(`Copy text failed: ${errorText(err)}`);
    }
  };

  /** The capture's words and their boxes, read once per capture and kept. */
  const wordsFor = useRef<{ path: string; lines: Promise<OcrLine[]> } | null>(null);
  const captureWords = (): Promise<OcrLine[]> => {
    const path = capturePath ?? "";
    if (wordsFor.current?.path !== path) {
      const lines = editorWords();
      wordsFor.current = { path, lines };
      // A failed read is tried again next time.
      lines.catch(() => {
        if (wordsFor.current?.lines === lines) wordsFor.current = null;
      });
    }
    return wordsFor.current.lines;
  };
  // Kept with the path it is for, so Blur private details starts off for each capture.
  const privateBlurs = privateFor !== null && privateFor.path === capturePath ? privateFor.ids : null;

  /** Adds blurs over `rects` to the latest document as one undo step; returns their ids. */
  const addBlurs = (rects: Rect[]): string[] => {
    const shapes = blursFor(rects, drawStyle("blur"), imageSize ?? undefined);
    if (shapes.length > 0) {
      const latest = docRef.current;
      commit({ ...latest, shapes: [...latest.shapes, ...shapes] });
    }
    return shapes.map((shape) => shape.id);
  };

  /**
   * Blur private details: on, blurs every email, phone number, card number,
   * street address and face; off, removes the blurs it added that are still
   * there. Everything is found on this computer.
   */
  const togglePrivate = async () => {
    if (findingPrivate || !image) return;
    if (privateBlurs) {
      const added = new Set(privateBlurs);
      const latest = docRef.current;
      const kept = latest.shapes.filter((shape) => !added.has(shape.id));
      if (kept.length !== latest.shapes.length) commit({ ...latest, shapes: kept });
      if (selectedId && added.has(selectedId)) setSelectedId(null);
      setPrivateFor(null);
      return;
    }
    setFindingPrivate(true);
    try {
      const [lines, faces] = await Promise.all([captureWords(), editorFaces()]);
      // Found on the original capture: moved through the cuts onto the joined image.
      const rects = rectsThroughCuts([...findDetails(lines).flatMap((detail) => detail.rects), ...faces], docRef.current.cuts);
      const ids = addBlurs(rects);
      // With nothing found the toggle stays off, so a later click looks again.
      if (ids.length === 0) setMessage("No private details found");
      else setPrivateFor({ path: capturePath, ids });
    } catch (err) {
      setMessage(`Blur private details failed: ${errorText(err)}`);
    } finally {
      setFindingPrivate(false);
    }
  };

  /** Blurs the word at `at`, in capture pixels, and every other place it appears, as one undo step. */
  const blurWord = async (at: Point) => {
    try {
      const lines = await captureWords();
      // Words are found on the original capture, before its cuts.
      const cuts = docRef.current.cuts;
      const word = wordAt(lines, pointBeforeCuts(at, cuts));
      if (word) addBlurs(rectsThroughCuts(findWord(lines, word), cuts));
    } catch (err) {
      setMessage(`Blur word failed: ${errorText(err)}`);
    }
  };

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
      } else if (mod && !event.altKey && (event.key === "[" || event.key === "]" || event.code === "BracketLeft" || event.code === "BracketRight")) {
        // Ctrl+[ and Ctrl+] turn the capture; only the bare keys change the width.
        event.preventDefault();
        if (image) rotateBy(event.key === "[" || event.code === "BracketLeft" ? -1 : 1);
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
        setCalloutDrag(null);
        setCutDrag(null);
        setBackdropOpen(false);
        setResizeOpen(false);
        setLookOpen(false);
        setWheelAt(null);
      } else if (event.key === " ") {
        event.preventDefault();
        setSpaceHeld(true);
      } else if (!mod && !event.altKey && (event.key === "[" || event.key === "]")) {
        stepWidth(event.key === "[" ? -1 : 1);
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
  }, [undoDoc, redoDoc, copy, copyAndClose, removeSelected, duplicateSelected, nudgeSelected, selectedId, changeStyle, stepWidth, pickTool, restoreTool, tool, image, rotateBy]);

  const error = annotations.error ?? imageError;
  /** The crop as it shows: being drawn (the box that will be committed), mid-edit, or as saved. */
  const cropShown = (cropDrag && shownSize ? cropDragBox(cropDrag, shownSize) : null) ?? cropEdit ?? shownCrop;
  /** The strip being marked, on show. */
  const stripShown = cutDrag && shownSize ? cutStripBox(cutDrag, shownSize) : null;
  /** The same crop in capture pixels, for the dim drawn in the oriented group. */
  const crop = cropShown ? shownToCapture(cropShown) : null;
  const placed = doc.shapes.map((shape) => {
    if (bending?.id === shape.id) return bending;
    if (spotting?.id === shape.id) return spotting;
    if (tailing?.id === shape.id) return tailing;
    if (shape.type === "magnify" && moving?.id === shape.id) return transformShape(shape, moving.transform);
    return shape;
  });
  const spotLens = selected?.type === "magnify" && editable ? (spotting?.id === selected.id ? spotting : selected) : null;
  /** The selected callout as its tip handle shows it: mid-move, or as saved. Its group draws the move itself. */
  const tailBase =
    selected?.type === "callout" && editable
      ? moving?.id === selected.id
        ? (transformShape(selected, moving.transform) as CalloutShape)
        : selected
      : null;
  const tailShown = tailBase && tailing?.id === tailBase.id ? tailing : tailBase;
  /** The line from a new callout's tip to where its bubble goes, while it is dragged or typed. */
  const calloutPreview = (() => {
    const shownCorner = calloutDrag?.end ?? (textDraft?.tail ? textDraft.at : null);
    const tip = calloutDrag?.tip ?? textDraft?.tail;
    if (!shownCorner || !tip) return null;
    const corner = imageSize ? toCapture(shownCorner, imageSize, orientation) : shownCorner;
    return [tip.x, tip.y, corner.x, corner.y];
  })();
  const shapes = draft ? [...placed, draft] : placed;
  /** The selected arrow or line as its handles show it: mid-drag, mid-bend, or as saved. */
  const handleBase =
    hasLineHandles(selected) && editable
      ? moving?.id === selected.id
        ? (transformShape(selected, moving.transform) as LineShape)
        : selected
      : null;
  const spotlights = shapes.filter((shape) => shape.type === "spotlight");
  const dim = imageSize ? spotlightDim({ x: 0, y: 0, ...imageSize }, spotlights) : [];
  const framed = frame?.layout ? { area: frame.area, bounds: frame.bounds, layout: frame.layout } : null;
  const output = outputBase ? scaledSize(outputBase, outputScale) : null;
  const paint = framed && backdrop ? backdropPaint(backdrop, framed.layout) : [];

  const boxOptions = optionsFor === "rect" || optionsFor === "ellipse";
  const fillOn = selected?.type === "rect" || selected?.type === "ellipse" ? Boolean(selected.fill) : Boolean(style.fill);
  const backgroundOn = selected?.type === "text" || selected?.type === "callout" ? Boolean(selected.background) : Boolean(style.background);
  const blurMode = (selected?.type === "blur" ? selected.mode : style.blurMode) ?? "pixelate";
  const lensZoom = selected?.type === "magnify" ? selected.zoom : (style.zoom ?? 2);
  const lens = (selected?.type === "magnify" ? selected.lens : style.lens) ?? "round";
  const lensLine = Boolean(selected?.type === "magnify" ? selected.line : style.lensLine);

  return (
    <main className="editor" data-testid="editor" data-ready={image ? "true" : "false"}>
      <div className="editor-topbar" role="toolbar" aria-label="Style and actions">
        {/* Crop and Cut out have no colour; their pickers take the space instead, so the bar stays on one line. */}
        {optionsFor !== "crop" && optionsFor !== "cut" && (
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
        )}
        {width && <WidthControl kind={width} value={shownWidth} color={selected && "color" in selected ? selected.color : style.color} onChange={changeWidth} />}
        {boxOptions && (
          <div className="bar-group">
            <button type="button" className="icon-button" aria-label="Fill" title="Fill the shape" aria-pressed={fillOn} onClick={() => changeStyle({ fill: !fillOn })}>
              <FillIcon />
            </button>
          </div>
        )}
        {(optionsFor === "text" || optionsFor === "callout") && (
          <div className="bar-group">
            <button
              type="button"
              className="icon-button"
              aria-label="Text background"
              title={optionsFor === "callout" ? "Fill the bubble with the colour" : "Text on a coloured background"}
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
        {optionsFor === "magnify" && (
          <>
            <div className="bar-group segmented" role="group" aria-label="Lens shape">
              {(["round", "square"] as const).map((value) => (
                <button key={value} type="button" aria-pressed={lens === value} onClick={() => changeStyle({ lens: value })}>
                  {value === "round" ? "Round" : "Square"}
                </button>
              ))}
            </div>
            <div className="bar-group segmented" role="group" aria-label="Lens zoom">
              {[2, 3, 4, 5, 6].map((zoom) => (
                <button key={zoom} type="button" aria-pressed={lensZoom === zoom} onClick={() => changeStyle({ zoom })}>{zoom}x</button>
              ))}
            </div>
            <div className="bar-group segmented">
              <button type="button" aria-pressed={lensLine} onClick={() => changeStyle({ lensLine: !lensLine })}>Line to spot</button>
            </div>
          </>
        )}
        {optionsFor === "crop" && (
          <div className="bar-group segmented" role="group" aria-label="Crop ratio">
            {CROP_ASPECTS.map(({ aspect, label }) => (
              <button key={aspect} type="button" aria-pressed={cropAspect === aspect} onClick={() => pickCropAspect(aspect)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {optionsFor === "cut" && (
          <>
            <div className="bar-group segmented" role="group" aria-label="Strip direction">
              {STRIP_DIRECTIONS.map(({ direction, label }) => (
                <button key={direction} type="button" aria-pressed={cutDirection === direction} onClick={() => setCutDirection(direction)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="bar-group segmented" role="group" aria-label="Cut edge">
              {CUT_EDGES.map(({ edge, label }) => (
                <button key={edge} type="button" aria-pressed={cutEdge === edge} onClick={() => setCutEdge(edge)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="bar-group">
              <button
                type="button"
                className="text-button"
                onClick={restoreCuts}
                disabled={!doc.cuts?.length}
                title="Put back every strip that was cut out"
              >
                <RestoreStripsIcon />
                Restore strips
              </button>
            </div>
          </>
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
          className="bar-group pointer-anchor"
          ref={lookRef}
          onKeyDown={(event) => {
            if (event.key === "Escape") setLookOpen(false);
          }}
        >
          <button
            type="button"
            className="icon-button"
            onClick={togglePointer}
            disabled={!capturePointer}
            aria-pressed={capturePointer?.shown ?? false}
            aria-label="Pointer"
            title={!capturePointer ? "This capture has no pointer" : capturePointer.shown ? "Hide the pointer" : "Show the pointer"}
          >
            <PointerIcon />
          </button>
          <button
            type="button"
            className="icon-button look-button"
            aria-haspopup="dialog"
            aria-expanded={lookOpen}
            disabled={!capturePointer}
            aria-label="Pointer look"
            title="Swap the pointer for an arrow, hand or text pointer"
            onClick={() => setLookOpen(!lookOpen)}
          >
            <ChevronDownIcon />
          </button>
          {lookOpen && captured && capturePointer && (
            <div className="backdrop-panel pointer-panel" role="dialog" aria-label="Pointer look">
              <div className="pointer-looks" role="group" aria-label="Looks">
                <button type="button" aria-pressed={!capturePointer.look} onClick={() => pickPointerLook(null)}>
                  <img src={`data:image/png;base64,${captured.image}`} alt="" />
                  Captured
                </button>
                {POINTER_LOOKS.map((look) => (
                  <button key={look} type="button" aria-pressed={capturePointer.look === look} onClick={() => pickPointerLook(look)}>
                    <img src={builtInImage(look, 1)} alt="" />
                    {LOOK_LABELS[look]}
                  </button>
                ))}
              </div>
              <p className="resize-note">The new look points where the pointer pointed.</p>
            </div>
          )}
        </div>
        <div className="bar-group" role="group" aria-label="Orientation">
          <button type="button" className="icon-button" onClick={() => rotateBy(-1)} disabled={!image} aria-label="Rotate left" title="Rotate left (Ctrl+[)">
            <RotateLeftIcon />
          </button>
          <button type="button" className="icon-button" onClick={() => rotateBy(1)} disabled={!image} aria-label="Rotate right" title="Rotate right (Ctrl+])">
            <RotateRightIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => reorient(flip(orientation, "x"))}
            disabled={!image}
            aria-label="Flip horizontal"
            title="Flip horizontal"
            aria-pressed={orientation.flipX}
          >
            <FlipHorizontalIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => reorient(flip(orientation, "y"))}
            disabled={!image}
            aria-label="Flip vertical"
            title="Flip vertical"
            aria-pressed={orientation.flipY}
          >
            <FlipVerticalIcon />
          </button>
        </div>
        <div
          className="bar-group resize-anchor"
          ref={resizeRef}
          onKeyDown={(event) => {
            // Escape in a field never reaches the window shortcut (it is typing).
            if (event.key === "Escape") setResizeOpen(false);
          }}
        >
          <button
            type="button"
            className="text-button"
            aria-haspopup="dialog"
            aria-expanded={resizeOpen}
            data-on={outputScale !== 1 ? "true" : undefined}
            disabled={!image}
            onClick={() => setResizeOpen(!resizeOpen)}
          >
            <ResizeIcon />
            Resize
          </button>
          {resizeOpen && outputBase && <ResizePanel output={outputBase} scale={outputScale} onCommit={commitScale} />}
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
            onClick={() => {
              // Opening shows any preset saved in another editor window meanwhile.
              if (!backdropOpen) refreshPresets();
              setBackdropOpen(!backdropOpen);
            }}
          >
            <BackdropIcon />
            Backdrop
          </button>
          {backdropOpen && (
            <BackdropPanel
              backdrop={backdrop}
              start={lastBackdrop}
              onPreview={setBackdropDraft}
              onCommit={commitBackdrop}
              onPickImage={chooseBackdropImage}
              presets={presets}
              onSavePreset={() => void savePreset()}
              onPresetsChange={changePresets}
            />
          )}
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
          {stored && hasShotText(stored.text) && (
            <button type="button" className="text-button" onClick={() => void copyText()} title="Copy the text in the capture">
              <CopyTextIcon />
              Copy text
            </button>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => void togglePrivate()}
            disabled={!image || findingPrivate}
            aria-pressed={privateBlurs !== null}
            aria-busy={findingPrivate}
            data-on={privateBlurs !== null ? "true" : undefined}
            title="Blur emails, phone numbers, card numbers, addresses and faces. Found on this computer."
          >
            <ToolIcon tool="blur" />
            Blur private details
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
                    {paint.map((layer, i) => (
                      <PaintNode key={i} layer={layer} bounds={framed.bounds} blurred={blurredFill} image={backdropImageEl} />
                    ))}
                    {framed.layout.shadow && shadowCaster && (
                      <KonvaImage
                        name="backdrop-shadow"
                        image={shadowCaster}
                        {...framed.area}
                        cornerRadius={framed.layout.radius}
                        shadowColor="#000000"
                        shadowBlur={framed.layout.shadow.blur}
                        shadowOffsetY={framed.layout.shadow.offsetY}
                        shadowOpacity={framed.layout.shadow.opacity}
                      />
                    )}
                    {framed.layout.shadow && !shadowCaster && (
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
                {/* Capture pixels inside, turned and mirrored into display space. */}
                <Group name="oriented" {...groupAttrs}>
                  <KonvaImage name="capture" image={image} listening={tool === "select"} />
                  {/* The captured pointer: above the capture, below every annotation, moved and resized like a shape. */}
                  {sprite && capturePointer?.shown && pointerImage && (
                    <KonvaImage
                      id={POINTER_ID}
                      name="annotation captured-pointer"
                      image={pointerImage}
                      {...pointerBox(sprite, capturePointer)}
                      draggable={editable}
                      listening={editable}
                      onMouseDown={() => setSelectedId(POINTER_ID)}
                      onTap={() => setSelectedId(POINTER_ID)}
                      onDragEnd={(event: Konva.KonvaEventObject<DragEvent>) => {
                        event.cancelBubble = true;
                        commitPointerNode(event.target);
                      }}
                      onTransformEnd={(event: Konva.KonvaEventObject<Event>) => commitPointerNode(event.target)}
                    />
                  )}
                  {/* The shade covers the capture only: every annotation stays bright above it. */}
                  {spotlights.length > 0 && <SpotlightDim dim={dim} />}
                  {shapes.map((shape) => (
                    <Fragment key={shape.id}>
                      <ShapeNode
                        shape={shape}
                        image={image}
                        step={steps.get(shape.id)}
                        editable={editable && shape !== draft}
                        orientation={oriented ? orientation : undefined}
                        onSelect={setSelectedId}
                        onChange={changeShape}
                        onMove={moveShapeLive}
                        onEditText={(id) => {
                          const text = doc.shapes.find((candidate) => candidate.id === id);
                          if ((text?.type === "text" || text?.type === "callout") && imageSize) {
                            setTextDraft({ id, at: shownTextCorner(text, imageSize, orientation), value: text.text });
                          }
                        }}
                      />
                    </Fragment>
                  ))}
                  {calloutPreview && (
                    <Line
                      name="callout-preview"
                      points={calloutPreview}
                      stroke={style.color}
                      strokeWidth={2 / currentView.scale}
                      dash={[6 / currentView.scale, 4 / currentView.scale]}
                      listening={false}
                    />
                  )}
                </Group>
              </Layer>
              <Layer>
                {/* The backdrop preview already shows only the crop. */}
                {crop && cropShown && imageSize && !framed && (
                  <>
                  <Group name="oriented-crop" {...groupAttrs}>
                    {/* Dim everything outside the crop; the capture itself is untouched. */}
                    <KonvaRect x={0} y={0} width={imageSize.width} height={crop.y} fill="black" opacity={0.5} listening={false} />
                    <KonvaRect x={0} y={crop.y + crop.height} width={imageSize.width} height={imageSize.height - crop.y - crop.height} fill="black" opacity={0.5} listening={false} />
                    <KonvaRect x={0} y={crop.y} width={crop.x} height={crop.height} fill="black" opacity={0.5} listening={false} />
                    <KonvaRect x={crop.x + crop.width} y={crop.y} width={imageSize.width - crop.x - crop.width} height={crop.height} fill="black" opacity={0.5} listening={false} />
                  </Group>
                  {/* The outline, its handles and its drag stay upright on show, outside the turned group. */}
                  <KonvaRect
                    ref={cropBoxRef}
                    name={CROP_BOX}
                    {...cropShown}
                    // A see-through fill, so the whole box (not just its outline) takes the press.
                    fill="rgba(0, 0, 0, 0)"
                    stroke="#ffffff"
                    strokeWidth={1 / currentView.scale}
                    dash={[6 / currentView.scale, 4 / currentView.scale]}
                    listening={cropHandles}
                    draggable={cropHandles}
                    onDragMove={onCropDragMove}
                    onDragEnd={commitCropEdit}
                    onTransform={onCropTransform}
                    onTransformEnd={commitCropEdit}
                    onMouseEnter={() => cropCursor("move")}
                    onMouseLeave={() => cropCursor("")}
                  />
                  </>
                )}
                {stripShown && (
                  // The strip that will be cut out, shaded until it is let go.
                  <KonvaRect
                    name="cut-strip"
                    {...stripShown}
                    fill="black"
                    opacity={0.45}
                    stroke="#ffffff"
                    strokeWidth={1 / currentView.scale}
                    dash={[6 / currentView.scale, 4 / currentView.scale]}
                    listening={false}
                  />
                )}
                <Transformer
                  ref={transformerRef}
                  rotateEnabled={false}
                  ignoreStroke
                  flipEnabled={selected?.type !== "magnify" && selected?.type !== "callout" && !pointerSelected}
                  keepRatio={pointerSelected || selected?.type === "text" || selected?.type === "callout" || selected?.type === "step" || selected?.type === "magnify"}
                  enabledAnchors={pointerSelected ? CORNER_ANCHORS : anchorsFor(selected)}
                />
                {handleBase && (
                  // In capture pixels like the line, so a dragged handle's position maps back through the turn and mirror.
                  <Group name="oriented-handles" {...groupAttrs}>
                    <LineHandles
                      shape={bending?.id === handleBase.id ? bending : handleBase}
                      base={handleBase}
                      scale={currentView.scale}
                      onPreview={setBending}
                      onCommit={commitLine}
                    />
                  </Group>
                )}
                {spotLens && (
                  <Group name="oriented-handles" {...groupAttrs}>
                    <Circle name={`${LINE_HANDLE} ${LINE_HANDLE}-spot`}
                      x={spotLens.spot[0]} y={spotLens.spot[1]}
                      radius={LINE_HANDLE_RADIUS / currentView.scale}
                      fill="#ffffff" stroke={HANDLE_COLOR} strokeWidth={1.5 / currentView.scale} draggable
                      onDragMove={(event: Konva.KonvaEventObject<DragEvent>) => {
                        const at = event.target.position();
                        setSpotting({ ...spotLens, spot: [at.x, at.y] });
                      }}
                      onDragEnd={(event: Konva.KonvaEventObject<DragEvent>) => {
                        event.cancelBubble = true;
                        const at = event.target.position();
                        setSpotting(null);
                        if (selected?.type === "magnify" && (at.x !== selected.spot[0] || at.y !== selected.spot[1])) {
                          commit(replaceShape(doc, { ...spotLens, spot: [at.x, at.y] }));
                        }
                      }}
                    />
                  </Group>
                )}
                {tailShown && tailBase && (
                  // In capture pixels like the tail, so a dragged tip maps back through the turn and mirror.
                  <Group name="oriented-handles" {...groupAttrs}>
                    <Circle name={`${LINE_HANDLE} ${LINE_HANDLE}-tail`}
                      x={tailShown.tail.x} y={tailShown.tail.y}
                      radius={LINE_HANDLE_RADIUS / currentView.scale}
                      fill="#ffffff" stroke={HANDLE_COLOR} strokeWidth={1.5 / currentView.scale} draggable
                      onDragMove={(event: Konva.KonvaEventObject<DragEvent>) => {
                        const at = event.target.position();
                        setTailing({ ...tailBase, tail: { x: at.x, y: at.y } });
                      }}
                      onDragEnd={(event: Konva.KonvaEventObject<DragEvent>) => {
                        event.cancelBubble = true;
                        const at = event.target.position();
                        setTailing(null);
                        if (selected?.type === "callout" && (at.x !== selected.tail.x || at.y !== selected.tail.y)) {
                          commit(replaceShape(doc, { ...selected, tail: { x: at.x, y: at.y } }));
                        }
                      }}
                    />
                  </Group>
                )}
                {cropHandles && (
                  <Transformer
                    ref={cropTransformerRef}
                    name="crop-handles"
                    rotateEnabled={false}
                    flipEnabled={false}
                    ignoreStroke
                    keepRatio={cropRatio !== null}
                    enabledAnchors={cropRatio !== null ? CORNER_ANCHORS : ALL_ANCHORS}
                  />
                )}
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
        {shownCrop && <span>
          Crop {Math.round(shownCrop.width)}×{Math.round(shownCrop.height)}
        </span>}
        {output && (framed || outputScale !== 1 || oriented) && (
          <span>
            Output {output.width}×{output.height}
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
            {/* 100% is the size the capture had on screen, not one image pixel per CSS pixel. */}
            {Math.round(currentView.scale * captureScale * 100)}%
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
