import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { clampTrim, formatTime, type Trim } from "./edits";
import { followScroll, msAtOffset, scrollToKeep, stepScale, visibleRange, zoomFor, type TimelineScale } from "./timelineZoom";

/** The stretch of the timeline in view, and how wide the visible track is in px. */
export interface TimelineView {
  startMs: number;
  endMs: number;
  width: number;
  /**
   * How much of the view the track fills, in px: `width`, less any of it
   * a held drag's spacer takes past the track's end.
   */
  trackWidth: number;
}

interface TimelineProps {
  durationMs: number;
  trim: Trim;
  /** Where playback is, in ms. */
  currentMs: number;
  /** Moves the playhead. */
  onSeek: (ms: number) => void;
  /** Shows a trim while a handle is still moving. */
  onTrimPreview: (trim: Trim) => void;
  /** Keeps a trim: saved to the sidecar. */
  onTrimCommit: (trim: Trim) => void;
  /** Rows under the track, lined up with it, such as the zooms. */
  children?: ReactNode;
  /** False hides the trim handles: joined clips are trimmed on their own row. */
  trimmable?: boolean;
  /** The zoom chosen, in pixels a second; null fits the track and its rows in view. */
  scale?: TimelineScale;
  /** Asks for a new zoom, from Ctrl/Cmd + wheel. */
  onScaleChange?: (scale: TimelineScale) => void;
  /** True scrolls the view on to keep the playhead in it, as while playing. */
  follow?: boolean;
  /** Tells which stretch is in view whenever it scrolls, zooms or resizes. */
  onViewChange?: (view: TimelineView) => void;
}

/** The scroller's side padding, room for the start handle and the playhead's ends. */
const SIDE_PAD = 12;

/** How much wheel movement makes one zoom step: about one notch of a mouse wheel. */
const WHEEL_STEP_PX = 100;
/** Pixels for a wheel delta given in lines or pages. */
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;

/** The visible track's width: the scroller's, less its padding. At 1x it is the whole track's. */
const viewWidth = (scroller: HTMLElement) => Math.max(0, scroller.clientWidth - SIDE_PAD * 2);

/** A time to hold in place through a zoom, `offset` px into the visible track. */
interface Anchor {
  ms: number;
  offset: number;
}

type Edge = "start" | "end";

/** How far the arrow keys move a handle; with Shift, ten times as far. */
const KEY_STEP_MS = 100;

const percent = (ms: number, durationMs: number) => `${durationMs > 0 ? (ms / durationMs) * 100 : 0}%`;

/**
 * The recording's timeline: a track to click or drag to seek, the
 * playhead, and start and end trim handles. The trimmed-away ends are
 * dimmed. Handles move with the pointer or the arrow keys, and keep their
 * trim when let go.
 */
export default function Timeline({
  durationMs,
  trim,
  currentMs,
  onSeek,
  onTrimPreview,
  onTrimCommit,
  children,
  trimmable = true,
  scale = null,
  onScaleChange,
  follow = false,
  onViewChange,
}: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The visible track's width as last measured, which bounds the zoom. */
  const [measured, setMeasured] = useState(0);
  /** The multiple of fit the chosen scale shows at, clamped to 1x and 400 px a second. */
  const zoom = zoomFor(scale, durationMs, measured);
  /** What the scroll offset was last set for, and the time to hold through the next zoom change. */
  const shown = useRef({ scale, zoom, durationMs, width: 0, anchor: null as Anchor | null });
  /** The view last told to the parent, so an unchanged one isn't told again. */
  const told = useRef<TimelineView | null>(null);
  /** The pointer held down on the track or a row, so following the playhead can't move the view under it. */
  const pressed = useRef<{ id: number; release: () => void } | null>(null);
  /**
   * The zoom shown when a pointer was pressed. Until it is let go the
   * scroller stays at least that wide, so a drag that shortens the timeline
   * can't make the browser pull the scroll offset back from under the pointer.
   */
  const [held, setHeld] = useState<{ scale: TimelineScale; zoom: number } | null>(null);
  const latest = useRef({ scale, zoom, durationMs, onScaleChange, onViewChange });
  useLayoutEffect(() => {
    latest.current = { scale, zoom, durationMs, onScaleChange, onViewChange };
  });

  /** Holds following off until the pointer is let go anywhere, its capture is lost, or the window loses focus. */
  const press = (event: PointerEvent<HTMLElement>) => {
    pressed.current?.release();
    const id = event.nativeEvent.pointerId;
    const up = (each: Event) => {
      if (each.type === "blur" || (each as globalThis.PointerEvent).pointerId === id) release();
    };
    const release = () => {
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) window.removeEventListener(type, up, true);
      window.removeEventListener("blur", up);
      if (pressed.current?.id !== id) return;
      pressed.current = null;
      setHeld(null);
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) window.addEventListener(type, up, true);
    window.addEventListener("blur", up);
    pressed.current = { id, release };
    setHeld({ scale: latest.current.scale, zoom: latest.current.zoom });
  };
  useEffect(() => () => pressed.current?.release(), []);

  /** Tells the parent what is in view. */
  const report = useCallback(() => {
    const scroller = scrollRef.current;
    const { onViewChange: tell, zoom: now, durationMs: length } = latest.current;
    if (!scroller || !tell) return;
    const width = viewWidth(scroller);
    const trackWidth = Math.max(0, Math.min(width, now * width - scroller.scrollLeft));
    const view = { ...visibleRange(scroller.scrollLeft, now, length, width), width, trackWidth };
    const last = told.current;
    if (last && last.startMs === view.startMs && last.endMs === view.endMs && last.width === view.width && last.trackWidth === view.trackWidth) return;
    told.current = view;
    tell(view);
  }, []);

  /** Measures the view again, after a scroll or a resize, and reports it. */
  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    setMeasured(viewWidth(scroller));
    report();
  }, [report]);

  // A zoom the user chose keeps the anchored time in place: the pointer's for
  // the wheel, otherwise the playhead when it is in view, or the middle of the
  // view, all measured as it was laid out before. A new length or width keeps
  // the scale and the scroll offset, so what is under the pointer stays there,
  // as while a clip edge is dragged.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const before = shown.current;
    const width = viewWidth(scroller);
    if (before.scale === scale) {
      shown.current = { ...before, zoom, durationMs, width };
      return;
    }
    let anchor = before.anchor;
    if (!anchor) {
      const playheadX = before.durationMs > 0 ? (currentMs / before.durationMs) * before.width * before.zoom - scroller.scrollLeft : -1;
      anchor =
        playheadX >= 0 && playheadX <= before.width
          ? { ms: currentMs, offset: playheadX }
          : { ms: msAtOffset(before.width / 2, scroller.scrollLeft, before.zoom, before.durationMs, before.width), offset: before.width / 2 };
    }
    shown.current = { scale, zoom, durationMs, width, anchor: null };
    scroller.scrollLeft = scrollToKeep(anchor.ms, anchor.offset, zoom, durationMs, width);
    report();
  });

  // While playing, the view moves on with the playhead, over clips and gaps alike.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!follow || !scroller || zoom <= 1 || pressed.current) return;
    const next = followScroll(currentMs, scroller.scrollLeft, zoom, durationMs, viewWidth(scroller));
    if (next !== scroller.scrollLeft) scroller.scrollLeft = next;
  }, [follow, currentMs, zoom, durationMs]);

  // Letting go of a held drag drops its spacer, which can clamp the scroll offset without a scroll event.
  useEffect(() => report(), [report, zoom, durationMs, held]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    // Ctrl/Cmd + wheel zooms at the pointer; it must be able to stop the page zooming.
    // A trackpad sends many small deltas per gesture: they add up to one step per notch's worth.
    let pending = 0;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? scroller.clientWidth || WHEEL_PAGE_PX : 1);
      // Turning back starts afresh.
      pending = Math.sign(pending) === -Math.sign(delta) ? delta : pending + delta;
      if (Math.abs(pending) < WHEEL_STEP_PX) return;
      const direction = pending < 0 ? 1 : -1;
      pending = Math.sign(pending) * Math.min(Math.abs(pending) - WHEEL_STEP_PX, WHEEL_STEP_PX);
      const { scale: chosen, zoom: now, durationMs: length, onScaleChange: ask } = latest.current;
      const width = viewWidth(scroller);
      const next = stepScale(chosen, direction, length, width);
      if (!ask || next === chosen || zoomFor(next, length, width) === now) return;
      const offset = Math.min(width, Math.max(0, event.clientX - scroller.getBoundingClientRect().left - SIDE_PAD));
      shown.current.anchor = { ms: msAtOffset(offset, scroller.scrollLeft, now, length, width), offset };
      ask(next);
    };
    scroller.addEventListener("wheel", wheel, { passive: false });
    // Observing reports the first size too.
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resized?.observe(scroller);
    return () => {
      scroller.removeEventListener("wheel", wheel);
      resized?.disconnect();
    };
  }, [measure]);

  const [dragging, setDragging] = useState<Edge | "seek" | null>(null);
  /** The trim as last previewed, committed when the handle is let go. */
  const moved = useRef<Trim | null>(null);

  const msAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const share = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(share * durationMs);
  };

  const moveEdge = (edge: Edge, ms: number): Trim =>
    clampTrim(edge === "start" ? { startMs: Math.min(ms, trim.endMs), endMs: trim.endMs } : { startMs: trim.startMs, endMs: Math.max(ms, trim.startMs) }, durationMs);

  const preview = (next: Trim) => {
    moved.current = next;
    onTrimPreview(next);
  };

  const settle = () => {
    if (moved.current) onTrimCommit(moved.current);
    moved.current = null;
  };

  const startDrag = (event: PointerEvent<HTMLElement>, kind: Edge | "seek") => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(kind);
    if (kind === "seek") onSeek(Math.min(trim.endMs, Math.max(trim.startMs, msAt(event.clientX))));
  };

  const drag = (event: PointerEvent<HTMLElement>) => {
    if (!dragging) return;
    const ms = msAt(event.clientX);
    if (dragging === "seek") onSeek(Math.min(trim.endMs, Math.max(trim.startMs, ms)));
    else preview(moveEdge(dragging, ms));
  };

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (dragging && dragging !== "seek") settle();
    setDragging(null);
  };

  const keys = (edge: Edge) => (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEY_STEP_MS * 10 : KEY_STEP_MS;
    const at = edge === "start" ? trim.startMs : trim.endMs;
    let ms: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        ms = at - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        ms = at + step;
        break;
      case "Home":
        ms = 0;
        break;
      case "End":
        ms = durationMs;
        break;
      default:
        return;
    }
    event.preventDefault();
    preview(moveEdge(edge, ms));
  };

  const handle = (edge: Edge) => {
    const at = edge === "start" ? trim.startMs : trim.endMs;
    const label = edge === "start" ? "Trim start" : "Trim end";
    return (
      <div
        className={`timeline-handle ${edge}`}
        hidden={!trimmable}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs)}
        aria-valuenow={at}
        aria-valuetext={formatTime(at)}
        title={`${label}: ${formatTime(at)}`}
        style={{ left: percent(at, durationMs) }}
        onPointerDown={(event) => startDrag(event, edge)}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={keys(edge)}
        onKeyUp={settle}
        onBlur={settle}
      />
    );
  };

  const contentStyle = {
    width: `calc(${zoom} * (100% - ${SIDE_PAD * 2}px) + ${SIDE_PAD * 2}px)`,
    // How wide the visible track is, for what must stay in view as it scrolls.
    "--timeline-view": measured > 0 ? `${measured}px` : undefined,
  } as CSSProperties;
  // The rows keep the live length's scale; only the scrolled width is held. A zoom chosen during the press drops it.
  const holdWidth = held && held.scale === scale && held.zoom > zoom && measured > 0 ? held.zoom * measured + SIDE_PAD * 2 : 0;

  return (
    <div className="timeline">
      <div
        ref={scrollRef}
        className="timeline-scroll"
        data-testid="timeline-scroll"
        onScroll={measure}
        onPointerDownCapture={press}
      >
        <div className="timeline-content" data-testid="timeline-content" data-zoom={zoom} style={contentStyle}>
          <div
            ref={trackRef}
            className="timeline-track"
            data-testid="timeline-track"
            onPointerDown={(event) => startDrag(event, "seek")}
            onPointerMove={drag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="timeline-cut" style={{ left: 0, width: percent(trim.startMs, durationMs) }} />
            <div className="timeline-cut" style={{ left: percent(trim.endMs, durationMs), right: 0 }} />
            <div className="timeline-kept" style={{ left: percent(trim.startMs, durationMs), width: percent(trim.endMs - trim.startMs, durationMs) }} />
            <div className="timeline-playhead" data-testid="playhead" style={{ left: percent(currentMs, durationMs) }} />
            {handle("start")}
            {handle("end")}
          </div>
          {children}
          {holdWidth > 0 && <div className="timeline-hold" data-testid="timeline-hold" aria-hidden="true" style={{ width: holdWidth }} />}
        </div>
      </div>
    </div>
  );
}
