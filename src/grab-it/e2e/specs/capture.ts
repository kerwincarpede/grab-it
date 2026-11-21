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
 * stretches it over each monitor, so a screen of W × H physical pixels
 * shows fixture pixel (x × 960 / W, y × 540 / H) at screen pixel (x, y):
 * half of it on the suite's 1920 × 1080 Xvfb, but Windows runners and
 * local displays have other sizes, so the specs measure the screen. Each
 * point below sits at least 20 fixture pixels inside its area, clear of
 * the blending the resize does at colour edges.
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

/**
 * The region the region test drags, in fixture pixels: the background,
 * the window's top-left corner and part of the red swatch. Its points sit
 * at least 20 fixture pixels inside the region and inside their area, so
 * they stay there at any screen size.
 */
const REGION = { left: 60, top: 30, right: 300, bottom: 240 };
const REGION_SAMPLES: { at: [number, number]; colour: Rgb; name: string }[] = [
  { at: [90, 55], colour: BACKGROUND, name: "background" },
  { at: [200, 100], colour: TITLE_BAR, name: "title bar" },
  { at: [200, 140], colour: WINDOW, name: "window" },
  { at: [175, 200], colour: RED, name: "red swatch" },
  { at: [240, 215], colour: RED, name: "red swatch" },
];

/** The screen in physical pixels and its scale, read in the current window. */
async function measureScreen(): Promise<{ width: number; height: number; scale: number }> {
  return browser.execute(() => ({
    width: Math.round(window.screen.width * window.devicePixelRatio),
    height: Math.round(window.screen.height * window.devicePixelRatio),
    scale: window.devicePixelRatio,
  }));
}

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
    await switchToMainWindow();
    const screen = await measureScreen();
    // Screen pixels per fixture pixel. The overlay fills the screen, so its
    // CSS pixels are screen pixels divided by the scale.
    const scaleX = screen.width / FIXTURE.width;
    const scaleY = screen.height / FIXTURE.height;
    const toOverlay = (fx: number, fy: number) => ({
      x: Math.round((fx * scaleX) / screen.scale),
      y: Math.round((fy * scaleY) / screen.scale),
    });
    const from = toOverlay(REGION.left, REGION.top);
    const to = toOverlay(REGION.right, REGION.bottom);
    await startRegionCapture();
    await dragRegionOnOverlay(from, to);

    const capture = await waitForCapture(sandbox, 1);
    expect(path.basename(capture)).toMatch(/^Grab-it \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.png$/);
    const meta = await waitForJson<Meta>(sidecar(capture, "meta.json"));
    expect(meta.mode).toBe("region");
    const size = pngSize(capture);
    expect({ width: meta.width, height: meta.height }).toEqual(size);
    // The dragged CSS pixels at the screen's scale, give or take the
    // snapping to whole image pixels.
    expect(Math.abs(size.width - (to.x - from.x) * screen.scale)).toBeLessThanOrEqual(2);
    expect(Math.abs(size.height - (to.y - from.y) * screen.scale)).toBeLessThanOrEqual(2);

    // Capture pixel (x, y) is the screen pixel that far from where the
    // drag started, which shows the fixture pixel scaled back from there.
    const image = readPng(capture);
    expectPixels(
      image,
      REGION_SAMPLES.map(({ at: [fx, fy], colour, name }) => ({
        x: fx * scaleX - from.x * screen.scale,
        y: fy * scaleY - from.y * screen.scale,
        colour,
        name,
      })),
    );
  });

  it("shows the capture on the Quick Access card", async () => {
    const capture = await waitForCapture(sandbox, 1);
    await switchToPage("quick", 'main[data-testid="quick"].quick-capture');
    await expect($(`button[aria-label="Annotate ${path.basename(capture)}"]`)).toBeDisplayed();
    await expect($('[role="toolbar"][aria-label="Capture actions"]')).toBeDisplayed();
  });

  it("saves the whole screen from the New capture menu", async () => {
    await switchToMainWindow();
    const { width, height } = await measureScreen();
    const screen = { width, height };
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
