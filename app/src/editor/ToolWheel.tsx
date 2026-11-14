import { useEffect, useRef } from "react";
import { ToolIcon } from "./icons";
import { TOOLS, type Point, type Tool } from "./model";

/** Distance from the wheel's centre to the centre of each tool button, in CSS pixels. */
export const WHEEL_RADIUS = 88;
/** How far the wheel reaches past its radius (half a button plus a margin). */
export const WHEEL_REACH = WHEEL_RADIUS + 28;

/** Where the `index`th of `count` buttons sits around the ring, from the top, clockwise. */
export function ringPosition(index: number, count: number, radius = WHEEL_RADIUS): Point {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
  return { x: Math.round(radius * Math.cos(angle)), y: Math.round(radius * Math.sin(angle)) };
}

/** Keeps a wheel opened at `at` inside a canvas of `size`, so no tool lands off screen. */
export function clampWheel(at: Point, size: { width: number; height: number }): Point {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, WHEEL_REACH), Math.max(WHEEL_REACH, max - WHEEL_REACH));
  return { x: clamp(at.x, size.width), y: clamp(at.y, size.height) };
}

interface ToolWheelProps {
  /** The wheel's centre, in pixels from the canvas's top-left corner. */
  at: Point;
  active: Tool;
  onPick: (tool: Tool) => void;
  onClose: () => void;
}

/**
 * A ring of every tool around the pointer, opened by a right-click on the
 * canvas. Clicking a tool picks it; a click anywhere else closes the wheel
 * (Escape is handled with the editor's other keys).
 */
export default function ToolWheel({ at, active, onPick, onClose }: ToolWheelProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus the current tool, so the keyboard can move around the ring.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  return (
    <div ref={ref} className="tool-wheel" role="menu" aria-label="Tools" style={{ left: at.x, top: at.y }}>
      {TOOLS.map(({ tool, label, key }, i) => {
        const position = ringPosition(i, TOOLS.length);
        return (
          <button
            key={tool}
            type="button"
            role="menuitemradio"
            className="icon-button"
            aria-label={label}
            aria-checked={tool === active}
            title={`${label} (${key.toUpperCase()})`}
            style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
            onClick={() => onPick(tool)}
          >
            <ToolIcon tool={tool} />
          </button>
        );
      })}
    </div>
  );
}
