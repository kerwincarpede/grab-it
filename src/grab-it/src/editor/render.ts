import { BACKDROP_FILLS, type Annotations, type Rect } from "./model";
import { displaySize, isIdentity, orientationOf, orientRect, type Orientation } from "./orient";
import { fallbackScale } from "./flatten";

/** How a capture is drawn with its saved edits, worked out before anything is drawn. */
export interface RenderPlan {
  /** The capture turned and mirrored as it shows: the hidden stage's size. */
  stage: { width: number; height: number };
  orientation: Orientation;
  /** Whether the capture is turned or mirrored at all. */
  oriented: boolean;
  /** Image pixels per point, for the backdrop's corner radius. */
  captureScale: number;
  /** The part of the capture that is exported, in capture pixels. */
  crop: Rect;
  /** The exported part as it shows, for the blurred fill. */
  shownCrop: Rect;
  /** Whether the backdrop is balanced, so the capture's plain border is measured. */
  measureBorders: boolean;
  /** Whether the backdrop is filled with a blurred copy of the capture. */
  blurredFill: boolean;
  /** The image the backdrop is filled with, when it is. */
  backdropImage: string | null;
}

/**
 * What drawing a capture of `size` with `doc` needs, as the editor's Copy
 * and Export draw it. `scaleFactor` is the capture's own; older captures do
 * not say, so this window's density stands in, as it does in the editor.
 */
export function renderPlan(doc: Annotations, size: { width: number; height: number }, scaleFactor?: number | null): RenderPlan {
  const orientation = orientationOf(doc);
  const crop = doc.crop ?? { x: 0, y: 0, ...size };
  const backdrop = doc.backdrop ?? null;
  return {
    stage: displaySize(size, orientation),
    orientation,
    oriented: !isIdentity(orientation),
    captureScale: scaleFactor && Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : fallbackScale(),
    crop,
    shownCrop: orientRect(crop, size, orientation),
    measureBorders: backdrop?.balance === true,
    blurredFill: backdrop?.fill === BACKDROP_FILLS.blur,
    backdropImage: backdrop?.fill === BACKDROP_FILLS.image ? (backdrop.image ?? null) : null,
  };
}
