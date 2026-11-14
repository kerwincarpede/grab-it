import { useEffect, useMemo, useReducer, useRef, useState, type MouseEvent } from "react";
import {
  cancelOverlay,
  finishOverlay,
  isInstantOverlay,
  onOverlayStart,
  overlayImage,
  overlayInfo,
  overlayReady,
  type OverlayInfo,
  type OverlayIntent,
  type OverlayWindow,
  type Selection,
} from "./api";
import {
  advanceDrag,
  cutoutPath,
  hintTop,
  dragBox,
  imageSize,
  isDrag,
  labelPlacement,
  monitorToCss,
  topmostAt,
  type Box,
  type Drag,
  type Point,
  type Size,
} from "./geometry";
import Loupe from "./Loupe";
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
  record: "Drag over the area to record, or click a window. Esc cancels.",
};
const WINDOW_HINT = "Click a window to capture it. Esc cancels.";
/** The hovered window's rounded corners, in CSS px. Matches `.overlay-window`. */
const WINDOW_RADIUS = 10;

function viewport(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

function pointOf(event: MouseEvent): Point {
  return { x: event.clientX, y: event.clientY };
}

/** Turns the PNG bytes into a URL the <img> can show. */
function toImageUrl(bytes: ArrayBuffer): string | null {
  if (typeof URL.createObjectURL !== "function") return null;
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

/**
 * Shows one monitor, frozen, fullscreen. What a selection means depends on
 * the intent: "capture" drags a region or clicks a window (window mode only
 * clicks windows), "text" only drags, and "color" picks the pixel under a
 * click. While dragging, Shift keeps the selection square and Space moves it.
 * Esc or right-click cancels.
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
      } else if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        setMoving(true);
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "Shift") setSquare(false);
      else if (event.code === "Space" || event.key === " ") setMoving(false);
    }
    // A key released while another window has focus never reports its keyup.
    function onBlur() {
      setSquare(false);
      setMoving(false);
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
  const pickable = useMemo<PickableWindow[]>(() => {
    if (!info) return [];
    const monitor = { width: info.monitorWidth, height: info.monitorHeight };
    const size = { width: view.width, height: view.height };
    return info.windows.map((win) => ({ window: win, box: monitorToCss(win, monitor, size) }));
  }, [info, view.width, view.height]);

  const intent = info?.intent ?? "capture";
  // Only screenshots can be of a window; text and colour ignore window mode.
  const windowMode = intent === "capture" && info?.mode === "window";
  // A recording picks its area exactly as a screenshot does.
  const picksArea = intent === "capture" || intent === "record";
  const canDrag = intent === "text" || (picksArea && !windowMode);
  const canPickWindow = picksArea;

  // Image pixels per CSS pixel, the same ratio the backend crops with. The
  // image's width is known before the image has loaded; without either
  // there is nothing to measure, so sizes read in CSS px.
  const imageWidth = image?.naturalWidth || info?.imageWidth || 0;
  const scale = imageWidth > 0 && view.width > 0 ? imageWidth / view.width : 1;

  const selection = drag && canDrag ? dragBox(drag, square, view) : null;
  const dragging = selection !== null && isDrag(selection);
  const hovered =
    canPickWindow && !dragging && pointer ? topmostAt(pickable, pointer) : undefined;
  const highlight = dragging ? selection : (hovered?.box ?? null);

  function cancel() {
    if (done.current) return;
    done.current = true;
    void cancelOverlay();
  }

  function finish(choice: Selection) {
    if (done.current) return;
    done.current = true;
    finishOverlay(choice).catch((err: unknown) => {
      done.current = false;
      setError(String(err));
    });
  }

  function onMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    const point = pointOf(event);
    setDrag({ anchor: point, head: point });
    setPointer(point);
    setSquare(event.shiftKey);
  }

  function onMouseMove(event: MouseEvent) {
    const point = pointOf(event);
    if (drag) {
      const options = { move: moving, square: event.shiftKey, bounds: view };
      setDrag(advanceDrag(drag, pointer ?? point, point, options));
    }
    setPointer(point);
    // The event knows best: Shift may have changed while we were not focused.
    setSquare(event.shiftKey);
  }

  function onMouseUp(event: MouseEvent) {
    if (event.button !== 0 || !drag) return;
    const end = pointOf(event);
    const options = { move: moving, square: event.shiftKey, bounds: view };
    const box = dragBox(advanceDrag(drag, pointer ?? end, end, options), event.shiftKey, view);
    setDrag(null);
    if (intent === "color") {
      finish({ kind: "point", x: end.x, y: end.y, viewportWidth: view.width });
      return;
    }
    if (canDrag && isDrag(box)) {
      finish({ kind: "region", rect: box, viewportWidth: view.width });
      return;
    }
    const picked = canPickWindow ? topmostAt(pickable, end) : undefined;
    if (picked) finish({ kind: "window", id: picked.window.id });
  }

  // A drag is labelled with the size it will be captured at, in image pixels.
  const captured = dragging ? imageSize(selection, scale) : null;
  const label = captured
    ? `${captured.width} × ${captured.height}`
    : hovered?.window.title || hovered?.window.appName;
  const placement = highlight
    ? labelPlacement(highlight, dragging ? SIZE_LABEL : TITLE_LABEL, view)
    : null;

  return (
    <div
      className="overlay"
      data-testid="overlay"
      data-ready={info ? "true" : "false"}
      data-intent={intent}
      data-mode={windowMode ? "window" : "region"}
      data-dragging={dragging ? "true" : "false"}
      data-moving={dragging && moving ? "true" : "false"}
      data-shown={shown ? "true" : "false"}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
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
      {/* Around a hovered window the frozen screen is blurred; the window itself stays sharp. */}
      {imageUrl && hovered && !dragging && (
        <img
          className="overlay-image overlay-image-blur"
          data-testid="overlay-blur"
          src={imageUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{ clipPath: cutoutPath(hovered.box, view, WINDOW_RADIUS) }}
        />
      )}
      {highlight && placement ? (
        <div
          className={dragging ? "overlay-selection" : "overlay-selection overlay-window"}
          data-testid="overlay-selection"
          style={{
            left: highlight.x,
            top: highlight.y,
            width: highlight.width,
            height: highlight.height,
          }}
        >
          <span className="overlay-label" data-side={placement.side} data-align={placement.align}>
            {label}
          </span>
        </div>
      ) : (
        // Colours have to be judged as they are, so the colour picker never dims.
        intent !== "color" && <div className="overlay-dim" />
      )}
      {canDrag && pointer && !dragging && (
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
      {!windowMode && pointer && (
        <Loupe image={image} pointer={pointer} scale={scale} viewport={view} />
      )}
      <div
        className="overlay-hint"
        data-hidden={dragging && !error ? "true" : "false"}
        style={{ top: hintTop(info?.topInset, view.height) }}
      >
        <p className="overlay-hint-text" role="status" data-error={error ? "true" : "false"}>
          {error ?? (windowMode ? WINDOW_HINT : HINTS[intent])}
        </p>
        <ul className="overlay-keys" aria-label="Keyboard shortcuts">
          <li>
            <kbd>Esc</kbd> Cancel
          </li>
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
