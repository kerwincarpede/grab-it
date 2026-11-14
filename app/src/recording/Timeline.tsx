import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clampTrim, formatTime, type Trim } from "./edits";

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
export default function Timeline({ durationMs, trim, currentMs, onSeek, onTrimPreview, onTrimCommit }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
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

  return (
    <div className="timeline">
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
    </div>
  );
}
