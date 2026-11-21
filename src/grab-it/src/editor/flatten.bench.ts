import { test } from "vitest";
import * as flatten from "./flatten";
import { BACKDROP_FILLS, BACKDROP_MESHES, BACKDROP_PRESETS, DEFAULT_BACKDROP, type Backdrop, type BackdropAspect } from "./model";

// Taken from the module once: calling through the test runner's export
// getters on every iteration would time the getters as well.
const { backdropLayout, backdropPaint, blurredGeometry, exportArea, plainBorders } = flatten;

/** A `width`×`height` white capture with a dark window in the middle, as `plainBorders` reads it. */
function capture(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = Math.round(height * 0.2); y < Math.round(height * 0.8); y++) {
    for (let x = Math.round(width * 0.15); x < Math.round(width * 0.85); x++) data.set([32, 36, 44, 255], (y * width + x) * 4);
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

const FULL_HD = capture(1920, 1080);
const PLAIN = capture(1920, 1080);
PLAIN.data.fill(255);

const SIZE = { width: 1920, height: 1080 };
const ASPECTS: BackdropAspect[] = ["auto", "16:9", "4:3", "1:1", "9:16"];
const FILLS = [
  ...BACKDROP_PRESETS.map((preset) => preset.id),
  ...BACKDROP_MESHES.map((mesh) => mesh.id),
  ...Object.values(BACKDROP_FILLS),
];
/** Every fill at every aspect, balanced and not. */
const BACKDROPS: Backdrop[] = FILLS.flatMap((fill) =>
  ASPECTS.flatMap((aspect) => [false, true].map((balance) => ({ ...DEFAULT_BACKDROP, fill, aspect, balance }))),
);
const BORDERS = { top: 216, right: 288, bottom: 216, left: 288 };

test("editor/flatten", async ({ bench }) => {
  await bench("plain borders of a 1920×1080 capture", () => plainBorders(FULL_HD)).run();

  await bench("plain borders of a plain 1920×1080 capture", () => plainBorders(PLAIN)).run();

  await bench("lay out and paint every backdrop", () => {
    for (const backdrop of BACKDROPS) {
      const layout = backdropLayout(SIZE, backdrop, 2, backdrop.balance ? BORDERS : null);
      backdropPaint(backdrop, layout);
      blurredGeometry(layout);
    }
  }).run();

  await bench("export area at 1000 views", () => {
    for (let i = 0; i < 1000; i++) {
      exportArea({ x: i, y: i / 2, width: 800, height: 600 }, SIZE, { scale: 0.25 + i / 1000, x: i % 40, y: i % 30 });
    }
  }).run();
});
