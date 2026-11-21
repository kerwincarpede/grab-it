import fs from "node:fs";
import path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { clickElement, clickText, sidecar, startMenuCapture, switchToMainWindow, waitForCapture, waitForJson } from "../support/app";
import { currentSandbox } from "../support/sandbox";

describe("Library", () => {
  const sandbox = currentSandbox();
  let capture = "";
  let tile = "";

  before(async () => {
    await startMenuCapture("Capture screen");
    capture = await waitForCapture(sandbox, 1);
    await waitForJson(sidecar(capture, "meta.json"));
    tile = `button.tile-main[aria-label="${path.basename(capture)}"]`;
  });

  it("lists a new capture", async () => {
    await switchToMainWindow();
    await expect($(tile)).toBeDisplayed();
    await expect($(".empty-title")).not.toBeExisting();
  });

  it("deletes the capture with its sidecars", async () => {
    // As the editor leaves one once a capture is annotated.
    const annotations = sidecar(capture, "annotations.json");
    fs.writeFileSync(annotations, `${JSON.stringify({ version: 1, shapes: [], crop: null })}\n`);
    const files = [capture, sidecar(capture, "meta.json"), annotations];

    await switchToMainWindow();
    await clickElement(tile);
    await expect($("aside.details")).toBeDisplayed();
    await clickText("aside.details .details-delete button", "Delete…");
    await clickText("aside.details .details-delete button", "Delete permanently");

    await browser.waitUntil(() => files.every((file) => !fs.existsSync(file)), {
      timeoutMsg: `Still on disk: ${files.filter((file) => fs.existsSync(file)).join(", ")}`,
    });
    await expect($(tile)).not.toBeExisting();
    await expect($(".empty-title")).toHaveText("Your library is empty");
  });
});
