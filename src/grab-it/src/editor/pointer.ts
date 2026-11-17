import type { CapturedPointer } from "./api";
import type { Annotations, PointerEdit } from "./model";

/** Names the pointer's Konva node; also its selection id, which no shape id can take. */
export const POINTER_ID = "captured-pointer";

/** The smallest and largest pointer sizes, against the captured one. */
export const MIN_POINTER_SCALE = 0.25;
export const MAX_POINTER_SCALE = 8;

export const clampPointerScale = (scale: number) => Math.min(MAX_POINTER_SCALE, Math.max(MIN_POINTER_SCALE, scale));

/**
 * The pointer as the editor shows it: the user's edits when the sidecar has
 * them, else where it was captured at its own size, shown when
 * `showByDefault` (the "Show the pointer in new captures" setting) is on.
 * `null` when the capture has no pointer.
 */
export function pointerState(doc: Annotations, captured: CapturedPointer | null | undefined, showByDefault: boolean): PointerEdit | null {
  if (!captured) return null;
  return doc.pointer ?? { shown: showByDefault, x: captured.x, y: captured.y, scale: 1 };
}

/** The box the pointer image covers, in capture pixels, for a pointer at `state`. */
export function pointerBox(captured: CapturedPointer, state: PointerEdit) {
  return {
    x: state.x - captured.hotX * state.scale,
    y: state.y - captured.hotY * state.scale,
    width: captured.width * state.scale,
    height: captured.height * state.scale,
  };
}

/** `doc` with the pointer set to `next`; the same document when nothing changed, so no undo step is made. */
export function withPointer(doc: Annotations, current: PointerEdit, next: PointerEdit): Annotations {
  if (current.shown === next.shown && current.x === next.x && current.y === next.y && current.scale === next.scale) return doc;
  return { ...doc, pointer: next };
}

/** Shows or hides the pointer. */
export function showPointer(doc: Annotations, current: PointerEdit, shown: boolean): Annotations {
  return withPointer(doc, current, { ...current, shown });
}

/**
 * The pointer after its node was dragged or resized: `node` is the box it
 * now covers and `scaleX`, `scaleY` the scale a Transformer gave it. The
 * size keeps its proportions, following whichever axis changed more.
 */
export function transformPointer(
  captured: CapturedPointer,
  current: PointerEdit,
  node: { x: number; y: number; scaleX: number; scaleY: number },
): PointerEdit {
  const x = Math.abs(node.scaleX) || 1;
  const y = Math.abs(node.scaleY) || 1;
  const factor = Math.abs(Math.log(x)) >= Math.abs(Math.log(y)) ? x : y;
  const scale = clampPointerScale(current.scale * factor);
  return {
    shown: current.shown,
    x: Math.round(node.x + captured.hotX * scale),
    y: Math.round(node.y + captured.hotY * scale),
    scale,
  };
}

/** The pointer moved by `dx`, `dy` capture pixels. */
export function movePointer(current: PointerEdit, dx: number, dy: number): PointerEdit {
  return { ...current, x: current.x + dx, y: current.y + dy };
}
