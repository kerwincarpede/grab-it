import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { cueLabel, MIN_CUE_MS, type CueShowing } from "./captions";
import { formatTime } from "./edits";

/** A showing's new place on the sequence while it is dragged. */
export interface CueSpan {
  key: string;
  startMs: number;
  endMs: number;
}

interface CaptionTrackProps {
  durationMs: number;
  /** Every showing of every cue, in sequence time. */
  showings: CueShowing[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Where showing `key` may reach on the sequence: its clip. */
  room: (key: string) => { low: number; high: number };
  /** Shows a showing at a new place while it is still moving. */
  onPreview: (span: CueSpan | null) => void;
  /** Keeps a showing's new place: saved to the sidecar. */
  onCommit: (span: CueSpan) => void;
  onDelete: (key: string) => void;
  /** Adds a cue at `ms`, for a double-click on an empty stretch. */
  onAdd: (ms: number) => void;
  /** Shows the frame at `ms` while an edge moves. */
  onSeek: (ms: number) => void;
}

type DragKind = "move" | "start" | "end";

interface Drag {
  key: string;
  kind: DragKind;
  fromMs: number;
  base: CueShowing;
  moved: CueSpan | null;
}

const KEY_STEP_MS = 100;

const percent = (ms: number, durationMs: number) => `${durationMs > 0 ? (ms / durationMs) * 100 : 0}%`;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The caption row under the zoom row: a cue for each showing, which a drag
 * moves and a drag on either edge resizes inside its clip. A click selects
 * one, whose text the top bar edits; Delete removes it, the arrow keys move
 * it, and a double-click on an empty stretch of a clip adds one.
 */
export default function CaptionTrack({ durationMs, showings, selectedKey, onSelect, room, onPreview, onCommit, onDelete, onAdd, onSeek }: CaptionTrackProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);

  const msAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.round(clamp((clientX - rect.left) / rect.width, 0, 1) * durationMs);
  };

  const placed = (showing: CueShowing, kind: DragKind, deltaMs: number, atMs: number): CueSpan => {
    const { low, high } = room(showing.key);
    const length = showing.endMs - showing.startMs;
    if (kind === "move") {
      const startMs = Math.round(clamp(showing.startMs + deltaMs, low, Math.max(low, high - length)));
      return { key: showing.key, startMs, endMs: startMs + length };
    }
    if (kind === "start") return { key: showing.key, startMs: Math.round(clamp(atMs, low, showing.endMs - MIN_CUE_MS)), endMs: showing.endMs };
    return { key: showing.key, startMs: showing.startMs, endMs: Math.round(clamp(atMs, showing.startMs + MIN_CUE_MS, high)) };
  };

  const startDrag = (event: PointerEvent<HTMLElement>, showing: CueShowing, kind: DragKind) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.closest<HTMLElement>(".caption-cue")?.focus();
    onSelect(showing.key);
    drag.current = { key: showing.key, kind, fromMs: msAt(event.clientX), base: showing, moved: null };
    setDragging(true);
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    const ms = msAt(event.clientX);
    const next = placed(current.base, current.kind, ms - current.fromMs, ms);
    current.moved = next;
    onPreview(next);
    onSeek(current.kind === "end" ? next.endMs : next.startMs);
  };

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    onPreview(null);
    if (current?.moved) onCommit(current.moved);
  };

  const keys = (showing: CueShowing) => (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEY_STEP_MS * 10 : KEY_STEP_MS;
    switch (event.key) {
      case "Delete":
      case "Backspace":
        event.preventDefault();
        onSelect(null);
        onDelete(showing.key);
        return;
      case "ArrowLeft":
      case "ArrowRight":
        event.preventDefault();
        onCommit(placed(showing, "move", event.key === "ArrowLeft" ? -step : step, 0));
        return;
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
      className="caption-track"
      data-testid="caption-track"
      data-dragging={dragging ? "true" : undefined}
      title="Double-click to add a caption"
      onDoubleClick={addAt}
      onPointerDown={(event) => event.target === event.currentTarget && onSelect(null)}
      onPointerMove={move}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {showings.length === 0 && <span className="zoom-track-hint">Double-click to add a caption</span>}
      {showings.map((showing) => {
        const selected = showing.key === selectedKey;
        const label = `Caption “${cueLabel(showing.cue)}”, ${formatTime(showing.startMs)} to ${formatTime(showing.endMs)}`;
        return (
          <div
            key={showing.key}
            className="caption-cue"
            data-testid="caption-cue"
            role="button"
            tabIndex={0}
            aria-label={label}
            aria-pressed={selected}
            title={label}
            style={{ left: percent(showing.startMs, durationMs), width: percent(showing.endMs - showing.startMs, durationMs) }}
            onPointerDown={(event) => startDrag(event, showing, "move")}
            onFocus={() => onSelect(showing.key)}
            onKeyDown={keys(showing)}
          >
            <div className="zoom-edge start" data-testid="caption-edge-start" onPointerDown={(event) => startDrag(event, showing, "start")} />
            <span className="zoom-segment-label">{cueLabel(showing.cue)}</span>
            <div className="zoom-edge end" data-testid="caption-edge-end" onPointerDown={(event) => startDrag(event, showing, "end")} />
          </div>
        );
      })}
    </div>
  );
}
