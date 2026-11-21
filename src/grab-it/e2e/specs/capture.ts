import path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import {
  closeTo,
  dragRegionOnOverlay,
  pngSize,
  readPng,
  type DecodedPng,
  type Rgb,
  sidecar,
  startMenuCapture,
  startRegionCapture,
  switchToMainWindow,
  switchToPage,
  waitForCapture,
  waitForJson,
} from "../support/app";
import { currentSandbox } from "../support/sandbox";

/** The parts of `<name>.meta.json` these specs check. Mirrors `CaptureMeta` in src-tauri/src/capture.rs. */
interface Meta {
  mode: string;
  width: number;
  height: number;
}

/**
 * e2e/fixtures/screen.png is 960 × 540. With the e2e feature, screen.rs
 * resizes it to each monitor's size, so on the suite's 1920 × 1080 Xvfb a
 * screen pixel (x, y) shows fixture pixel (x / 2, y / 2). Each point below
 * sits at least 20 fixture pixels inside its area, clear of the blending
 * the resize does at colour edges. The one exception is the region
 * capture's background point (105, 80), which is 15 from the window's left
 * edge: the region starts at fixture x 100 and the window at x 120, so no
 * background point inside the region is further from that edge.
 */
const FIXTURE = { width: 960, height: 540 };
const BACKGROUND: Rgb = [36, 41, 51];
const TITLE_BAR: Rgb = [63, 81, 181];
const WINDOW: Rgb = [245, 246, 248];
const RED: Rgb = [229, 57, 53];
const GREEN: Rgb = [67, 160, 71];
const BLUE: Rgb = [30, 136, 229];
const YELLOW: Rgb = [253, 216, 53];

/** Fixture points and the colour each shows. */
const SAMPLES: { at: [number, number]; colour: Rgb; name: string }[] = [
  { at: [50, 50], colour: BACKGROUND, name: "background" },
  { at: [880, 500], colour: BACKGROUND, name: "background" },
  { at: [480, 100], colour: TITLE_BAR, name: "title bar" },
  { at: [480, 280], colour: WINDOW, name: "window" },
  { at: [210, 210], colour: RED, name: "red swatch" },
  { at: [390, 210], colour: GREEN, name: "green swatch" },
  { at: [570, 210], colour: BLUE, name: "blue swatch" },
  { at: [750, 210], colour: YELLOW, name: "yellow swatch" },
];

/** Fails with every pixel of `image` that does not show what was expected. */
function expectPixels(image: DecodedPng, expected: { x: number; y: number; colour: Rgb; name: string }[]): void {
  const wrong = expected
    .map(({ x, y, colour, name }) => ({ x, y, name, colour, actual: image.at(x, y) }))
    .filter(({ colour, actual }) => !closeTo(actual, colour))
    .map(({ x, y, name, colour, actual }) => `(${x}, ${y}) ${name}: expected ${colour.join(",")}, got ${actual.join(",")}`);
  expect(wrong).toEqual([]);
}

describe("Capture", () => {
  const sandbox = currentSandbox();

  it("saves a dragged region as a PNG with its meta.json", async () => {
    await startRegionCapture();
    await dragRegionOnOverlay({ x: 200, y: 150 }, { x: 600, y: 450 });

    const capture = await waitForCapture(sandbox, 1);
    expect(path.basename(capture)).toMatch(/^Grab-it \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.png$/);
    const meta = await waitForJson<Meta>(sidecar(capture, "meta.json"));
    expect(meta.mode).toBe("region");
    const size = pngSize(capture);
    expect({ width: meta.width, height: meta.height }).toEqual(size);
    // 400 × 300 CSS pixels on a display at scale 1, give or take the
    // snapping to whole image pixels.
    expect(Math.abs(size.width - 400)).toBeLessThanOrEqual(2);
    expect(Math.abs(size.height - 300)).toBeLessThanOrEqual(2);

    // The overlay fills the 1920 × 1080 screen at scale 1, so capture pixel
    // (x, y) is screen pixel (200 + x, 150 + y), which shows fixture pixel
    // ((200 + x) / 2, (150 + y) / 2).
    const image = readPng(capture);
    const toCapture = (fx: number, fy: number) => ({ x: fx * 2 - 200, y: fy * 2 - 150 });
    expectPixels(image, [
      { ...toCapture(105, 80), colour: BACKGROUND, name: "background" },
      { ...toCapture(200, 100), colour: TITLE_BAR, name: "title bar" },
      { ...toCapture(200, 140), colour: WINDOW, name: "window" },
      { ...toCapture(175, 200), colour: RED, name: "red swatch" },
      { ...toCapture(210, 210), colour: RED, name: "red swatch" },
    ]);
  });

  it("shows the capture on the Quick Access card", async () => {
    const capture = await waitForCapture(sandbox, 1);
    await switchToPage("quick", 'main[data-testid="quick"].quick-capture');
    await expect($(`button[aria-label="Annotate ${path.basename(capture)}"]`)).toBeDisplayed();
    await expect($('[role="toolbar"][aria-label="Capture actions"]')).toBeDisplayed();
  });

  it("saves the whole screen from the New capture menu", async () => {
    await switchToMainWindow();
    const screen = await browser.execute(() => ({
      width: Math.round(window.screen.width * window.devicePixelRatio),
      height: Math.round(window.screen.height * window.devicePixelRatio),
    }));
    await startMenuCapture("Capture screen");

    const capture = await waitForCapture(sandbox, 2);
    const meta = await waitForJson<Meta>(sidecar(capture, "meta.json"));
    expect(meta.mode).toBe("screen");
    expect(pngSize(capture)).toEqual(screen);
    expect({ width: meta.width, height: meta.height }).toEqual(screen);

    // The fixture, resized to the screen.
    const image = readPng(capture);
    const scaleX = image.width / FIXTURE.width;
    const scaleY = image.height / FIXTURE.height;
    expectPixels(
      image,
      SAMPLES.map(({ at: [fx, fy], colour, name }) => ({ x: fx * scaleX, y: fy * scaleY, colour, name })),
    );
  });

  it("puts the newest capture on the Quick Access card", async () => {
    const capture = await waitForCapture(sandbox, 2);
    await switchToPage("quick", `button[aria-label="Annotate ${path.basename(capture)}"]`);
  });
});
