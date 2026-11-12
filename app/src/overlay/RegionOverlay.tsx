import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  cancelOverlay,
  finishOverlay,
  overlayImage,
  overlayInfo,
  type OverlayInfo,
  type OverlayWindow,
  type Selection,
} from "./api";
import { boxFromPoints, isDrag, monitorToCss, topmostAt, type Box, type Point } from "./geometry";

interface PickableWindow {
  window: OverlayWindow;
  box: Box;
}

function viewport() {
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
 * Shows one monitor, frozen, fullscreen. Drag to capture a region, or hover
 * and click to capture a window; Esc or right-click cancels. In window mode
 * dragging is off and only clicks on windows count.
 */
function RegionOverlay() {
  const [info, setInfo] = useState<OverlayInfo | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
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
      if (event.key !== "Escape" || done.current) return;
      event.preventDefault();
      done.current = true;
      void cancelOverlay();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const pickable = useMemo<PickableWindow[]>(() => {
    if (!info) return [];
    const monitor = { width: info.monitorWidth, height: info.monitorHeight };
    return info.windows.map((win) => ({ window: win, box: monitorToCss(win, monitor, viewport()) }));
  }, [info]);

  const windowMode = info?.mode === "window";
  const selection = dragStart && pointer && !windowMode ? boxFromPoints(dragStart, pointer) : null;
  const dragging = selection !== null && isDrag(selection);
  const hovered = !dragging && pointer ? topmostAt(pickable, pointer) : undefined;

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
    setDragStart(pointOf(event));
    setPointer(pointOf(event));
  }

  function onMouseUp(event: MouseEvent) {
    if (event.button !== 0 || !dragStart) return;
    const end = pointOf(event);
    const box = boxFromPoints(dragStart, end);
    setDragStart(null);
    if (!windowMode && isDrag(box)) {
      finish({ kind: "region", rect: box, viewportWidth: viewport().width });
      return;
    }
    const picked = topmostAt(pickable, end);
    if (picked) finish({ kind: "window", id: picked.window.id });
  }

  const highlight = dragging ? selection : (hovered?.box ?? null);
  const hint = windowMode
    ? "Click a window to capture it. Esc cancels."
    : "Drag to capture a region, or click a window. Esc cancels.";

  return (
    <div
      className="overlay"
      data-testid="overlay"
      data-ready={info ? "true" : "false"}
      onMouseDown={onMouseDown}
      onMouseMove={(event) => setPointer(pointOf(event))}
      onMouseUp={onMouseUp}
      onContextMenu={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      {imageUrl && <img className="overlay-image" src={imageUrl} alt="" draggable={false} />}
      {highlight ? (
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
          <span className="overlay-label">
            {dragging
              ? `${Math.round(highlight.width)} × ${Math.round(highlight.height)}`
              : hovered?.window.title || hovered?.window.appName}
          </span>
        </div>
      ) : (
        <div className="overlay-dim" />
      )}
      <p className="overlay-hint" role="status">
        {error ?? hint}
      </p>
    </div>
  );
}

export default RegionOverlay;
