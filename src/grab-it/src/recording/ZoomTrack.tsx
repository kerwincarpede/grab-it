import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { formatTime } from "./edits";
import { MIN_ZOOM_MS, moveZoom, removeZoom, resizeZoom, zoomLabel, type Zoom } from "./zooms";

interface ZoomTrackProps {
  durationMs: number;
  zooms: Zoom[];
  selectedId: string | null;
  /** Limits an edit to the piece of picture the zoom belongs to. */
  room?: (id: string) => { low: number; high: number };
  onSelect: (id: string | null) => void;
  /** Shows zooms while a segment is still moving. */
  onPreview: (zooms: Zoom[]) => void;
  /** Keeps zooms: saved to the sidecar. */
  onCommit: (zooms: Zoom[]) => void;
  /** Adds a zoom at `ms`, for a double-click on an empty stretch. */
  onAdd: (ms: number) => void;
  /** Shows the frame at `ms` while an edge moves. */
  onSeek: (ms: number) => void;
}

type DragKind = "move" | "start" | "end";

interface Drag {
  id: string;
  kind: DragKind;
  /** Where the pointer went down, in ms. */
  fromMs: number;
  /** The zooms when it went down, which each move starts from. */
  base: Zoom[];
  moved: Zoom[] | null;
}

/** How far the arrow keys move a segment; with Shift, ten times as far. */
const KEY_STEP_MS = 100;

const percent = (ms: number, durationMs: number) => `${durationMs > 0 ? (ms / durationMs) * 100 : 0}%`;

/**
 * The zoom row under the timeline: a segment for each zoom, which a drag
 * moves and a drag on either edge resizes, clear of its neighbours. A
 * click selects one, Delete removes it, the arrow keys move it, and a
 * double-click on an empty stretch adds one.
 */
export default function ZoomTrack({ durationMs, zooms, selectedId, room, onSelect, onPreview, onCommit, onAdd, onSeek }: ZoomTrackProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);

  const msAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const share = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(share * durationMs);
  };

  const startDrag = (event: PointerEvent<HTMLElement>, zoom: Zoom, kind: DragKind) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    // Focused, so Delete and the arrow keys reach it.
    event.currentTarget.closest<HTMLElement>(".zoom-segment")?.focus();
    onSelect(zoom.id);
    drag.current = { id: zoom.id, kind, fromMs: msAt(event.clientX), base: zooms, moved: null };
    setDragging(true);
  };

  const editSpan = (base: Zoom[], zoom: Zoom, kind: DragKind, ms: number) => {
    const bounds = room?.(zoom.id);
    if (!bounds) return kind === "move" ? moveZoom(base, zoom.id, ms, durationMs) : resizeZoom(base, zoom.id, kind, ms, durationMs);
    if (bounds.high - bounds.low < MIN_ZOOM_MS) return base;
    if (kind === "move") {
      const start = Math.max(bounds.low, Math.min(ms, bounds.high - (zoom.endMs - zoom.startMs)));
      return moveZoom(base, zoom.id, start, bounds.high);
    }
    return resizeZoom(base, zoom.id, kind, Math.max(bounds.low, Math.min(ms, bounds.high)), bounds.high);
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    const ms = msAt(event.clientX);
    const zoom = current.base.find((each) => each.id === current.id);
    if (!zoom) return;
    const next = editSpan(current.base, zoom, current.kind, current.kind === "move" ? zoom.startMs + ms - current.fromMs : ms);
    current.moved = next;
    onPreview(next);
    const changed = next.find((each) => each.id === current.id);
    if (changed) onSeek(current.kind === "end" ? changed.endMs : changed.startMs);
  };

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    if (current?.moved) onCommit(current.moved);
  };

  const keys = (zoom: Zoom) => (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEY_STEP_MS * 10 : KEY_STEP_MS;
    switch (event.key) {
      case "Delete":
      case "Backspace":
        event.preventDefault();
        onSelect(null);
        onCommit(removeZoom(zooms, zoom.id));
        return;
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        const next = editSpan(zooms, zoom, "move", zoom.startMs + (event.key === "ArrowLeft" ? -step : step));
        onCommit(next);
        return;
      }
      case "Escape":
        onSelect(null);
        return;
    }
  };

  const addAt = (event: MouseEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    onAdd(msAt(event.clientX));
  };

  return (
    <div
      ref={trackRef}
      className="zoom-track"
      data-testid="zoom-track"
      data-dragging={dragging ? "true" : undefined}
      title="Double-click to add a zoom"
      onDoubleClick={addAt}
      onPointerDown={(event) => event.target === event.currentTarget && onSelect(null)}
      onPointerMove={move}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {zooms.length === 0 && <span className="zoom-track-hint">Double-click to add a zoom</span>}
      {zooms.map((zoom) => {
        const selected = zoom.id === selectedId;
        const label = `${zoomLabel(zoom)}, ${formatTime(zoom.startMs)} to ${formatTime(zoom.endMs)}`;
        return (
          <div
            key={zoom.id}
            className={`zoom-segment ${zoom.focus.kind}`}
            data-testid="zoom-segment"
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={selected}
            title={label}
            style={{ left: percent(zoom.startMs, durationMs), width: percent(zoom.endMs - zoom.startMs, durationMs) }}
            onPointerDown={(event) => startDrag(event, zoom, "move")}
            onFocus={() => onSelect(zoom.id)}
            onKeyDown={keys(zoom)}
          >
            <div className="zoom-edge start" data-testid="zoom-edge-start" onPointerDown={(event) => startDrag(event, zoom, "start")} />
            <span className="zoom-segment-label">
              {zoom.scale}× {zoom.focus.kind === "cursor" ? "Cursor" : "Area"}
            </span>
            <div className="zoom-edge end" data-testid="zoom-edge-end" onPointerDown={(event) => startDrag(event, zoom, "end")} />
          </div>
        );
      })}
    </div>
  );
}
