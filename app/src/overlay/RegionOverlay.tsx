import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  cancelOverlay,
  finishOverlay,
  overlayImage,
  overlayInfo,
  type OverlayInfo,
  type OverlayIntent,
  type OverlayWindow,
  type Selection,
} from "./api";
import {
  advanceDrag,
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
  const done = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    overlayInfo()
      .then((loaded) => {
        if (!cancelled) setInfo(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    overlayImage()
      .then((bytes) => {
        if (cancelled) return;
        url = toImageUrl(bytes);
        setImageUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

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

  const pickable = useMemo<PickableWindow[]>(() => {
    if (!info) return [];
    const monitor = { width: info.monitorWidth, height: info.monitorHeight };
    return info.windows.map((win) => ({ window: win, box: monitorToCss(win, monitor, viewport()) }));
  }, [info]);

  const intent = info?.intent ?? "capture";
  // Only screenshots can be of a window; text and colour ignore window mode.
  const windowMode = intent === "capture" && info?.mode === "window";
  // A recording picks its area exactly as a screenshot does.
  const picksArea = intent === "capture" || intent === "record";
  const canDrag = intent === "text" || (picksArea && !windowMode);
  const canPickWindow = picksArea;

  const view = viewport();
  // Image pixels per CSS pixel, the same ratio the backend crops with. Until
  // the image has loaded there is nothing to measure, so sizes read in CSS px.
  const scale = image && image.naturalWidth > 0 ? image.naturalWidth / view.width : 1;

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
      data-moving={dragging && moving ? "true" : "false"}
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
          onLoad={(event) => setImage(event.currentTarget)}
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
      <div className="overlay-hint" data-hidden={dragging && !error ? "true" : "false"}>
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
