import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { clampCentre, viewRect } from "./zooms";

interface ZoomAreaPickerProps {
  /** The zoom's scale: the area is this many times smaller than the frame. */
  scale: number;
  /** The area's centre, as fractions of the frame. */
  x: number;
  y: number;
  /** Moves the area while the pointer is down. */
  onPreview: (x: number, y: number) => void;
  /** Keeps the area: saved to the sidecar. */
  onCommit: (x: number, y: number) => void;
}

/** How far the arrow keys move the area, as a share of the frame; with Shift, ten times as far. */
const KEY_STEP = 0.01;

/**
 * Laid over the unzoomed video while an area zoom is selected: the area
 * it zooms in on, with the rest dimmed. Pressing or dragging anywhere
 * centres the area there, kept inside the frame; the arrow keys nudge it.
 */
export default function ZoomAreaPicker({ scale, x, y, onPreview, onCommit }: ZoomAreaPickerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const moved = useRef<[number, number] | null>(null);

  const centreAt = (clientX: number, clientY: number): [number, number] => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return [x, y];
    return clampCentre([(clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height], scale);
  };

  const preview = (centre: [number, number]) => {
    moved.current = centre;
    onPreview(centre[0], centre[1]);
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
    preview(centreAt(event.clientX, event.clientY));
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (moved.current) preview(centreAt(event.clientX, event.clientY));
  };

  const up = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const centre = moved.current;
    moved.current = null;
    if (centre) onCommit(centre[0], centre[1]);
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP * 10 : KEY_STEP;
    const by: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const delta = by[event.key];
    if (!delta) return;
    event.preventDefault();
    const [nx, ny] = clampCentre([x + delta[0], y + delta[1]], scale);
    onCommit(nx, ny);
  };

  const [cx, cy] = clampCentre([x, y], scale);
  const area = viewRect({ scale, x: cx, y: cy });
  const pct = (share: number) => `${share * 100}%`;
  return (
    <div
      ref={boxRef}
      className="zoom-picker"
      data-testid="zoom-picker"
      role="group"
      tabIndex={0}
      aria-label="Zoom area: drag to move it, or use the arrow keys"
      title="Drag to choose the area to zoom in on"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={keys}
    >
      <div className="zoom-area" data-testid="zoom-area" style={{ left: pct(area.x), top: pct(area.y), width: pct(area.width), height: pct(area.height) }} />
    </div>
  );
}
