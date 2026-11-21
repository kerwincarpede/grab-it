import path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import {
  dragRegionOnOverlay,
  pngSize,
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
  });

  it("puts the newest capture on the Quick Access card", async () => {
    const capture = await waitForCapture(sandbox, 2);
    await switchToPage("quick", `button[aria-label="Annotate ${path.basename(capture)}"]`);
  });
});
