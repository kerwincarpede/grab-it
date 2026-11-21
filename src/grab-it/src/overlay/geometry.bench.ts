import { test } from "vitest";
import * as geometry from "./geometry";
import type { Box, Drag, Point, Size } from "./geometry";

// Taken from the module once: calling through the test runner's export
// getters on every iteration would time the getters as well.
const { advanceDrag, cutoutPath, dragBox, frameParts, HANDLES, labelPlacement, labelTransform, resizeBox, snapToImage, surround, topmostAt } =
  geometry;

const VIEW: Size = { width: 2560, height: 1440 };
const LABEL: Size = { width: 120, height: 24 };

/** A pointer path of `count` moves, sweeping out from the centre and back. */
function pointerPath(count: number): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i / count;
    return { x: 1280 + Math.sin(t * Math.PI * 6) * 1100, y: 720 + Math.cos(t * Math.PI * 4) * 650 };
  });
}

const PATH = pointerPath(1000);

/** 200 windows, front to back, scattered over the view. */
const WINDOWS = Array.from({ length: 200 }, (_, i) => ({
  id: i,
  box: { x: (i * 397) % 2200, y: (i * 211) % 1100, width: 300 + (i % 7) * 40, height: 200 + (i % 5) * 30 },
}));

/** What the overlay works out for one pointer move while a selection is dragged. */
function dragMove(drag: Drag, from: Point, to: Point, ratio: number | null): Drag {
  const next = advanceDrag(drag, from, to, { move: false, square: false, bounds: VIEW, ratio });
  const box: Box = snapToImage(dragBox(next, false, VIEW, ratio), 2);
  cutoutPath(box, VIEW, 8);
  surround(box, VIEW);
  frameParts(box);
  labelTransform(box, labelPlacement(box, LABEL, VIEW));
  return next;
}

test("overlay/geometry", async ({ bench }) => {
  await bench("drag 1000 moves", () => {
    let drag: Drag = { anchor: { x: 1280, y: 720 }, head: { x: 1280, y: 720 } };
    for (let i = 1; i < PATH.length; i++) drag = dragMove(drag, PATH[i - 1], PATH[i], null);
  }).run();

  await bench("drag 1000 moves at 16:9", () => {
    let drag: Drag = { anchor: { x: 1280, y: 720 }, head: { x: 1280, y: 720 } };
    for (let i = 1; i < PATH.length; i++) drag = dragMove(drag, PATH[i - 1], PATH[i], 16 / 9);
  }).run();

  await bench("resize every handle 1000 moves", () => {
    const box: Box = { x: 600, y: 300, width: 1200, height: 800 };
    for (const handle of HANDLES) {
      for (const point of PATH) resizeBox(box, handle, { x: point.x - 1280, y: point.y - 720 }, { bounds: VIEW, ratio: null });
    }
  }).run();

  await bench("window under the pointer 1000 moves", () => {
    for (const point of PATH) topmostAt(WINDOWS, point);
  }).run();
});
