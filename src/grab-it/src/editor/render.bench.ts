import { test } from "vitest";
import { BACKDROP_FILLS, DEFAULT_BACKDROP, emptyAnnotations, type Annotations, type Rotation } from "./model";
import * as render from "./render";

// Taken from the module once: calling through the test runner's export
// getters on every iteration would time the getters as well.
const { renderPlan } = render;

const SIZE = { width: 2880, height: 1800 };
const ROTATIONS: Rotation[] = [0, 90, 180, 270];
const BACKDROPS = [null, DEFAULT_BACKDROP, { ...DEFAULT_BACKDROP, fill: BACKDROP_FILLS.blur, balance: true }, { ...DEFAULT_BACKDROP, fill: BACKDROP_FILLS.image, image: "/pics/sea.jpg" }];

/** Every turn and mirror, cropped and not, under every kind of backdrop: 128 edited captures. */
const DOCS: Annotations[] = ROTATIONS.flatMap((rotation) =>
  [false, true].flatMap((flipX) =>
    [null, { x: 120, y: 80, width: 1600, height: 900 }].flatMap((crop) =>
      BACKDROPS.flatMap((backdrop) =>
        [false, true].map((flipY) => ({ ...emptyAnnotations(), rotation, flipX, flipY, crop, backdrop })),
      ),
    ),
  ),
);

test("editor/render", async ({ bench }) => {
  await bench("plan 128 edited captures", () => {
    for (const doc of DOCS) renderPlan(doc, SIZE, 2);
  }).run();

  await bench("plan 128 captures without a scale factor", () => {
    for (const doc of DOCS) renderPlan(doc, SIZE, null);
  }).run();
});
