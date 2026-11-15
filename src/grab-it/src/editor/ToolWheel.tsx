import { useEffect, useRef } from "react";
import { ToolIcon } from "./icons";
import { TOOLS, type Point, type Tool } from "./model";
import { ringPosition } from "./tools";


interface ToolWheelProps {
  /** The wheel's centre, in pixels from the canvas's top-left corner. */
  at: Point;
  active: Tool;
  onPick: (tool: Tool) => void;
  /** Called with the pointer down that landed outside the wheel. */
  onClose: (event: PointerEvent) => void;
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
      if (event.target instanceof Node && !ref.current?.contains(event.target)) onClose(event);
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
