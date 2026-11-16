import type { WebcamShape } from "../settings/api";

/**
 * Each bubble shape's outline, drawn in a 1 × 1 box that is stretched over
 * the bubble (an SVG clip path in `objectBoundingBox` units). The window
 * already has the shape's proportions (`proportions` in webcam.rs), so
 * the outlines are drawn for them: an arch's top is a half circle once
 * stretched over its 0.88 × 1.10 window.
 *
 * The blob drifts between its outlines and back, so they share one set of
 * commands for the animation to blend.
 */
export const SHAPE_OUTLINES: Record<WebcamShape, readonly string[]> = {
  squircle: ["M0.3 0H0.7C0.92 0 1 0.08 1 0.3V0.7C1 0.92 0.92 1 0.7 1H0.3C0.08 1 0 0.92 0 0.7V0.3C0 0.08 0.08 0 0.3 0Z"],
  round: ["M0.5 0A0.5 0.5 0 1 1 0.5 1A0.5 0.5 0 1 1 0.5 0Z"],
  arch: ["M0 0.4A0.5 0.4 0 0 1 1 0.4V0.8545C1 0.9545 0.9432 1 0.8182 1H0.1818C0.0568 1 0 0.9545 0 0.8545Z"],
  pill: ["M0.5 0A0.5 0.35 0 0 1 1 0.35V0.65A0.5 0.35 0 0 1 0 0.65V0.35A0.5 0.35 0 0 1 0.5 0Z"],
  wide: [
    "M0.15625 0H0.84375C0.96875 0 1 0.05 1 0.25V0.75C1 0.95 0.96875 1 0.84375 1H0.15625C0.03125 1 0 0.95 0 0.75V0.25C0 0.05 0.03125 0 0.15625 0Z",
  ],
  blob: [
    "M0.54 0.03C0.8 0.06 0.98 0.26 0.96 0.52C0.94 0.79 0.72 0.98 0.46 0.96C0.2 0.94 0.03 0.74 0.05 0.47C0.07 0.21 0.28 0 0.54 0.03Z",
    "M0.47 0.04C0.74 0.01 0.97 0.2 0.97 0.49C0.97 0.78 0.77 0.97 0.5 0.97C0.24 0.97 0.02 0.8 0.03 0.52C0.04 0.25 0.21 0.07 0.47 0.04Z",
    "M0.51 0.02C0.77 0.03 0.99 0.23 0.96 0.53C0.93 0.81 0.7 0.99 0.45 0.96C0.19 0.93 0.02 0.71 0.04 0.45C0.06 0.19 0.25 0.01 0.51 0.02Z",
  ],
};

/** How long the blob takes to drift through its outlines and back. */
export const BLOB_SECONDS = 9;

/** `shape`'s outline, and the values to animate it through when it moves. */
export function shapeOutline(shape: WebcamShape): { path: string; morph: string | null } {
  const outlines = SHAPE_OUTLINES[shape];
  return {
    path: outlines[0],
    morph: outlines.length > 1 ? [...outlines, outlines[0]].join(";") : null,
  };
}
