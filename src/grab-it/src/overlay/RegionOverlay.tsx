import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  cancelOverlay,
  chooseOverlay,
  rememberSetupSpot,
  finishOverlay,
  holdOverlay,
  imageType,
  isInstantOverlay,
  isWindowsOverlay,
  onOverlayRevealed,
  onOverlayChoice,
  onOverlayHold,
  onOverlayStart,
  openScrollDocs,
  overlayHeldElsewhere,
  overlayImage,
  overlayInfo,
  overlayReady,
  rememberScrollByHand,
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
import Loupe from "./Loupe";
import { benchMark, benchOpaque, benchSpan, benchSwitch, runBench, setupBench } from "./bench";
import RecordSetup, { RecordOptionsFields } from "./RecordSetup";
import ScrollGuide from "./ScrollGuide";
import { nextGuideEdge, showsGuide, type GuideEdge } from "./guidePlace";
import { startLabelY, type Blocker } from "./scrollStart";
import { useAccessibility } from "./useAccessibility";
import { nextCountdown } from "./recordOptions";
import { ChooserToolbar, SizeFields } from "./ChooserToolbar";
import { EMPTY_TRAIL, movedTo, pointedAt, reachedToolbar } from "./pointerRest";
import { RATIOS, TIMER_KEY, TIMER_STEPS, TOOLS, toolbarLayout, type RatioId, type Tool } from "./chooser";
import { SOURCES, useRecordingOptions } from "./recordSources";
import type { RecordingSource } from "../settings/api";
import { effectiveHotkeys, type BindingLabels } from "../app/api";
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
  scroll: "Drag an area or click a window, then press Enter to start scrolling. Esc cancels.",
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
/** The size and ratio chip beside a recording's region, which has no button. */
const SIZE_CHIP: Size = { width: 300, height: 46 };
/** Half the setup toolbar's height, and room for the hint beside it, in CSS px. */
const SETUP_HALF = 23;
const SETUP_HINT_GAP = 10;
/** How near the edge the setup toolbar's centre may be dragged. */
const SETUP_EDGE = 40;
/** Scroll's guide's height until it has been measured, and its widest, in CSS px. */
const SCROLL_GUIDE_HEIGHT = 360;
const SCROLL_GUIDE_WIDTH = 440;
/** Its padding and border across, outside that width. */
const SCROLL_GUIDE_EDGES = 34;
/** Scroll's guide's gap above the bottom edge (`.scroll-guide[data-edge="bottom"]`) and below the toolbar. */
const SCROLL_GUIDE_BOTTOM = 24;
const SCROLL_GUIDE_TOP_GAP = 8;
/** How far in from the held area's left edge Image starts here sits, clear of the corner handle. */
const SCROLL_START_INSET = 16;
/**
 * The hovered window's rounded corners, in CSS px. Matches `.overlay-window`
 * and `.overlay-dim-corner`.
 */
const WINDOW_RADIUS = 10;

/** Room Capture & record's toolbar takes, gap included, in CSS px; a second row adds `TOOLBAR_ROW`. */
const TOOLBAR_ROOM = 58;
const TOOLBAR_ROW = 44;
/** The toolbar's gap from the bottom edge, when it moves there out of a selection's way. */
const TOOLBAR_BOTTOM = 12;
/**
 * Room Record's options take in the toolbar, in CSS px: Record lays the
 * toolbar out as a display this much narrower would, so its options shrink
 * and then move to a second row sooner.
 */
const RECORD_ROOM = 434;

/** What confirms each kind of selection: the main button's label, and the key tip's. */
const CONFIRM_LABELS: Record<OverlayIntent, string> = {
  capture: "Capture",
  text: "Copy text",
  color: "Copy colour",
  record: "Record",
  scroll: "Start scrolling",
};

/** What the main button's tooltip says once it can act. */
const MAIN_USES: Record<OverlayIntent, string> = {
  capture: "Captures the selection.",
  text: "Reads the text in the selection and copies it.",
  color: "Copies the colour of the pixel under the pointer.",
  record: "Starts recording.",
  scroll: "Starts the scrolling capture.",
};

/** What the dimmed main button's tooltip asks for first. */
const FIRST_STEPS: Record<OverlayIntent | "window", string> = {
  capture: "Drag an area or click a window first.",
  window: "Point at a window first.",
  text: "Drag over the text first.",
  color: "Point at a colour first.",
  record: "Drag an area or click a window first.",
  scroll: "Drag an area or click a window first.",
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
  transform: string;
  onSize: (size: Size) => void;
  onRatio: (ratio: RatioId) => void;
}

/**
 * Beside the Record overlay's adjustable region: its width and height in
 * image pixels, which take an exact size, and the ratio presets. Placed by
 * a transform, as it follows the selection. Also beside a recording's
 * region in Capture & record, whose toolbar shows these for screenshots.
 */
function SizePanel({ size, ratio, transform, onSize, onRatio }: SizePanelProps) {
  return (
    <div
      className="overlay-size-panel"
      data-testid="overlay-size-panel"
      style={{ transform }}
      // A click on a button leaves the focus where it was, so Enter never
      // presses it again; the fields take the focus as fields do.
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) event.preventDefault();
      }}
    >
      <div className="overlay-size-row">
        <SizeFields size={size} ratio={ratio} folded={false} up={false} onSize={onSize} onRatio={onRatio} />
      </div>
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
 * Opened by Capture & record, one toolbar at the top switches between those
 * modes in place, keys 1 to 7 pick them and 8 steps the Timer through off,
 * 3, 5 and 10 s. Screen captures every monitor as frozen the moment it is
 * picked. With the Timer on, the overlay closes on the selection and the
 * backend captures the same area live once the time is up. Tooltips on the
 * toolbar take the place of the hint line. Record stays in the same
 * toolbar: 1 to 3 pick what to record, its options fill the middle, 8 is
 * the countdown and the main button is a red Record. The Record overlay
 * opened on its own has a setup toolbar instead, with tooltips too.
 *
 * In Capture & record a released drag stays selected, with handles that
 * resize it and room inside to move it; the toolbar's middle section takes
 * an exact size in image pixels and ratio presets, and Enter or the main
 * button confirms. In Window, Enter captures the window under the pointer;
 * in Colour, the pixel under it. Over the toolbar the pointer stands for
 * where it last rested, so the main button acts on that. The last region starts out selected when
 * it was on this monitor, and a drag elsewhere replaces it.
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
  // Where the pointer rested, which it stands for while over a toolbar.
  const trail = useRef(EMPTY_TRAIL);
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
  // Scroll's setup: Grab-it scrolls unless the user chose Me, now or last time.
  const [scrollByHand, setScrollByHand] = useState(false);
  // Where Scroll's guide panel is drawn, so Image starts here stays clear of it.
  const guideWrap = useRef<HTMLDivElement>(null);
  const [guideBand, setGuideBand] = useState<Blocker | null>(null);
  // The edge the guide sits against. It moves only when a held area lies under it.
  const [guideEdge, setGuideEdge] = useState<GuideEdge>("bottom");
  // Whether the pointer is on this display: as the page was opened until
  // the pointer moves here or leaves. Only one display shows the guide.
  const [pointerOn, setPointerOn] = useState<boolean | null>(null);
  // The area held last is on another display, which shows the guide.
  const [heldElsewhere, setHeldElsewhere] = useState(false);
  // The area this overlay last told the backend it holds, or null.
  const toldHeld = useRef<string | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  // Each mode's global shortcut, for the toolbar's tooltips.
  // As the tray, hub and Library show them: only those registered, or the desktop's own on Wayland.
  const [hotkeys, setHotkeys] = useState<BindingLabels>({});
  // The toolbar's copy of the loupe's colour, written as the loupe draws.
  const colourText = useRef<HTMLSpanElement>(null);
  const colourSwatch = useRef<HTMLSpanElement>(null);
  // Written straight to the DOM, as the loupe writes its own, so a pointer
  // move renders the overlay once.
  const showColour = useCallback((hex: string | null) => {
    const text = colourText.current;
    const swatch = colourSwatch.current;
    if (text) text.textContent = hex ?? "—";
    if (swatch) swatch.style.backgroundColor = hex ?? "transparent";
  }, []);
  // All-in-one's adjustable selection. Undefined until the user changes it,
  // so the last region (`info.lastRegion`) is shown at the current scale.
  const [picked, setPicked] = useState<Box | null | undefined>(undefined);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [ratio, setRatio] = useState<RatioId>("free");
  const sizePanel = useRef<HTMLDivElement>(null);
  // A recording's window or display picked, and where the Record overlay's
  // setup toolbar's centre was dragged to (null until it is).
  const setup = useRef<HTMLDivElement>(null);
  const [windowPick, setWindowPick] = useState<PickableWindow | null>(null);
  const [screenPick, setScreenPick] = useState<boolean | undefined>(undefined);
  const [setupAt, setSetupAt] = useState<Point | null>(null);
  const [gripping, setGripping] = useState<{ from: Point; centre: Point } | null>(null);

  /** Takes on a choice another monitor's toolbar made. */
  const follow = useEffectEvent((choice: OverlayChoice) => {
    setTool(toolOf(choice));
    setTimer(TIMER_STEPS.includes(choice.delaySeconds) ? choice.delaySeconds : 0);
    if (typeof choice.scrollByHand === "boolean") setScrollByHand(choice.scrollByHand);
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
      benchMark("start");
      overlayInfo()
        .then((loaded) => {
          if (cancelled || started || !loaded) return;
          started = true;
          benchMark("info");
          setInfo(loaded);
          // The Who scrolls? card picked last time.
          setScrollByHand(loaded.scrollByHand === true);
          setHeldElsewhere(loaded.heldElsewhere === true);
          // Another monitor's toolbar may have chosen before this page loaded.
          if (loaded.allInOne && loaded.choice) follow(loaded.choice);
          return overlayImage().then((bytes) => {
            benchMark("bytes");
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

  const loadsHotkeys = info?.allInOne === true;
  useEffect(() => {
    if (!loadsHotkeys) return;
    let cancelled = false;
    effectiveHotkeys()
      .then((labels) => {
        if (!cancelled) setHotkeys(labels ?? {});
      })
      .catch(() => {
        // The tooltips leave the global shortcuts out.
      });
    return () => {
      cancelled = true;
    };
  }, [loadsHotkeys]);

  useEffect(() => {
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);

  // A see-through window is on screen from the start, ahead of its image.
  const instant = isInstantOverlay();
  const windows = isWindowsOverlay();
  const [hasRevealListener, setHasRevealListener] = useState<boolean | null>(null);
  useEffect(() => {
    if (!windows) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onOverlayRevealed(() => setRevealed(true)).then((stop) => {
      if (cancelled) stop();
      else {
        unlisten = stop;
        setHasRevealListener(true);
      }
    }).catch(() => {
      if (!cancelled) setHasRevealListener(false);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [windows]);
  // A hidden window waits for its decoded image, except on Windows, where
  // the frozen screen is already on show under this see-through page. An
  // error is reported too, or it would never be seen. Windows tints the
  // overlays after all are shown.
  const readyToShow =
    (info !== null && (image !== null || instant || windows)) || error !== null;
  useEffect(() => {
    if (!readyToShow || reported.current || (windows && hasRevealListener === null)) return;
    reported.current = true;
    overlayReady()
      .catch(() => {})
      .finally(() => {
        if (!hasRevealListener) setRevealed(true);
      });
  }, [hasRevealListener, readyToShow, windows]);
  // On screen with a selection to draw; until then nothing is dimmed.
  const shown = revealed || (instant && info !== null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (done.current) return;
        event.preventDefault();
        // The first Esc leaves the toolbar; the next one cancels.
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('[data-testid="overlay-toolbar"]')) {
          target.blur();
          return;
        }
        done.current = true;
        void cancelOverlay();
      } else if (event.key === "Shift") {
        // Tracked here as well as on mouse events so the selection snaps to a
        // square the moment Shift goes down, before the cursor moves again.
        setSquare(true);
      } else if ((event.code === "Space" || event.key === " ") && !isField(event.target) && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        setMoving(true);
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "Shift") setSquare(false);
      else if (event.code === "Space" || event.key === " ") setMoving(false);
    }
    // On macOS the focus follows the pointer from display to display
    // (`follow_pointer`), so it arrives with the pointer even before it
    // moves. Elsewhere each overlay takes the focus as it is shown.
    const focusFollowsPointer = isInstantOverlay();
    // A key released while another window has focus never reports its keyup.
    // Another display's overlay takes the focus as the pointer moves onto it,
    // so the crosshair and loupe go until the pointer comes back.
    function onBlur() {
      setSquare(false);
      setMoving(false);
      setGrab(null);
      setPointer(null);
      if (focusFollowsPointer) setPointerOn(false);
      trail.current = EMPTY_TRAIL;
    }
    function onFocus() {
      if (focusFollowsPointer) setPointerOn(true);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const view = viewport();

  // The overlay bench (`#/overlay?bench`): once the image is painted, replay
  // a hover and a drag. Off, `setupBench` resolves false having called nothing.
  const root = useRef<HTMLDivElement>(null);
  const benched = useRef(false);
  useEffect(() => {
    if (!image || benched.current || !root.current) return;
    benched.current = true;
    const target = root.current;
    void setupBench().then((on) => {
      if (!on) return;
      requestAnimationFrame(() => {
        benchMark("painted");
        if (benchSwitch("opaque")) void benchOpaque();
        void runBench(target);
      });
    });
  }, [image]);

  const allInOne = info?.allInOne === true;
  const intent = allInOne ? toolIntent(tool) : (info?.intent ?? "capture");
  const accessibility = useAccessibility(intent === "scroll");
  const scrollManual = scrollByHand || accessibility === false;

  /**
   * Who scrolls, chosen in the guide, shared with every monitor's overlay
   * and remembered for the next capture. Only a card the user picks is
   * remembered, never the fallback to Me while Accessibility is off.
   */
  function chooseWhoScrolls(byHand: boolean) {
    setScrollByHand(byHand);
    share(tool, timer, byHand);
    rememberScrollByHand(byHand).catch(() => {
      // The next capture starts with the card picked before.
    });
  }
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
    const drawStarted = performance.now();
    setBackdropReady(drawBackdrop(backdrop.current, image, view.width, view.height));
    benchSpan("backdropMs", performance.now() - drawStarted);
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

  // Tells the other displays when this one holds a new area or lets it go,
  // once a move or resize is let go.
  // Its edges in image pixels, as `capture::css_to_image_rect` captures them.
  const heldKey = held
    ? [
        Math.floor(held.x * scale),
        Math.floor(held.y * scale),
        Math.ceil((held.x + held.width) * scale),
        Math.ceil((held.y + held.height) * scale),
      ].join(",")
    : null;
  const reportsHold = allInOne && grab === null;
  useEffect(() => {
    if (!reportsHold || heldKey === toldHeld.current) return;
    toldHeld.current = heldKey;
    holdOverlay(heldKey !== null).catch(() => {
      // Then the other displays keep their own guide.
    });
  }, [heldKey, reportsHold]);

  const selection = drag && canDrag ? dragBox(drag, square, view, ratioValue) : null;
  const dragging = selection !== null && isDrag(selection);
  // A held selection being resized or moved follows the pointer as a drag does.
  const grabbing = grab !== null && held !== null;
  const active = dragging || grabbing;
  const framed = dragging ? selection : held;
  const hovered =
    canPickWindow && !dragging && !held && pointer ? topmostAt(pickable, pointer) : undefined;
  const highlight = framed ?? hovered?.box ?? null;
  // On Windows the scaled WebView can clip stretched tint pieces at its
  // logical size. Cut the selection out of a viewport-sized background.
  const dimPath = windows && highlight ? cutoutPath(highlight, view, framed ? 0 : WINDOW_RADIUS) : undefined;
  // Boxes are memoized with the windows, so this settles in one extra render.
  if (hovered && hovered.box !== lastHovered) setLastHovered(hovered.box);
  const blurHole = hovered && !dragging ? hovered.box : lastHovered;

  function cancel() {
    if (done.current) return;
    done.current = true;
    void cancelOverlay();
  }

  /** The scrolling capture guide's docs link: cancels, then opens the page. */
  function openDocs() {
    if (done.current) return;
    done.current = true;
    openScrollDocs().catch(() => cancelOverlay());
  }

  /** What All-in-one's toolbar chose, sent with a selection made in `mode`. */
  function toolbarChoice(mode: OverlayChoice["mode"]): OverlayChoice {
    return {
      intent,
      mode,
      delaySeconds: isTimed(tool) ? timer : 0,
      // What the guide shows: by hand when chosen or when Grab-it may not scroll.
      ...(intent === "scroll" ? { scrollByHand: scrollManual } : {}),
    };
  }

  /**
   * Shares a new mode or Timer with every other monitor's overlay, so the
   * selection finishes the same whichever monitor it is made on. The Timer
   * is sent as set, even while a mode that ignores it is picked.
   */
  function share(nextTool: Tool, seconds: number, byHand: boolean = scrollByHand) {
    const choice: OverlayChoice = {
      intent: toolIntent(nextTool),
      mode: nextTool === "window" ? "window" : "region",
      delaySeconds: seconds,
      scrollByHand: byHand,
    };
    chooseOverlay(choice).catch(() => {
      // This monitor still finishes with its own choice.
    });
  }

  function finish(picked: Selection) {
    if (done.current) return;
    done.current = true;
    // Recording uses region geometry for each target.
    const mode =
      picked.kind === "screen" ? "screen" : windowMode && intent !== "record" ? "window" : "region";
    finishOverlay(picked, allInOne ? toolbarChoice(mode) : undefined).catch((err: unknown) => {
      done.current = false;
      setError(String(err));
    });
  }

  function chooseTool(chosen: Tool) {
    // Record again goes back to screenshots of what it was recording.
    const next: Tool = chosen === "record" && tool === "record" ? (source === "window" ? "window" : "region") : chosen;
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
    finish({
      kind: "region",
      rect: held,
      viewportWidth: view.width,
      ...(source === "window" && windowPick ? { windowId: windowPick.window.id } : {}),
    });
  }

  // What Enter or the main button acts on: the window or pixel under the
  // pointer in Window and Colour, else the held selection.
  const pointsAtWindow = allInOne && intent === "capture" && windowMode;
  const ready =
    intent === "color"
      ? pointer !== null
      : pointsAtWindow
        ? hovered !== undefined
        : held !== null && isDrag(held);

  /** The main button, or Enter: whatever the mode does with what is ready. */
  function confirmMain() {
    if (intent === "color") {
      if (pointer) finish({ kind: "point", x: pointer.x, y: pointer.y, viewportWidth: view.width });
      return;
    }
    if (pointsAtWindow) {
      if (hovered) finish({ kind: "window", id: hovered.window.id });
      return;
    }
    confirmHeld();
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

  /** Record's countdown, one step on, saved for the next recording too. */
  function stepCountdown() {
    const current = recording.recording;
    if (current) recording.save({ ...current, countdown: nextCountdown(current.countdown) });
  }

  function stepTimer() {
    if (intent === "record") {
      stepCountdown();
      return;
    }
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

  // An area was held or let go on any display: only the display holding
  // the area held last shows Scroll's guide.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onOverlayHold(() => {
      overlayHeldElsewhere()
        .then((elsewhere) => {
          if (!cancelled) setHeldElsewhere(elsewhere);
        })
        .catch(() => {
          // Then this display keeps what it knew.
        });
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Then each display decides for itself.
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
      // A focused button takes its own Enter.
      if (event.target instanceof HTMLButtonElement) return;
      if (held) {
        event.preventDefault();
        confirmHeld();
      } else if (allInOne && ready) {
        event.preventDefault();
        confirmMain();
      }
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
    // In Record, 1 to 3 pick what to record.
    if (intent === "record" && digit <= SOURCES.length) chooseSource(SOURCES[digit - 1].source);
    else if (digit === TIMER_KEY) stepTimer();
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
    setPointerOn(true);
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
    // A click that moves nothing leaves the area as it was.
    if (delta.x === 0 && delta.y === 0) return current.box;
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
    setPointerOn(true);
    // Over a toolbar the pointer stands for where it last rested, so the
    // main button acts on the window or pixel pointed at, not on what lies
    // under the toolbar or what the pointer crossed on its way there.
    if (!drag && !grab && !gripping && onToolbar(event)) {
      trail.current = reachedToolbar(trail.current, event.timeStamp);
      const target = pointedAt(trail.current);
      if (target) setPointer(target);
      return;
    }
    const point = pointOf(event);
    trail.current = movedTo(trail.current, point, event.timeStamp);
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
    // the selection where the pointer was a move ago. The bench's `lazy`
    // switch leaves it to React, to cost the difference.
    if (benchSwitch("lazy")) follow();
    else flushSync(follow);
  }

  /**
   * The pointer left for another display: its crosshair, loupe and window
   * highlight go with it rather than stay at the edge. A drag keeps them,
   * as its moves still arrive here.
   */
  function onMouseLeave() {
    if (drag || grab || gripping) return;
    setPointer(null);
    setPointerOn(false);
    trail.current = EMPTY_TRAIL;
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
        dragging ? SIZE_LABEL : held ? (allInOne && intent !== "record" ? SIZE_LABEL : SIZE_CHIP) : TITLE_LABEL,
        view,
      )
    : null;
  const heldSize = held ? imageSize(held, scale) : null;

  const top = hintTop(info?.topInset, view.height);
  const layout = toolbarLayout(view.width - (allInOne && intent === "record" ? RECORD_ROOM : 0));
  // Capture & record's size fields; Record keeps its size chip beside the
  // region, as the Record overlay does, and fills the middle with its options.
  const sizeInToolbar = allInOne && intent !== "record" && held !== null && !dragging && heldSize !== null;
  const secondRow = layout === "stacked" && (sizeInToolbar || intent === "record");
  const toolbarRoom = TOOLBAR_ROOM + (secondRow ? TOOLBAR_ROW : 0);
  // A held selection under the toolbar sends it to the bottom edge, if the
  // selection leaves room there. In Scroll the toolbar and guide stay put
  // while the area is resized or moved, and settle once it is let go.
  const placedBy = intent === "scroll" && grab ? grab.box : held;
  const toolbarEdge: "top" | "bottom" =
    allInOne &&
    placedBy !== null &&
    placedBy.y < top + toolbarRoom &&
    placedBy.y + placedBy.height <= view.height - TOOLBAR_BOTTOM - toolbarRoom
      ? "bottom"
      : "top";
  // Scroll's guide: under the toolbar, or above the bottom edge (and the
  // toolbar, when it went there). It starts at the bottom and moves only
  // when a held area lies under it.
  const guideTop = top + (allInOne && toolbarEdge === "top" ? toolbarRoom : 0);
  const guideBottom = SCROLL_GUIDE_BOTTOM + (allInOne && toolbarEdge === "bottom" ? toolbarRoom : 0);
  const guideHeight = guideBand ? guideBand.bottom - guideBand.top : SCROLL_GUIDE_HEIGHT;
  const guideWidth = guideBand
    ? guideBand.right - guideBand.left
    : Math.min(SCROLL_GUIDE_WIDTH, view.width - 32) + SCROLL_GUIDE_EDGES;
  const guideLeft = (view.width - guideWidth) / 2;
  const guideBands: Record<GuideEdge, Blocker> = {
    top: {
      top: guideTop + SCROLL_GUIDE_TOP_GAP,
      bottom: guideTop + SCROLL_GUIDE_TOP_GAP + guideHeight,
      left: guideLeft,
      right: guideLeft + guideWidth,
    },
    bottom: {
      top: view.height - guideBottom - guideHeight,
      bottom: view.height - guideBottom,
      left: guideLeft,
      right: guideLeft + guideWidth,
    },
  };
  const placedGuide = intent === "scroll" ? nextGuideEdge(guideEdge, grab ? null : held, guideBands) : guideEdge;
  if (placedGuide !== guideEdge) setGuideEdge(placedGuide);
  const showGuide =
    intent === "scroll" &&
    info !== null &&
    !dragging &&
    showsGuide(held !== null, heldElsewhere, pointerOn ?? info.pointerHere !== false);
  // Scroll's Image starts here: on the held area's top edge, or just inside
  // it when the toolbar or the guide panel covers that edge.
  const startAt =
    intent === "scroll" && held
      ? startLabelY(held.y, held.x + SCROLL_START_INSET, [
          ...(allInOne && toolbarEdge === "top" ? [{ top, bottom: top + toolbarRoom, left: 0, right: view.width }] : []),
          ...(guideBand ? [guideBand] : []),
        ])
      : null;
  // The Record overlay's setup toolbar: on the display the pointer is on
  // (or with a pick of its own), centred where the recording toolbar opens.
  // Capture & record shows Record in its own toolbar.
  const showSetup =
    info !== null && !allInOne && intent === "record" && (info.pointerHere !== false || held !== null);
  const setupCentre: Point = setupAt ?? info?.barCentre ?? { x: view.width / 2, y: top + SETUP_HALF };
  const setupLow = setupCentre.y > view.height / 2;
  // The hint (an error, there) goes under the setup toolbar, or over it in the lower half.
  const hintAt: { top: number; left?: number } = !showSetup
    ? { top: top + (allInOne ? toolbarRoom : 0) }
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
  // A toolbar explains itself in tooltips; the hint line stays for an
  // error, for an overlay opened for one mode, and for a Record overlay's
  // display that has no setup toolbar until it is clicked.
  const showHint = error !== null || (!allInOne && (intent !== "record" || !showSetup));
  const hintText =
    error ??
    (source
      ? `${RECORD_HINTS[source][held ? "held" : "open"]} Esc cancels.`
      : windowMode
        ? WINDOW_HINT
        : HINTS[intent]);

  // Measured once laid out: the panel's height follows its text and its
  // place follows the held area.
  useLayoutEffect(() => {
    const rect = guideWrap.current?.firstElementChild?.getBoundingClientRect();
    const next = rect && rect.height > 0 ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null;
    setGuideBand((current) =>
      current === next ||
      (current &&
        next &&
        current.top === next.top &&
        current.bottom === next.bottom &&
        current.left === next.left &&
        current.right === next.right)
        ? current
        : next,
    );
  }, [
    intent,
    info,
    dragging,
    held?.y,
    held?.height,
    scrollByHand,
    accessibility,
    view.width,
    view.height,
    top,
    toolbarRoom,
    showGuide,
    placedGuide,
    guideTop,
    guideBottom,
  ]);

  return (
    <div
      ref={root}
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
            // Decode before asking the backend to show the window.
            benchMark("loaded");
            const decoded = typeof img.decode === "function" ? img.decode() : Promise.resolve();
            decoded
              .catch(() => {})
              .finally(() => {
                benchMark("decoded");
                setImage(img);
              });
          }}
        />
      )}
      {intent !== "color" && (
        // Colours have to be judged as they are, so the colour picker never dims.
        <div
          // A hole that appears or goes does so at once; only a move from
          // one window to the next glides.
          key={highlight ? "hole" : "whole"}
          className={windows || !highlight ? "overlay-dim overlay-dim-fill" : "overlay-dim"}
          data-testid="overlay-dim"
          style={dimPath ? { clipPath: dimPath } : undefined}
        >
          {!windows && highlight && surround(highlight, view).map((piece, at) => (
            <span key={at} className="overlay-dim-piece" style={{ transform: stretch(piece) }} />
          ))}
          {!windows &&
            highlight &&
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
      {intent === "scroll" && held && startAt && !dragging && isDrag(held) && (
        <>
          <span
            className="scroll-start-label"
            data-testid="scroll-start-label"
            data-inside={startAt.inside ? "true" : "false"}
            style={{
              transform: `translate3d(${held.x + SCROLL_START_INSET}px, ${startAt.y}px, 0) translateY(-50%)`,
            }}
          >
            Image starts here
          </span>
          {!scrollManual && (
            <span
              className="scroll-direction"
              data-testid="scroll-direction"
              style={{
                transform: `translate3d(${held.x + held.width / 2}px, ${held.y + held.height - 12}px, 0) translate(-50%, -100%)`,
              }}
            >
              <span className="scroll-direction-arrow" aria-hidden="true">
                ↓
              </span>
              Grab-it scrolls down to the end
            </span>
          )}
        </>
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
      {(!allInOne || intent === "record") && held && !dragging && placement && heldSize && source === "region" && (
        <div ref={sizePanel}>
          <SizePanel
            size={heldSize}
            ratio={ratio}
            transform={labelTransform(held, placement)}
            onSize={applySize}
            onRatio={chooseRatio}
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
      {/* On Windows the page is shown ahead of its image: no empty loupe meanwhile. */}
      {!windowMode &&
        !screenSource &&
        pointer &&
        !(windows && image === null) &&
        !benchSwitch("noloupe") && (
        <Loupe
          image={image}
          pointer={pointer}
          scale={scale}
          viewport={view}
          onColour={intent === "color" ? showColour : undefined}
        />
      )}
      {allInOne && (
        <ChooserToolbar
          barRef={toolbar}
          tool={tool}
          timer={timer}
          showTimer={isTimed(tool)}
          source={source}
          countdown={recording.recording?.countdown ?? null}
          mainLabel={intent === "capture" && timer > 0 ? `Capture in ${timer} s` : CONFIRM_LABELS[intent]}
          ready={ready}
          mainUse={
            ready
              ? MAIN_USES[intent]
              : source
                ? (SOURCES.find((each) => each.source === source)?.first ?? FIRST_STEPS.record)
                : FIRST_STEPS[pointsAtWindow ? "window" : intent]
          }
          globals={hotkeys}
          layout={layout}
          edge={toolbarEdge}
          offset={toolbarEdge === "top" ? top : TOOLBAR_BOTTOM}
          hidden={active}
          middle={
            sizeInToolbar && heldSize ? (
              <SizeFields
                size={heldSize}
                ratio={ratio}
                folded={layout === "folded" || layout === "stacked"}
                up={toolbarEdge === "bottom"}
                onSize={applySize}
                onRatio={chooseRatio}
              />
            ) : intent === "record" ? (
              <RecordOptionsFields options={recording} up={toolbarEdge === "bottom"} iconsOnly={layout !== "wide"} />
            ) : intent === "color" ? (
              <span className="overlay-toolbar-colour" data-testid="overlay-toolbar-colour">
                <span ref={colourSwatch} className="overlay-loupe-swatch" aria-hidden="true" />
                <span ref={colourText}>—</span>
              </span>
            ) : null
          }
          onTool={chooseTool}
          onSource={chooseSource}
          onTimer={stepTimer}
          onCountdown={stepCountdown}
          onMain={confirmMain}
          onCancel={cancel}
        />
      )}
      {showSetup && source && (
        <div ref={setup} data-hidden={active ? "true" : "false"}>
          <RecordSetup
            options={recording}
            source={source}
            canRecord={held !== null && isDrag(held)}
            up={setupLow}
            transform={`translate3d(${setupCentre.x}px, ${setupCentre.y}px, 0) translate(-50%, -50%)`}
            onGrip={(event) => setGripping({ from: pointOf(event), centre: setupCentre })}
            onSource={chooseSource}
            onRecord={confirmHeld}
            onCancel={cancel}
          />
        </div>
      )}
      {showGuide && (
        <div ref={guideWrap}>
          <ScrollGuide
            stage={held ? "adjust" : "choose"}
            byHand={scrollByHand}
            onByHand={chooseWhoScrolls}
            accessibility={accessibility}
            edge={placedGuide}
            top={guideTop}
            bottom={guideBottom}
            onStart={confirmHeld}
            onDocs={openDocs}
          />
        </div>
      )}
      {showHint && (
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
                <kbd>1</kbd>–<kbd>{TIMER_KEY}</kbd> In this chooser
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
      )}
    </div>
  );
}

export default RegionOverlay;
