import type { CapturedPointer } from "./api";
import { pointerThroughCuts } from "./cut";
import type { Annotations, PointerEdit, PointerLook } from "./model";

/** Names the pointer's Konva node; also its selection id, which no shape id can take. */
export const POINTER_ID = "captured-pointer";

/** The smallest and largest pointer sizes, against the captured one. */
export const MIN_POINTER_SCALE = 0.25;
export const MAX_POINTER_SCALE = 8;

export const clampPointerScale = (scale: number) => Math.min(MAX_POINTER_SCALE, Math.max(MIN_POINTER_SCALE, scale));

/** The pointer looks Grab-it draws itself, in the order the picker lists them. */
export const POINTER_LOOKS: readonly PointerLook[] = ["arrow", "hand", "text"];

export const isPointerLook = (value: unknown): value is PointerLook => POINTER_LOOKS.includes(value as PointerLook);

/** A pointer image's size and the hot spot within it, in capture pixels at scale 1. */
export interface PointerSprite {
  width: number;
  height: number;
  hotX: number;
  hotY: number;
}

/** The text pointer's I-beam, on its 10 × 20 grid. */
const I_BEAM = "M2 2h1.5c.8 0 1.5.6 1.5 1.4C5 2.6 5.7 2 6.5 2H8M5 3.4v13.2M2 18h1.5c.8 0 1.5-.6 1.5-1.4 0 .8.7 1.4 1.5 1.4H8M3.2 10h3.6";

/**
 * The built-in pointers, in points: drawn on a `width` × `height` grid with
 * the hot spot at `hotX`, `hotY`. Black on white, like the systems' own, so
 * each shows on light and dark captures alike.
 */
const BUILT_IN: Record<PointerLook, PointerSprite & { body: string }> = {
  arrow: {
    width: 16,
    height: 24,
    hotX: 2,
    hotY: 2,
    body: '<path d="M2 2v17.5l4.4-4.2 3 6.7 3-1.3-3-6.6h5.6z" fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>',
  },
  hand: {
    width: 20,
    height: 24,
    hotX: 8,
    hotY: 1.5,
    body:
      '<path d="M8 1.5c1 0 1.5.7 1.5 1.5v6.5c.3-.5 2.3-.5 2.5.3.4-.6 2.2-.6 2.5.5.4-.5 2-.4 2 .9V16c0 3-1.7 5.5-4.5 5.5h-2c-2 0-3-1-4.2-2.5L3 15.2c-.6-.9.4-2.2 1.5-1.6l2 1.4V3c0-.8.5-1.5 1.5-1.5z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<path d="M9.5 9.5V13M12 9.8V13M14.5 10.3V13" fill="none" stroke="#000" stroke-width="1" stroke-linecap="round"/>',
  },
  text: {
    width: 10,
    height: 20,
    hotX: 5,
    hotY: 10,
    // The I-beam twice: a wide white outline, then the black beam over it.
    body: [3, 1.2]
      .map(
        (width, index) =>
          `<path d="${I_BEAM}" fill="none" stroke="${index === 0 ? "#fff" : "#000"}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
      .join(""),
  },
};

/** A built-in pointer's size and hot spot in capture pixels, for a capture of `density` pixels per point. */
export function builtInSprite(look: PointerLook, density: number): PointerSprite {
  const { width, height, hotX, hotY } = BUILT_IN[look];
  return { width: width * density, height: height * density, hotX: hotX * density, hotY: hotY * density };
}

/** A built-in pointer as an SVG data URL, drawn at `density` pixels per point so it stays sharp. */
export function builtInImage(look: PointerLook, density: number): string {
  const { width, height, body } = BUILT_IN[look];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * density}" height="${height * density}" ` +
    `viewBox="0 0 ${width} ${height}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The image the pointer shows as: the captured one, or a built-in look. */
export function pointerImageSource(captured: CapturedPointer, state: PointerEdit, density: number): string {
  return state.look ? builtInImage(state.look, density) : `data:image/png;base64,${captured.image}`;
}

/** The size and hot spot of the image the pointer shows as. */
export function pointerSprite(captured: CapturedPointer, state: PointerEdit, density: number): PointerSprite {
  return state.look ? builtInSprite(state.look, density) : captured;
}

/**
 * The pointer as the editor shows it: the user's edits when the sidecar has
 * them, else where it was captured (moved through the cuts) at its own
 * size, shown when `showByDefault` (the "Show the pointer in new captures"
 * setting) is on and no strip took it. Like shapes, it is in the pixels of
 * the joined image.
 * `null` when the capture has no pointer.
 */
export function pointerState(doc: Annotations, captured: CapturedPointer | null | undefined, showByDefault: boolean): PointerEdit | null {
  if (!captured) return null;
  return doc.pointer ?? pointerThroughCuts({ shown: showByDefault, x: captured.x, y: captured.y, scale: 1 }, doc.cuts);
}

/** The box the pointer image (`sprite`) covers, in capture pixels, for a pointer at `state`. */
export function pointerBox(sprite: PointerSprite, state: PointerEdit) {
  return {
    x: state.x - sprite.hotX * state.scale,
    y: state.y - sprite.hotY * state.scale,
    width: sprite.width * state.scale,
    height: sprite.height * state.scale,
  };
}

/** `doc` with the pointer set to `next`; the same document when nothing changed, so no undo step is made. */
export function withPointer(doc: Annotations, current: PointerEdit, next: PointerEdit): Annotations {
  const same =
    current.shown === next.shown && current.x === next.x && current.y === next.y && current.scale === next.scale && current.look === next.look;
  if (same) return doc;
  return { ...doc, pointer: next };
}

/** Shows or hides the pointer. */
export function showPointer(doc: Annotations, current: PointerEdit, shown: boolean): Annotations {
  return withPointer(doc, current, { ...current, shown });
}

/**
 * The pointer drawn as `look` (`null` for the captured image), shown. The
 * hot spot stays where it is, so the new look points at the same place.
 */
export function changePointerLook(doc: Annotations, current: PointerEdit, look: PointerLook | null): Annotations {
  const next: PointerEdit = { shown: true, x: current.x, y: current.y, scale: current.scale };
  if (look) next.look = look;
  return withPointer(doc, current, next);
}

/**
 * The pointer after its node was dragged or resized: `sprite` is the image
 * it shows as, `node` the box it now covers and `scaleX`, `scaleY` the scale a Transformer gave it. The
 * size keeps its proportions, following whichever axis changed more.
 */
export function transformPointer(
  sprite: PointerSprite,
  current: PointerEdit,
  node: { x: number; y: number; scaleX: number; scaleY: number },
): PointerEdit {
  const x = Math.abs(node.scaleX) || 1;
  const y = Math.abs(node.scaleY) || 1;
  const factor = Math.abs(Math.log(x)) >= Math.abs(Math.log(y)) ? x : y;
  const scale = clampPointerScale(current.scale * factor);
  return {
    ...current,
    x: Math.round(node.x + sprite.hotX * scale),
    y: Math.round(node.y + sprite.hotY * scale),
    scale,
  };
}

/** The pointer moved by `dx`, `dy` capture pixels. */
export function movePointer(current: PointerEdit, dx: number, dy: number): PointerEdit {
  return { ...current, x: current.x + dx, y: current.y + dy };
}
