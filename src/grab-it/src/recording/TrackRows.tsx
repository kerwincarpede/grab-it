import { useRef, useState, type PointerEvent } from "react";
import { clipLength } from "./clips";
import { formatTime } from "./edits";
import { END_MARGIN_MS, isMain, placedEnd, snapClip, snapTargets, type PlacedClip, type Timeline, type Track } from "./tracks";

interface TrackRowsProps {
  timeline: Timeline;
  /** The length the rows span, as the timeline above them does. */
  durationMs: number;
  /** Where sequence time 0 sits on the rows: the trim's start for one recording. */
  offsetMs: number;
  /**
   * Where the output ends, in sequence time: the last picture's end, which
   * `moveInTime` keeps clips starting before. For one trimmed recording it
   * is short of the timeline's own end.
   */
  endMs: number;
  /** The playhead, in sequence time. */
  currentMs: number;
  selected: ReadonlySet<string>;
  /** Selects clip `id`; `adding` (Shift) adds it to the selection. */
  onSelect: (id: string, adding: boolean) => void;
  /** Moves clip `id` and its links so it starts at sequence time `atMs`. */
  onMove: (id: string, atMs: number) => void;
  onRename: (trackId: string, name: string) => void;
}

const percent = (ms: number, durationMs: number) => `${durationMs > 0 ? (ms / durationMs) * 100 : 0}%`;

/** How wide a clip starting past the timeline's end is drawn. */
const SLIVER_PX = 6;

type Drag = { id: string; x: number; atMs: number; width: number; moved: boolean };

/**
 * A named row for each track other than Video 1, in order: its name
 * (double-click to rename) and its clips at their places. A clip
 * linked to others is marked. Click selects a clip, Shift-click adds it to
 * the selection; dragging moves it and its links in time, snapping to the
 * playhead, clip edges and 0 unless Shift is held.
 */
export default function TrackRows({ timeline, durationMs, offsetMs, endMs, currentMs, selected, onSelect, onMove, onRename }: TrackRowsProps) {
  return (
    <div className="track-rows">
      {timeline.tracks.filter((track) => !isMain(track)).map((track) => (
        <TrackRow
          key={track.id}
          track={track}
          timeline={timeline}
          durationMs={durationMs}
          offsetMs={offsetMs}
          endMs={endMs}
          currentMs={currentMs}
          selected={selected}
          onSelect={onSelect}
          onMove={onMove}
          onRename={onRename}
        />
      ))}
    </div>
  );
}

function TrackRow({ track, timeline, durationMs, offsetMs, endMs, currentMs, selected, onSelect, onMove, onRename }: TrackRowsProps & { track: Track }) {
  /** Where the output ends on the rows; nothing is drawn past it. */
  const limit = Math.min(durationMs, offsetMs + endMs);
  const rowRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draftAt, setDraftAt] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(track.name);
  /** Set by Esc, so the blur as the field goes keeps the old name. */
  const cancelled = useRef(false);

  const begin = (event: PointerEvent<HTMLElement>, clip: PlacedClip) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onSelect(clip.id, event.shiftKey);
    // Shift at the press adds to the selection; Shift during a drag turns snapping off.
    if (event.shiftKey) return;
    setDrag({ id: clip.id, x: event.clientX, atMs: clip.atMs, width: rowRef.current?.getBoundingClientRect().width ?? 0, moved: false });
  };

  const move = (event: PointerEvent<HTMLElement>) => {
    if (!drag || drag.width <= 0) return;
    const clip = track.clips.find((each) => each.id === drag.id);
    if (!clip) return;
    const pxPerMs = drag.width / Math.max(1, durationMs);
    const raw = drag.atMs + (event.clientX - drag.x) / pxPerMs;
    const at = snapClip(raw, clipLength(clip), snapTargets(timeline, currentMs, new Set([clip.id])), pxPerMs, !event.shiftKey);
    if (!drag.moved) setDrag({ ...drag, moved: true });
    // It starts before the timeline's end, where it can still be seen.
    setDraftAt(Math.round(Math.min(at, Math.max(0, limit - offsetMs - END_MARGIN_MS))));
  };

  const end = (event: PointerEvent<HTMLElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag?.moved && draftAt !== null && draftAt !== drag.atMs) onMove(drag.id, draftAt);
    setDrag(null);
    setDraftAt(null);
  };

  const label = track.kind === "audio" ? "Audio track" : "Video track";
  return (
    <div className="track-row" data-kind={track.kind}>
      <div className="track-head">
        {renaming ? (
          <input
            className="track-name-input"
            aria-label={`Rename ${track.name}`}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (!cancelled.current) onRename(track.id, name);
              cancelled.current = false;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                // Only the rename is cancelled, not the selection.
                event.stopPropagation();
                cancelled.current = true;
                setName(track.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <span
            className="track-name"
            title="Double-click to rename"
            onDoubleClick={() => {
              cancelled.current = false;
              setName(track.name);
              setRenaming(true);
            }}
          >
            {track.name}
          </span>
        )}
      </div>
      <div className="track-lane" ref={rowRef} role="listbox" aria-label={`${label} ${track.name}`} aria-orientation="horizontal" aria-multiselectable="true">
        {track.clips.map((clip) => {
          const at = drag?.id === clip.id && draftAt !== null ? draftAt : clip.atMs;
          const text = `${clip.source}, ${formatTime(clipLength(clip))} at ${formatTime(at)}${clip.link ? ", linked" : ""}`;
          return (
            <div
              key={clip.id}
              className="track-clip"
              role="option"
              tabIndex={0}
              aria-selected={selected.has(clip.id)}
              aria-label={text}
              title={`${text}. ${clip.link ? "Unlink to move it on its own" : "Drag to move; Shift turns off snapping"}; Shift-click adds to the selection`}
              data-linked={clip.link ? "true" : undefined}
              // The output ends with the last picture: sound past the timeline's end is not drawn,
              // and a clip starting there is a sliver at the right edge, to select and move back.
              data-past-end={offsetMs + at >= limit ? "true" : undefined}
              style={
                offsetMs + at >= limit
                  ? { left: `calc(${percent(limit, durationMs)} - ${SLIVER_PX}px)`, width: `${SLIVER_PX}px` }
                  : { left: percent(offsetMs + at, durationMs), width: percent(Math.min(placedEnd(clip) - clip.atMs, limit - offsetMs - at), durationMs) }
              }
              onPointerDown={(event) => begin(event, clip)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
            >
              <span className="clip-name">{clip.source}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
