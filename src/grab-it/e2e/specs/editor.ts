import fs from "node:fs";
import path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import {
  answerSaveDialog,
  boxOf,
  clickElement,
  clickText,
  drag,
  pngSize,
  sha256,
  sidecar,
  startMenuCapture,
  switchToPage,
  waitForCapture,
  waitForJson,
  waitForText,
} from "../support/app";
import { currentSandbox } from "../support/sandbox";

/** The parts of `<name>.annotations.json` this spec checks (src/editor/sidecar.ts). */
interface Annotations {
  version: number;
  shapes: { type: string }[];
}

const EDITOR_READY = '[data-testid="editor"][data-ready="true"]';

describe("Editor", () => {
  const sandbox = currentSandbox();
  let capture = "";
  let originalHash = "";

  before(async () => {
    await startMenuCapture("Capture screen");
    capture = await waitForCapture(sandbox, 1);
    originalHash = sha256(capture);
  });

  it("opens the capture from Quick Access", async () => {
    await switchToPage("quick", `button[aria-label="Annotate ${path.basename(capture)}"]`);
    await clickElement('button[title="Open in the editor"]');
    await switchToPage("editor", EDITOR_READY);
    await expect($(".editor-canvas canvas")).toExist();
  });

  it("saves a drawn rectangle to the annotations sidecar", async () => {
    await switchToPage("editor", EDITOR_READY);
    const rectangle = '.editor-rail button[aria-label="Rectangle"]';
    await clickElement(rectangle);
    await expect($(rectangle)).toHaveAttribute("aria-pressed", "true");

    // The capture is fitted in the middle of the canvas.
    const canvas = await boxOf(".editor-canvas");
    const centre = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
    await drag({ x: centre.x - 80, y: centre.y - 50 }, { x: centre.x + 80, y: centre.y + 50 });

    const annotations = await waitForJson<Annotations>(sidecar(capture, "annotations.json"), (doc) =>
      doc.shapes.some((shape) => shape.type === "rect"),
    );
    expect(annotations.version).toBe(1);
    expect(sha256(capture)).toBe(originalHash);
  });

  it("exports a PNG and leaves the original unchanged", async function () {
    if (process.platform !== "linux") {
      // The native Save dialog sits outside the webview, so WebDriver cannot
      // answer it; on Linux xdotool does, on X11. Windows' common dialog is
      // not driven, so this flow is skipped there.
      this.skip();
    }
    await switchToPage("editor", EDITOR_READY);
    const target = path.join(sandbox.exports, "annotated.png");
    await clickText(".editor-topbar button.primary", "Export");
    answerSaveDialog(target);

    await browser.waitUntil(() => fs.existsSync(target) && fs.statSync(target).size > 24, {
      timeoutMsg: `Nothing was exported to ${target}`,
    });
    await waitForText(".editor-status .status-message", (text) => text.includes("Exported to"));
    // Without a crop or backdrop the export is the capture's size
    // (exportArea in src/editor/flatten.ts).
    expect(pngSize(target)).toEqual(pngSize(capture));
    expect(sha256(capture)).toBe(originalHash);
  });
});
