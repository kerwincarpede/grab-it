import { useRef, useState, type PointerEvent } from "react";
import { clipLength, clipStarts, isGap, toSource, trimClip, type Clip } from "./clips";
import { formatTime } from "./edits";

interface ClipTrackProps {
  clips: Clip[];
  /** The whole sequence's length, which the row spans. */
  durationMs: number;
  /** How long each clip's recording is, for trimming within it. 0 while unknown. */
  sourceDuration: (source: string) => number;
  /** Sources whose file is gone or cannot be played. */
  missing: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Shows trimmed clips while an edge is still moving. */
  onTrimPreview: (clips: Clip[]) => void;
  /** Keeps a trim: one undo entry. */
  onTrimCommit: (clips: Clip[]) => void;
  /** Moves clip `id` to index `to`. */
  onMove: (id: string, to: number) => void;
}

/** An edge drag keeps the row's width and the sequence's length from when it began. */
type Drag = { kind: "start" | "end"; id: string; x: number; ms: number; width: number; durationMs: number } | { kind: "move"; id: string; moved: boolean };

/** The edges a clip is trimmed by; a gap has none. */
const EDGES = ["start", "end"] as const;
const NO_EDGES: readonly (typeof EDGES)[number][] = [];

const percent = (ms: number, durationMs: number) => `${durationMs > 0 ? (ms / durationMs) * 100 : 0}%`;

/**
 * The joined sequence: each clip end to end at its kept length, named by
 * its recording. Click to select, drag its body to reorder, or drag an
 * edge to trim or restore it within its recording. A gap shows as an
 * empty block that can be selected and deleted, but not trimmed.
 */
export default function ClipTrack({ clips, durationMs, sourceDuration, missing, selectedId, onSelect, onTrimPreview, onTrimCommit, onMove }: ClipTrackProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const moved = useRef<Clip[] | null>(null);
  const starts = clipStarts(clips);

  const msAt = (clientX: number) => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * durationMs;
  };

  const begin = (event: PointerEvent<HTMLElement>, next: Drag) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onSelect(next.id);
    setDrag(next);
  };

  const beginEdge = (event: PointerEvent<HTMLElement>, clip: Clip, kind: "start" | "end") => {
    const width = rowRef.current?.getBoundingClientRect().width ?? 0;
    begin(event, { kind, id: clip.id, x: event.clientX, ms: kind === "start" ? clip.startMs : clip.endMs, width, durationMs });
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    if (!drag) return;
    if (drag.kind === "move") {
      if (!drag.moved) setDrag({ ...drag, moved: true });
      return;
    }
    if (drag.width <= 0) return;
    const clip = clips.find((each) => each.id === drag.id);
    if (!clip) return;
    // The edge keeps the sequence's scale from when the drag began: the
    // live length changes with the very trim being dragged.
    const ms = drag.ms + ((event.clientX - drag.x) / drag.width) * drag.durationMs;
    const next = trimClip(clips, drag.id, drag.kind, ms, sourceDuration(clip.source) || clip.endMs);
    moved.current = next;
    onTrimPreview(next);
  };

  const end = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag?.kind === "move" && drag.moved) {
      const target = toSource(clips, msAt(event.clientX));
      if (target) onMove(drag.id, target.index);
    } else if (drag && drag.kind !== "move" && moved.current) {
      onTrimCommit(moved.current);
    }
    moved.current = null;
    setDrag(null);
  };

  return (
    <div className="clip-track" ref={rowRef} role="listbox" aria-label="Clips" aria-orientation="horizontal">
      {clips.map((clip, index) => {
        const gap = isGap(clip);
        const edges = gap ? NO_EDGES : EDGES;
        const gone = !gap && missing.has(clip.source);
        const label = gap ? `Gap, ${formatTime(clipLength(clip))}` : `${clip.source}${gone ? " (missing)" : ""}, ${formatTime(clipLength(clip))}`;
        return (
          <div
            key={clip.id}
            className="clip"
            role="option"
            tabIndex={0}
            aria-selected={clip.id === selectedId}
            aria-label={label}
            title={gap ? `${label}. Delete closes it` : `${label}. Drag to reorder; Alt+Left or Right moves it, Delete removes it, Shift+Delete leaves a gap`}
            data-missing={gone ? "true" : undefined}
            data-gap={gap ? "true" : undefined}
            style={{ left: percent(starts[index], durationMs), width: percent(clipLength(clip), durationMs) }}
            onPointerDown={(event) => begin(event, { kind: "move", id: clip.id, moved: false })}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onFocus={() => onSelect(clip.id)}
          >
            <span className="clip-name">{gap ? "Gap" : gone ? `Missing: ${clip.source}` : clip.source}</span>
            {edges.map((edge) => (
              <div
                key={edge}
                className={`clip-edge ${edge}`}
                aria-hidden="true"
                onPointerDown={(event) => beginEdge(event, clip, edge)}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
