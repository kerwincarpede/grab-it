import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./pin.css";
import { nudgeDelta } from "../editor/tools";
import {
  clampOpacity,
  MIN_OPACITY,
  OPACITY_STEP,
  pinClose,
  pinCopy,
  pinEdit,
  pinImage,
  pinInfo,
  pinLock,
  pinNudge,
  pinZoom,
  wheelFactor,
  wheelOpacity,
  ZOOM_STEP,
  type PinInfo,
} from "./api";

function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * A pinned capture: the image fills a borderless window that stays above
 * every other one. Drag it anywhere, scroll (or + and -) to resize,
 * Ctrl/⌘ + scroll (or the slider) to fade it, the arrow keys to nudge it,
 * Lock to make it click-through, Esc or double-click to close.
 */
function PinWindow() {
  const [info, setInfo] = useState<PinInfo | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [opacity, setOpacity] = useState(1);
  const closed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    pinInfo()
      .then((loaded) => {
        if (!cancelled) setInfo(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMessage(errorMessage(err));
      });
    pinImage()
      .then((bytes) => {
        if (cancelled || typeof URL.createObjectURL !== "function") return;
        url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        setImageUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMessage(errorMessage(err));
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  // A confirmation such as "Copied" fades after a moment.
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 1600);
    return () => window.clearTimeout(timer);
  }, [message]);

  function close() {
    if (closed.current) return;
    closed.current = true;
    pinClose().catch((err: unknown) => {
      closed.current = false;
      setMessage(errorMessage(err));
    });
  }

  function zoom(factor: number | null) {
    if (factor === null) return;
    pinZoom(factor).catch((err: unknown) => setMessage(errorMessage(err)));
  }

  function fade(deltaY: number) {
    setOpacity((current) => wheelOpacity(current, deltaY));
  }

  function nudge(dx: number, dy: number) {
    pinNudge(dx, dy).catch((err: unknown) => setMessage(errorMessage(err)));
  }

  function lock() {
    pinLock()
      .then(() => setMessage("Locked. Unlock it from the tray menu."))
      .catch((err: unknown) => setMessage(errorMessage(err)));
  }

  function copy() {
    pinCopy()
      .then(() => setMessage("Copied"))
      .catch((err: unknown) => setMessage(errorMessage(err)));
  }

  function edit() {
    pinEdit().catch((err: unknown) => setMessage(errorMessage(err)));
  }

  // The handlers read the latest closures through refs, so the listeners
  // are attached once.
  const actions = useRef({ close, zoom, copy, fade, nudge });
  useEffect(() => {
    actions.current = { close, zoom, copy, fade, nudge };
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === "Escape") actions.current.close();
      else if (mod && event.key.toLowerCase() === "c") actions.current.copy();
      else if (event.key === "+" || event.key === "=") actions.current.zoom(ZOOM_STEP);
      else if (event.key === "-") actions.current.zoom(1 / ZOOM_STEP);
      else {
        // The opacity slider takes its own arrow keys.
        if (event.target instanceof HTMLInputElement) return;
        const delta = mod || event.altKey ? null : nudgeDelta(event.key, event.shiftKey);
        if (!delta) return;
        actions.current.nudge(delta.x, delta.y);
      }
      event.preventDefault();
    }
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) actions.current.fade(event.deltaY);
      else actions.current.zoom(wheelFactor(event.deltaY));
    }
    window.addEventListener("keydown", onKeyDown);
    // Not passive: the wheel must not scroll or pinch-zoom the page.
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  function onMouseDown(event: MouseEvent) {
    // The second press of a double-click closes; it must not start a drag.
    if (event.button !== 0 || event.detail > 1) return;
    try {
      void getCurrentWindow()
        .startDragging()
        .catch(() => undefined);
    } catch {
      // Outside a Tauri window there is nothing to drag.
    }
  }

  return (
    <main
      className="pin"
      data-testid="pin"
      data-ready={imageUrl ? "true" : "false"}
      // Fades the image and the backdrop; the toolbar stays solid.
      style={{ "--pin-opacity": opacity } as CSSProperties}
      onMouseDown={onMouseDown}
      onDoubleClick={close}
      onContextMenu={(event) => event.preventDefault()}
    >
      {imageUrl && <img className="pin-image" src={imageUrl} alt="Pinned capture" draggable={false} />}
      <div
        className="pin-bar"
        role="toolbar"
        aria-label="Pin actions"
        // The bar's buttons must not drag or close the pin.
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <input
          type="range"
          className="pin-opacity"
          aria-label="Opacity"
          title="Opacity (Ctrl/⌘ + scroll)"
          min={MIN_OPACITY * 100}
          max={100}
          step={OPACITY_STEP * 100}
          value={Math.round(opacity * 100)}
          aria-valuetext={`${Math.round(opacity * 100)}%`}
          onChange={(event) => setOpacity(clampOpacity(Number(event.target.value) / 100))}
        />
        <button type="button" onClick={copy} title="Copy (Ctrl+C)">
          Copy
        </button>
        {info?.editable && (
          <button type="button" onClick={edit} title="Open in the editor">
            Annotate
          </button>
        )}
        <button type="button" onClick={() => zoom(1 / ZOOM_STEP)} aria-label="Smaller" title="Smaller (-)">
          −
        </button>
        <button type="button" onClick={() => zoom(ZOOM_STEP)} aria-label="Larger" title="Larger (+)">
          +
        </button>
        <button type="button" onClick={lock} title="Lock: clicks pass through until you unlock it from the tray menu">
          Lock
        </button>
        <button type="button" onClick={close} aria-label="Close" title="Close (Esc)">
          ✕
        </button>
      </div>
      {message && (
        <p className="pin-message" role="status">
          {message}
        </p>
      )}
    </main>
  );
}

export default PinWindow;
