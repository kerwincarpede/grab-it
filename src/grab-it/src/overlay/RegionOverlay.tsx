import {
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  cancelOverlay,
  chooseOverlay,
  rememberSetupSpot,
  finishOverlay,
  imageType,
  isInstantOverlay,
  onOverlayChoice,
  onOverlayStart,
  overlayImage,
  overlayInfo,
  overlayReady,
  type OverlayChoice,
  type OverlayInfo,
  type OverlayIntent,
  type OverlayWindow,
  type Selection,
} from "./api";
import {
  advanceDrag,
  clampedDelta,
  contains,
  cutoutPath,
  hintTop,
  dragBox,
  frameParts,
  fromImagePixels,
  handlePoint,
  holeCorners,
  HANDLES,
  imageSize,
  isDrag,
  labelPlacement,
  labelTransform,
  monitorToCss,
  moveTo,
  resizeBox,
  snapToImage,
  clipToView,
  stretch,
  surround,
  topmostAt,
  translate,
  withRatio,
  withSize,
  type Box,
  type Drag,
  type Handle,
  type LabelPlacement,
  type Point,
  type Size,
} from "./geometry";
import { drawBackdrop } from "./backdrop";
import {
  ColourIcon,
  RecordIcon,
  ScrollIcon,
  RegionIcon,
  ScreenIcon,
  TextIcon,
  TimerIcon,
  WindowIcon,
} from "../app/icons";
import Loupe from "./Loupe";
import RecordSetup from "./RecordSetup";
import { SOURCES, useRecordingOptions } from "./recordSources";
import type { RecordingSource } from "../settings/api";
import "./overlay.css";

interface PickableWindow {
  window: OverlayWindow;
  box: Box;
}

/** Room each label needs, gap included; the widths are generous estimates. */
const SIZE_LABEL: Size = { width: 130, height: 30 };
const TITLE_LABEL: Size = { width: 320, height: 30 };

const HINTS: Record<OverlayIntent, string> = {
  capture: "Drag to capture a region, or click a window. Esc cancels.",
  text: "Drag over the text to copy it. Esc cancels.",
  color: "Click to copy the colour under the cursor. Esc cancels.",
  scroll: "Drag to choose an area or click a window, then scroll by hand. Esc cancels.",
  record: "Drag to choose the area to record, or click a window. Esc cancels.",
};
/** The Record overlay's hint for each source, before and after a pick. */
const RECORD_HINTS: Record<RecordingSource, { open: string; held: string }> = {
  region: {
    open: "Drag to choose the area to record, or click a window.",
    held: "Drag the handles to adjust, then press Record.",
  },
  window: { open: "Click a window to record it.", held: "Press Record to start, or click another window." },
  screen: { open: "Click this display to record it.", held: "Press Record to record this display." },
};
const WINDOW_HINT = "Click a window to capture it. Esc cancels.";
/** All-in-one, once a region is selected and waits to be confirmed. */
const ADJUST_HINT = "Drag the handles to adjust, then press Enter. Esc cancels.";
/** Room the size field and ratio presets take beside a selection; an estimate. */
const SIZE_PANEL: Size = { width: 470, height: 46 };
/** The size and ratio chip beside a recording's region, which has no button. */
const SIZE_CHIP: Size = { width: 300, height: 46 };
/** Half the setup toolbar's height, and room for the hint beside it, in CSS px. */
const SETUP_HALF = 23;
const SETUP_HINT_GAP = 10;
/** Room the setup toolbar takes under All-in-one's mode toolbar, gap included. */
const SETUP_ROOM = 54;
/** How near the edge the setup toolbar's centre may be dragged. */
const SETUP_EDGE = 40;
/**
 * The hovered window's rounded corners, in CSS px. Matches `.overlay-window`
 * and `.overlay-dim-corner`.
 */
const WINDOW_RADIUS = 10;

/**
 * All-in-one's modes, in the order of their number keys. Screen captures
 * as soon as it is picked; the others say what the next selection is for.
 */
type Tool = "region" | "window" | "screen" | "text" | "color" | "record" | "scroll";

const TOOLS: { tool: Tool; label: string; icon: ReactNode }[] = [
  { tool: "region", label: "Region", icon: <RegionIcon /> },
  { tool: "window", label: "Window", icon: <WindowIcon /> },
  { tool: "screen", label: "Screen", icon: <ScreenIcon /> },
  { tool: "text", label: "Text", icon: <TextIcon /> },
  { tool: "color", label: "Colour", icon: <ColourIcon /> },
  { tool: "record", label: "Record", icon: <RecordIcon /> },
  { tool: "scroll", label: "Scroll", icon: <ScrollIcon /> },
];
/** The Timer's settings in seconds, in the order a click steps through them. */
const TIMER_STEPS = [0, 3, 5, 10];
/** The Timer's number key, after the modes'. */
const TIMER_KEY = TOOLS.length + 1;
/** Room the toolbar takes above the hint, gap included, in CSS px. */
const TOOLBAR_ROOM = 52;

/** All-in-one's aspect ratio presets: width over height, or none. */
type RatioId = "free" | "16:9" | "4:3" | "1:1";
const RATIOS: { id: RatioId; label: string; value: number | null }[] = [
  { id: "free", label: "Free", value: null },
  { id: "16:9", label: "16:9", value: 16 / 9 },
  { id: "4:3", label: "4:3", value: 4 / 3 },
  { id: "1:1", label: "1:1", value: 1 },
];

/** What confirms each kind of selection, on the button beside it. */
const CONFIRM_LABELS: Record<OverlayIntent, string> = {
  capture: "Capture",
  text: "Copy text",
  color: "Capture",
  record: "Record",
  scroll: "Start scrolling",
};

/**
 * An adjustable selection being changed: by a handle, or moved as a whole
 * from inside it. `box` is the selection when the pointer went down.
 */
interface Grab {
  handle: Handle | "move";
  from: Point;
  box: Box;
}

/** Keys typed into a field are the field's, not the overlay's shortcuts. */
function isField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement;
}

function toolIntent(tool: Tool): OverlayIntent {
  return tool === "text" || tool === "color" || tool === "record" || tool === "scroll" ? tool : "capture";
}

/** The toolbar mode another monitor's overlay chose, from its choice. */
function toolOf(choice: OverlayChoice): Tool {
  if (choice.intent !== "capture") return choice.intent;
  return choice.mode === "window" ? "window" : "region";
}

/** The Timer only delays screenshots: Region, Window and Screen. */
function isTimed(tool: Tool): boolean {
  return toolIntent(tool) === "capture";
}

/** The number key pressed, 1 to 9, from the top row or the keypad. */
function digitOf(event: KeyboardEvent): number | null {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code) ?? /^([1-9])$/.exec(event.key);
  return match ? Number(match[1]) : null;
}

function viewport(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

function pointOf(event: MouseEvent): Point {
  return { x: event.clientX, y: event.clientY };
}

/** Turns the image bytes into a URL the <img> can show. */
function toImageUrl(bytes: ArrayBuffer): string | null {
  if (typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(new Blob([bytes], { type: imageType(bytes) }));
}

/** The corners of a box, in the order `holeCorners` and `frameParts` give them. */
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

interface SelectionFrameProps {
  box: Box;
  /** Left out for an adjustable selection, which has the size field instead. */
  label?: string;
  placement: LabelPlacement;
  /** All-in-one's adjustable selection: a handle on each corner and edge. */
  handles?: boolean;
}

/**
 * The region being dragged: a border just outside it, a tick at each corner
 * and its size beside it.
 *
 * Every piece is placed by a transform. As one element the size of the
 * selection, the border was laid out and painted again, a layer that large,
 * on every pointer move.
 */
function SelectionFrame({ box, label, placement, handles = false }: SelectionFrameProps) {
  const { edges, ticks } = frameParts(box);
  return (
    <div className="overlay-frame" data-testid="overlay-selection">
      {edges.map((edge, at) => (
        <span key={at} className="overlay-frame-edge" style={{ transform: stretch(edge) }} />
      ))}
      {ticks.map((tick, at) => (
        <span
          key={at}
          className="overlay-frame-tick"
          data-corner={CORNERS[at]}
          style={{ transform: moveTo(tick), width: tick.width, height: tick.height }}
        />
      ))}
      {handles &&
        HANDLES.map((handle) => (
          <span
            key={handle}
            className="overlay-handle"
            data-handle={handle}
            data-testid={`overlay-handle-${handle}`}
            style={{ transform: `${moveTo(handlePoint(box, handle))} translate(-50%, -50%)` }}
          />
        ))}
      {label !== undefined && (
        <span
          className="overlay-label"
          data-testid="overlay-size"
          style={{ transform: labelTransform(box, placement) }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

interface SizePanelProps {
  /** The selection's size in image pixels. */
  size: Size;
  ratio: RatioId;
  /** Left out beside a recording's region: the setup toolbar's Record starts it. */
  confirmLabel?: string;
  canConfirm: boolean;
  transform: string;
  onSize: (size: Size) => void;
  onRatio: (ratio: RatioId) => void;
  onConfirm: () => void;
  /** A second row, below the size: a recording's options. */
  children?: ReactNode;
}

/** A typed size: a whole number of image pixels, at least one. */
function parseLength(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Beside All-in-one's adjustable selection: its width and height in image
 * pixels, which take an exact size, the ratio presets, and the button that
 * confirms it. Placed by a transform, as it follows the selection.
 */
function SizePanel({
  size,
  ratio,
  confirmLabel,
  canConfirm,
  transform,
  onSize,
  onRatio,
  onConfirm,
  children,
}: SizePanelProps) {
  // What is being typed, until Enter or leaving the field applies it.
  const [draft, setDraft] = useState<{ width: string; height: string } | null>(null);
  const shown = draft ?? { width: String(size.width), height: String(size.height) };

  function apply() {
    if (!draft) return;
    setDraft(null);
    const width = parseLength(draft.width);
    const height = parseLength(draft.height);
    if (width === null || height === null) return;
    if (width !== size.width || height !== size.height) onSize({ width, height });
  }

  function field(side: "width" | "height", label: string) {
    return (
      <input
        className="overlay-size-input"
        type="text"
        inputMode="numeric"
        aria-label={label}
        data-testid={`overlay-size-${side}`}
        value={shown[side]}
        onChange={(event) => setDraft({ ...shown, [side]: event.target.value })}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Enter here sets the size; it only captures from outside the field.
          event.preventDefault();
          event.stopPropagation();
          apply();
        }}
      />
    );
  }

  return (
    <div
      className="overlay-size-panel"
      data-testid="overlay-size-panel"
      data-rows={children ? "2" : "1"}
      style={{ transform }}
      // A click on a button leaves the focus where it was, so Enter never
      // presses it again; the fields take the focus as fields do.
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) event.preventDefault();
      }}
    >
      <div className="overlay-size-row">
        {field("width", "Width")}
        <span aria-hidden="true">×</span>
        {field("height", "Height")}
        <span className="overlay-size-unit">px</span>
        <span className="overlay-toolbar-gap" aria-hidden="true" />
        <div className="overlay-ratios" role="group" aria-label="Aspect ratio">
          {RATIOS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className="overlay-tool overlay-ratio"
              aria-pressed={id === ratio}
              onClick={() => onRatio(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {confirmLabel !== undefined && (
          <>
            <span className="overlay-toolbar-gap" aria-hidden="true" />
            <button
              type="button"
              className="overlay-tool overlay-confirm"
              data-testid="overlay-confirm"
              disabled={!canConfirm}
              onClick={onConfirm}
            >
              <span>{confirmLabel}</span>
              <kbd aria-hidden="true">Enter</kbd>
            </button>
          </>
        )}
      </div>
      {children}
    </div>
  );
}

interface ToolbarProps {
  tool: Tool;
  timer: number;
  hidden: boolean;
  top: number;
  onTool: (tool: Tool) => void;
  onTimer: () => void;
}

/**
 * All-in-one's mode toolbar: a button per mode, numbered by its key, and the
 * Timer. It never follows the pointer.
 */
function Toolbar({ tool, timer, hidden, top, onTool, onTimer }: ToolbarProps) {
  const timed = isTimed(tool);
  return (
    <div
      className="overlay-toolbar"
      role="toolbar"
      aria-label="Capture mode"
      data-testid="overlay-toolbar"
      data-hidden={hidden ? "true" : "false"}
      style={{ top }}
      // Clicks leave the focus where it was, so Enter and Space never press
      // the last button again.
      onMouseDown={(event) => event.preventDefault()}
    >
      {TOOLS.map(({ tool: each, label, icon }, at) => (
        <button
          key={each}
          type="button"
          className="overlay-tool"
          aria-pressed={each === "screen" ? undefined : each === tool}
          title={`${label} (${at + 1})`}
          onClick={() => onTool(each)}
        >
          {icon}
          <span>{label}</span>
          <kbd aria-hidden="true">{at + 1}</kbd>
        </button>
      ))}
      <span className="overlay-toolbar-gap" aria-hidden="true" />
      <button
        type="button"
        className="overlay-tool"
        data-testid="overlay-timer"
        data-active={timed && timer > 0 ? "true" : "false"}
        disabled={!timed}
        title={`Timer (${TIMER_KEY})`}
        onClick={onTimer}
      >
        <TimerIcon />
        <span>{timer > 0 ? `Timer ${timer} s` : "Timer off"}</span>
        <kbd aria-hidden="true">{TIMER_KEY}</kbd>
      </button>
    </div>
  );
}

/**
 * Shows one monitor, frozen, fullscreen. What a selection means depends on
 * the intent: "capture" drags a region or clicks a window (window mode only
 * clicks windows), "text" only drags, and "color" picks the pixel under a
 * click. While dragging, Shift keeps the selection square and Space moves it.
 * Esc or right-click cancels.
 *
 * Opened by All-in-one, a toolbar at the top switches between those modes
 * in place, keys 1 to 6 pick them and 7 steps the Timer through off, 3, 5
 * and 10 s. Screen captures every monitor as frozen the moment it is
 * picked. With the Timer on, the overlay closes on the selection and the
 * backend captures the same area live once the time is up.
 *
 * In All-in-one a released drag stays selected, with handles that resize
 * it, room inside to move it, a size field for an exact size in image
 * pixels and ratio presets; Enter or the button beside it confirms. The
 * last region starts out selected when it was on this monitor, and a drag
 * elsewhere replaces it.
 *
 * The page is usually loaded ahead of time in a hidden spare window, and
 * draws nothing until a selection starts on it.
 */
function RegionOverlay() {
  const [info, setInfo] = useState<OverlayInfo | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [square, setSquare] = useState(false);
  const [moving, setMoving] = useState(false);
  // A hidden window was shown once the frozen image was painted.
  const [revealed, setRevealed] = useState(false);
  // The window may be given its size after the page has loaded.
  const [, resized] = useReducer((count: number) => count + 1, 0);
  const done = useRef(false);
  const reported = useRef(false);
  const backdrop = useRef<HTMLCanvasElement>(null);
  // The blurred screen around a hovered window has been drawn.
  const [backdropReady, setBackdropReady] = useState(false);
  // The last window hovered, so the blur keeps its hole while it fades out.
  const [lastHovered, setLastHovered] = useState<Box | null>(null);
  // All-in-one's toolbar: the mode picked, and the Timer in seconds.
  const [tool, setTool] = useState<Tool>("region");
  const [timer, setTimer] = useState(0);
  const toolbar = useRef<HTMLDivElement>(null);
  // All-in-one's adjustable selection. Undefined until the user changes it,
  // so the last region (`info.lastRegion`) is shown at the current scale.
  const [picked, setPicked] = useState<Box | null | undefined>(undefined);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [ratio, setRatio] = useState<RatioId>("free");
  const sizePanel = useRef<HTMLDivElement>(null);
  // The Record overlay's setup toolbar: the window or display picked, and
  // where its centre was dragged to (null until it is).
  const setup = useRef<HTMLDivElement>(null);
  const [windowPick, setWindowPick] = useState<PickableWindow | null>(null);
  const [screenPick, setScreenPick] = useState<boolean | undefined>(undefined);
  const [setupAt, setSetupAt] = useState<Point | null>(null);
  const [gripping, setGripping] = useState<{ from: Point; centre: Point } | null>(null);

  /** Takes on a choice another monitor's toolbar made. */
  const follow = useEffectEvent((choice: OverlayChoice) => {
    setTool(toolOf(choice));
    setTimer(TIMER_STEPS.includes(choice.delaySeconds) ? choice.delaySeconds : 0);
    setDrag(null);
  });

  useEffect(() => {
    let cancelled = false;
    let started = false;
    let url: string | null = null;
    let unlisten: (() => void) | null = null;

    // Asks for the selection on this window. A spare has none until the
    // backend says one has started, so this runs once on load and again on
    // that event, whichever finds the selection first.
    function start() {
      overlayInfo()
        .then((loaded) => {
          if (cancelled || started || !loaded) return;
          started = true;
          setInfo(loaded);
          // Another monitor's toolbar may have chosen before this page loaded.
          if (loaded.allInOne && loaded.choice) follow(loaded.choice);
          return overlayImage().then((bytes) => {
            if (cancelled) return;
            url = toImageUrl(bytes);
            setImageUrl(url);
          });
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(String(err));
        });
    }

    // Listening before the first ask, so a selection that starts in
    // between is not missed.
    onOverlayStart(start)
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Without events, a window made for a selection still finds it.
      })
      .finally(start);
    return () => {
      cancelled = true;
      unlisten?.();
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);

  // A see-through window is on screen from the start, ahead of its image.
  const instant = isInstantOverlay();
  // A hidden window is shown once the frozen image is painted, so it swaps
  // in for the live desktop without a blank frame. An error is reported
  // too, or it would never be seen.
  const painted = (info !== null && (image !== null || instant)) || error !== null;
  useEffect(() => {
    if (!painted || reported.current) return;
    reported.current = true;
    overlayReady()
      .catch(() => {
        // The backend shows the window after a timeout regardless.
      })
      .finally(() => setRevealed(true));
  }, [painted]);
  // On screen with a selection to draw; until then nothing is dimmed.
  const shown = revealed || (instant && info !== null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (done.current) return;
        event.preventDefault();
        done.current = true;
        void cancelOverlay();
      } else if (event.key === "Shift") {
        // Tracked here as well as on mouse events so the selection snaps to a
        // square the moment Shift goes down, before the cursor moves again.
        setSquare(true);
      } else if ((event.code === "Space" || event.key === " ") && !isField(event.target)) {
        event.preventDefault();
        setMoving(true);
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "Shift") setSquare(false);
      else if (event.code === "Space" || event.key === " ") setMoving(false);
    }
    // A key released while another window has focus never reports its keyup.
    // Another display's overlay takes the focus as the pointer moves onto it,
    // so the crosshair and loupe go until the pointer comes back.
    function onBlur() {
      setSquare(false);
      setMoving(false);
      setGrab(null);
      setPointer(null);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const view = viewport();

  const allInOne = info?.allInOne === true;
  const intent = allInOne ? toolIntent(tool) : (info?.intent ?? "capture");
  const recording = useRecordingOptions(intent === "record");
  // What a recording records: the source used last, until another is picked.
  const source: RecordingSource | null =
    intent === "record" ? (recording.recording?.source ?? "region") : null;
  // Only screenshots can be of a window; text and colour ignore window mode.
  const windowMode =
    (intent === "capture" && (allInOne ? tool === "window" : info?.mode === "window")) ||
    source === "window";
  const screenSource = source === "screen";
  // A recording picks its area exactly as a screenshot does.
  const picksArea = intent === "capture" || intent === "record" || intent === "scroll";
  const canDrag = intent === "text" || (picksArea && !windowMode && !screenSource);
  const canPickWindow = picksArea && !screenSource;

  // Blurred once per image (and viewport size), not on every hover. In
  // All-in-one the canvas comes back with a mode that picks windows.
  useEffect(() => {
    if (!image || !backdrop.current) return;
    setBackdropReady(drawBackdrop(backdrop.current, image, view.width, view.height));
  }, [image, view.width, view.height, canPickWindow]);
  const pickable = useMemo<PickableWindow[]>(() => {
    if (!info) return [];
    const monitor = { width: info.monitorWidth, height: info.monitorHeight };
    const size = { width: view.width, height: view.height };
    return info.windows.map((win) => ({ window: win, box: monitorToCss(win, monitor, size) }));
  }, [info, view.width, view.height]);

  // Image pixels per CSS pixel, the same ratio the backend crops with. The
  // image's width is known before the image has loaded; without either
  // there is nothing to measure, so sizes read in CSS px.
  const imageWidth = image?.naturalWidth || info?.imageWidth || 0;
  const scale = imageWidth > 0 && view.width > 0 ? imageWidth / view.width : 1;

  // All-in-one keeps a dragged region selected until it is confirmed.
  // So is a recording's area, which waits to be set up and started.
  const adjustable = (allInOne || intent === "record") && canDrag;
  const ratioValue = adjustable ? (RATIOS.find((each) => each.id === ratio)?.value ?? null) : null;
  const preset = allInOne && info?.lastRegion ? fromImagePixels(info.lastRegion, scale) : null;
  const fullView: Box = { x: 0, y: 0, width: view.width, height: view.height };
  // Screen starts picked on the display the pointer is on.
  const screenPicked = screenPick ?? info?.pointerHere !== false;
  const held =
    source === "screen"
      ? screenPicked
        ? fullView
        : null
      : source === "window"
        ? (windowPick?.box ?? null)
        : adjustable
          ? picked === undefined
            ? preset
            : picked
          : null;

  const selection = drag && canDrag ? dragBox(drag, square, view, ratioValue) : null;
  const dragging = selection !== null && isDrag(selection);
  // A held selection being resized or moved follows the pointer as a drag does.
  const grabbing = grab !== null && held !== null;
  const active = dragging || grabbing;
  const framed = dragging ? selection : held;
  const hovered =
    canPickWindow && !dragging && !held && pointer ? topmostAt(pickable, pointer) : undefined;
  const highlight = framed ?? hovered?.box ?? null;
  // Boxes are memoized with the windows, so this settles in one extra render.
  if (hovered && hovered.box !== lastHovered) setLastHovered(hovered.box);
  const blurHole = hovered && !dragging ? hovered.box : lastHovered;

  function cancel() {
    if (done.current) return;
    done.current = true;
    void cancelOverlay();
  }

  /** What All-in-one's toolbar chose, sent with a selection made in `mode`. */
  function toolbarChoice(mode: OverlayChoice["mode"]): OverlayChoice {
    return { intent, mode, delaySeconds: isTimed(tool) ? timer : 0 };
  }

  /**
   * Shares a new mode or Timer with every other monitor's overlay, so the
   * selection finishes the same whichever monitor it is made on. The Timer
   * is sent as set, even while a mode that ignores it is picked.
   */
  function share(nextTool: Tool, seconds: number) {
    const choice: OverlayChoice = {
      intent: toolIntent(nextTool),
      mode: nextTool === "window" ? "window" : "region",
      delaySeconds: seconds,
    };
    chooseOverlay(choice).catch(() => {
      // This monitor still finishes with its own choice.
    });
  }

  function finish(picked: Selection) {
    if (done.current) return;
    done.current = true;
    // A recording's window or display is sent as the region it covers.
    const mode =
      picked.kind === "screen" ? "screen" : windowMode && intent !== "record" ? "window" : "region";
    finishOverlay(picked, allInOne ? toolbarChoice(mode) : undefined).catch((err: unknown) => {
      done.current = false;
      setError(String(err));
    });
  }

  function chooseTool(next: Tool) {
    if (next === "screen") {
      // Nothing to select: every monitor, as frozen.
      finish({ kind: "screen" });
      return;
    }
    // A held selection stays for the next mode that drags one.
    setTool(next);
    setDrag(null);
    share(next, timer);
    setGrab(null);
  }

  /** Captures, reads or records the held selection: Enter or its button. */
  function confirmHeld() {
    if (!held || !isDrag(held)) return;
    finish({ kind: "region", rect: held, viewportWidth: view.width });
  }

  /** The held selection at an exact size in image pixels, its corner kept. */
  function applySize(size: Size) {
    if (!held) return;
    // A typed size has a shape of its own.
    setRatio("free");
    const corner = { x: Math.round(held.x * scale), y: Math.round(held.y * scale) };
    const image = { width: Math.round(view.width * scale), height: Math.round(view.height * scale) };
    const pixels = withSize({ ...corner, width: 0, height: 0 }, size, image);
    setPicked(fromImagePixels(pixels, scale));
  }

  function chooseRatio(next: RatioId) {
    setRatio(next);
    const value = RATIOS.find((each) => each.id === next)?.value;
    if (held && value) setPicked(snapToImage(withRatio(held, value, view), scale));
  }

  /** Records from another source, saved so the next Record opens on it. */
  function chooseSource(next: RecordingSource) {
    const current = recording.recording;
    setDrag(null);
    setGrab(null);
    if (current && current.source !== next) recording.save({ ...current, source: next });
  }

  function stepTimer() {
    if (!isTimed(tool)) return;
    const seconds = TIMER_STEPS[(TIMER_STEPS.indexOf(timer) + 1) % TIMER_STEPS.length];
    setTimer(seconds);
    share(tool, seconds);
  }

  // Another monitor's toolbar changed: follow it, without sharing it back.
  // Listening from the start, not once the info says All-in-one, so a
  // choice made while this page loads is not missed; only All-in-one
  // selections send it.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onOverlayChoice((choice) => follow(choice))
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Then each monitor keeps its own choice.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const onToolKey = useEffectEvent((event: KeyboardEvent) => {
    // All-in-one's keys, and Enter and the sources' keys for a recording.
    const recordKeys = intent === "record";
    if (!(allInOne || adjustable || recordKeys) || event.ctrlKey || event.metaKey || event.altKey || event.repeat) {
      return;
    }
    if (isField(event.target)) return;
    if (event.key === "Enter") {
      if (!held) return;
      event.preventDefault();
      confirmHeld();
      return;
    }
    if (recordKeys && !allInOne) {
      const digit = digitOf(event);
      if (digit === null || digit > SOURCES.length) return;
      event.preventDefault();
      chooseSource(SOURCES[digit - 1].source);
      return;
    }
    if (!allInOne) return;
    const digit = digitOf(event);
    if (digit === null || digit > TIMER_KEY) return;
    event.preventDefault();
    if (digit === TIMER_KEY) stepTimer();
    else chooseTool(TOOLS[digit - 1].tool);
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => onToolKey(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * The toolbar and the size field take their own clicks; they never start
   * or end a selection.
   */
  function onToolbar(event: MouseEvent): boolean {
    const target = event.target as Node;
    return (
      (toolbar.current?.contains(target) ?? false) ||
      (sizePanel.current?.contains(target) ?? false) ||
      (setup.current?.contains(target) ?? false)
    );
  }

  function onMouseDown(event: MouseEvent) {
    if (event.button !== 0 || onToolbar(event)) return;
    const point = pointOf(event);
    setPointer(point);
    setSquare(event.shiftKey);
    // A recording's window or display is picked on release.
    if (source === "window" || source === "screen") return;
    if (held) {
      // On a handle it resizes, inside it moves; anywhere else starts anew.
      const handle = (event.target as HTMLElement).dataset?.handle as Handle | undefined;
      if (handle || contains(held, point)) {
        setGrab({ handle: handle ?? "move", from: point, box: held });
        return;
      }
    }
    setDrag({ anchor: point, head: point });
  }

  /** The held selection as `grab` leaves it with the pointer at `point`. */
  function grabbed(current: Grab, point: Point, shift: boolean): Box {
    const delta = { x: point.x - current.from.x, y: point.y - current.from.y };
    if (current.handle === "move") {
      // Moved by whole image pixels, so a box on the pixel grid (a typed
      // size, the last region) stays on it and keeps its exact size at any
      // scale. Towards zero, so the clamped move still stays on screen.
      const clamped = clampedDelta(current.box, delta, view);
      const whole = (value: number) => Math.trunc(value * scale) / scale;
      return translate(current.box, { x: whole(clamped.x), y: whole(clamped.y) });
    }
    return resizeBox(current.box, current.handle, delta, {
      bounds: view,
      ratio: shift ? 1 : ratioValue,
    });
  }

  function onMouseMove(event: MouseEvent) {
    const point = pointOf(event);
    const follow = () => {
      if (gripping) setSetupAt(gripped(gripping, point));
      if (grab) setPicked(grabbed(grab, point, event.shiftKey));
      if (drag) {
        const options = { move: moving, square: event.shiftKey, bounds: view, ratio: ratioValue };
        setDrag(advanceDrag(drag, pointer ?? point, point, options));
      }
      setPointer(point);
      // The event knows best: Shift may have changed while we were not focused.
      setSquare(event.shiftKey);
    };
    // Drawn before this event returns. React would otherwise render a pointer
    // move in a task of its own, and a frame that goes out in between shows
    // the selection where the pointer was a move ago.
    flushSync(follow);
  }

  /**
   * The pointer left for another display: its crosshair, loupe and window
   * highlight go with it rather than stay at the edge. A drag keeps them,
   * as its moves still arrive here.
   */
  function onMouseLeave() {
    if (drag || grab || gripping) return;
    setPointer(null);
  }

  function onMouseUp(event: MouseEvent) {
    if (event.button !== 0) return;
    if (gripping) {
      const centre = gripped(gripping, pointOf(event));
      setSetupAt(centre);
      setGripping(null);
      // The recording toolbar opens where this one was left, and so does the next.
      rememberSetupSpot(centre).catch(() => {
        // It still opens at the spot saved before.
      });
      return;
    }
    // A click on a toolbar picks nothing; a grab released over one still ends below.
    if ((source === "window" || source === "screen") && onToolbar(event)) return;
    if (source === "window") {
      // A click picks the window under it, or lets the picked one go.
      setDrag(null);
      const under = topmostAt(pickable, pointOf(event));
      const clipped = under ? clipToView(under.box, view) : null;
      setWindowPick(under && clipped ? { window: under.window, box: snapToImage(clipped, scale) } : null);
      return;
    }
    if (source === "screen") {
      setDrag(null);
      setScreenPick(true);
      return;
    }
    if (grab) {
      setPicked(grabbed(grab, pointOf(event), event.shiftKey));
      setGrab(null);
      return;
    }
    if (!drag) return;
    const end = pointOf(event);
    const options = { move: moving, square: event.shiftKey, bounds: view, ratio: ratioValue };
    const box = dragBox(
      advanceDrag(drag, pointer ?? end, end, options),
      event.shiftKey,
      view,
      ratioValue,
    );
    setDrag(null);
    if (intent === "color") {
      finish({ kind: "point", x: end.x, y: end.y, viewportWidth: view.width });
      return;
    }
    if (canDrag && isDrag(box)) {
      // All-in-one holds it for adjusting; elsewhere a drag captures at once.
      if (adjustable) setPicked(box);
      else finish({ kind: "region", rect: box, viewportWidth: view.width });
      return;
    }
    if (held) {
      // A click away from the selection lets it go, and windows can be picked again.
      setPicked(null);
      return;
    }
    const under = canPickWindow ? topmostAt(pickable, end) : undefined;
    if (!under) return;
    // A recording holds the window's area, to be set up and started.
    if ((intent === "record" || intent === "scroll") && adjustable) {
      const clipped = clipToView(under.box, view);
      if (clipped) {
        setPicked(snapToImage(clipped, scale));
        return;
      }
    }
    finish({ kind: "window", id: under.window.id });
  }

  /** Where the setup toolbar's centre is with the pointer at `point`, kept on screen. */
  function gripped(current: { from: Point; centre: Point }, point: Point): Point {
    const clamp = (value: number, max: number) =>
      Math.min(Math.max(value, Math.min(SETUP_EDGE, max / 2)), Math.max(max - SETUP_EDGE, max / 2));
    return {
      x: clamp(current.centre.x + point.x - current.from.x, view.width),
      y: clamp(current.centre.y + point.y - current.from.y, view.height),
    };
  }

  // A drag is labelled with the size it will be captured at, in image pixels.
  const captured = dragging ? imageSize(selection, scale) : null;
  const label = captured
    ? `${captured.width} × ${captured.height}`
    : hovered?.window.title || hovered?.window.appName;
  const placement = highlight
    ? labelPlacement(
        highlight,
        dragging ? SIZE_LABEL : held ? (intent === "record" ? SIZE_CHIP : SIZE_PANEL) : TITLE_LABEL,
        view,
      )
    : null;
  const heldSize = held ? imageSize(held, scale) : null;

  // The setup toolbar: in every Record overlay on the display the pointer
  // is on (or with a pick of its own), centred where the recording toolbar
  // opens; in All-in-one, under the mode toolbar.
  const top = hintTop(info?.topInset, view.height);
  const showSetup =
    info !== null && intent === "record" && (allInOne || info.pointerHere !== false || held !== null);
  const setupCentre: Point = allInOne
    ? { x: view.width / 2, y: top + TOOLBAR_ROOM + SETUP_HALF }
    : (setupAt ?? info?.barCentre ?? { x: view.width / 2, y: top + SETUP_HALF });
  const setupLow = setupCentre.y > view.height / 2;
  // The hint goes under the setup toolbar, or over it in the lower half.
  const hintAt: { top: number; left?: number } = !showSetup
    ? { top: top + (allInOne ? TOOLBAR_ROOM : 0) }
    : allInOne
      ? { top: top + TOOLBAR_ROOM + SETUP_ROOM }
      : {
          top: setupLow
            ? setupCentre.y - SETUP_HALF - SETUP_HINT_GAP - 34
            : setupCentre.y + SETUP_HALF + SETUP_HINT_GAP,
          left: setupCentre.x,
        };
  // The picked window's or display's name, with its size in image pixels.
  const nameTag =
    held && heldSize && source === "window" && windowPick
      ? `${windowPick.window.title || windowPick.window.appName} · ${heldSize.width} × ${heldSize.height}`
      : held && heldSize && source === "screen"
        ? `${info?.monitorName || "This display"} · ${heldSize.width} × ${heldSize.height}`
        : null;
  const hintText =
    error ??
    (source
      ? `${RECORD_HINTS[source][held ? "held" : "open"]} Esc cancels.`
      : windowMode
        ? WINDOW_HINT
        : held
          ? ADJUST_HINT
          : HINTS[intent]);

  return (
    <div
      className="overlay"
      data-testid="overlay"
      data-ready={info ? "true" : "false"}
      data-intent={intent}
      data-mode={windowMode ? "window" : "region"}
      data-source={source ?? undefined}
      data-dragging={active ? "true" : "false"}
      data-moving={(dragging && moving) || grab?.handle === "move" ? "true" : "false"}
      data-selected={held && !dragging ? "true" : "false"}
      data-over={
        held && !dragging && pointer && contains(held, pointer) ? "selection" : undefined
      }
      data-shown={shown ? "true" : "false"}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseLeave}
      onContextMenu={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      {imageUrl && (
        <img
          className="overlay-image"
          src={imageUrl}
          alt=""
          draggable={false}
          onLoad={(event) => {
            const img = event.currentTarget;
            // Decoded before it counts as painted, so showing the window
            // never catches it half drawn.
            const decoded = typeof img.decode === "function" ? img.decode() : Promise.resolve();
            decoded.catch(() => {}).finally(() => setImage(img));
          }}
        />
      )}
      {/*
        The tint, in four pieces around the selection or the hovered window.
        Each is a solid colour stretched into place by a transform, so a drag
        moves them without anything being laid out or painted again.
      */}
      {intent !== "color" && (
        // Colours have to be judged as they are, so the colour picker never dims.
        <div
          // A hole that appears or goes does so at once; only a move from
          // one window to the next glides.
          key={highlight ? "hole" : "whole"}
          className="overlay-dim"
          data-testid="overlay-dim"
        >
          {surround(highlight, view).map((piece, at) => (
            <span key={at} className="overlay-dim-piece" style={{ transform: stretch(piece) }} />
          ))}
          {highlight &&
            !framed &&
            holeCorners(highlight, WINDOW_RADIUS).map((corner, at) => (
              <span
                key={at}
                className="overlay-dim-corner"
                data-corner={CORNERS[at]}
                style={{ transform: moveTo(corner) }}
              />
            ))}
        </div>
      )}
      {/* Around a hovered window the frozen screen is blurred; the window itself stays sharp. */}
      {canPickWindow && (
        <canvas
          ref={backdrop}
          className="overlay-backdrop"
          data-testid="overlay-blur"
          data-active={backdropReady && hovered && !framed ? "true" : "false"}
          aria-hidden="true"
          style={blurHole ? { clipPath: cutoutPath(blurHole, view, WINDOW_RADIUS) } : undefined}
        />
      )}
      {selection && dragging && placement && (
        <SelectionFrame box={selection} label={label ?? ""} placement={placement} />
      )}
      {held && !dragging && placement && source !== "screen" && (
        <SelectionFrame box={held} placement={placement} handles={source === null || source === "region"} />
      )}
      {held && source === "screen" && (
        <div className="overlay-screen-frame" data-testid="overlay-screen" aria-hidden="true" />
      )}
      {nameTag && held && placement && (
        <span
          className="overlay-name-tag"
          data-testid="overlay-name-tag"
          style={{
            transform:
              source === "screen"
                ? `translate3d(${view.width / 2}px, ${view.height / 2}px, 0) translate(-50%, -50%)`
                : labelTransform(held, placement),
          }}
        >
          {nameTag}
        </span>
      )}
      {held && !dragging && placement && heldSize && (source === null || source === "region") && (
        <div ref={sizePanel}>
          <SizePanel
            size={heldSize}
            ratio={ratio}
            confirmLabel={source ? undefined : CONFIRM_LABELS[intent]}
            canConfirm={isDrag(held)}
            transform={labelTransform(held, placement)}
            onSize={applySize}
            onRatio={chooseRatio}
            onConfirm={confirmHeld}
          />
        </div>
      )}
      {hovered && !framed && placement && (
        <div
          className="overlay-window"
          data-testid="overlay-selection"
          style={{
            left: hovered.box.x,
            top: hovered.box.y,
            width: hovered.box.width,
            height: hovered.box.height,
          }}
        >
          <span className="overlay-label" data-side={placement.side} data-align={placement.align}>
            {label}
          </span>
        </div>
      )}
      {canDrag && pointer && !active && (
        <>
          <div
            className="overlay-guide overlay-guide-x"
            data-testid="overlay-guide-x"
            aria-hidden="true"
            style={{ transform: `translate3d(0, ${pointer.y}px, 0)` }}
          />
          <div
            className="overlay-guide overlay-guide-y"
            data-testid="overlay-guide-y"
            aria-hidden="true"
            style={{ transform: `translate3d(${pointer.x}px, 0, 0)` }}
          />
        </>
      )}
      {!windowMode && !screenSource && pointer && (
        <Loupe image={image} pointer={pointer} scale={scale} viewport={view} />
      )}
      {allInOne && (
        <div ref={toolbar}>
          <Toolbar
            tool={tool}
            timer={timer}
            hidden={active}
            top={top}
            onTool={chooseTool}
            onTimer={stepTimer}
          />
        </div>
      )}
      {showSetup && source && (
        <div ref={setup} data-hidden={active ? "true" : "false"}>
          <RecordSetup
            options={recording}
            source={source}
            numbered={!allInOne}
            canRecord={held !== null && isDrag(held)}
            up={setupLow}
            transform={`translate3d(${setupCentre.x}px, ${setupCentre.y}px, 0) translate(-50%, -50%)`}
            onGrip={
              allInOne
                ? undefined
                : (event) => setGripping({ from: pointOf(event), centre: setupCentre })
            }
            onSource={chooseSource}
            onRecord={confirmHeld}
            onCancel={cancel}
          />
        </div>
      )}
      <div
        className="overlay-hint"
        data-hidden={active && !error ? "true" : "false"}
        style={hintAt.left === undefined ? { top: hintAt.top } : { top: hintAt.top, left: hintAt.left }}
      >
        <p className="overlay-hint-text" role="status" data-error={error ? "true" : "false"}>
          {hintText}
        </p>
        <ul className="overlay-keys" aria-label="Keyboard shortcuts">
          <li>
            <kbd>Esc</kbd> Cancel
          </li>
          {allInOne && (
            <li>
              <kbd>1</kbd>–<kbd>{TIMER_KEY}</kbd> Mode
            </li>
          )}
          {source && !allInOne && (
            <li>
              <kbd>1</kbd>–<kbd>{SOURCES.length}</kbd> Source
            </li>
          )}
          {held && (
            <li>
              <kbd>Enter</kbd> {CONFIRM_LABELS[intent]}
            </li>
          )}
          {canDrag && (
            <>
              <li>
                <kbd>Shift</kbd> Square
              </li>
              <li>
                <kbd>Space</kbd> Move
              </li>
            </>
          )}
        </ul>
      </div>
    </div>
  );
}

export default RegionOverlay;
