import fs from "node:fs";
import path from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { switchToMainWindow, waitForText } from "../support/app";
import { currentSandbox } from "../support/sandbox";

describe("Launch", () => {
  const sandbox = currentSandbox();

  it("opens the Grab-it window on an empty Library", async () => {
    await switchToMainWindow();
    await expect($("nav.sidebar")).toBeDisplayed();
    await waitForText("button.capture-main", (text) => text.includes("New capture"));
    await waitForText(".empty-title", (text) => text === "Your library is empty");
  });

  it("keeps its data in the sandbox", async () => {
    await browser.waitUntil(() => fs.existsSync(path.join(sandbox.appData, "library.db")), {
      timeoutMsg: `No library.db in ${sandbox.appData}`,
    });
    if (process.platform !== "win32") {
      // The control connection's socket (control.rs) sits beside it.
      await browser.waitUntil(() => fs.existsSync(path.join(sandbox.appData, "control.sock")), {
        timeoutMsg: `No control.sock in ${sandbox.appData}`,
      });
    }
    const settings = JSON.parse(fs.readFileSync(sandbox.settingsFile, "utf8")) as { saveFolder: string };
    expect(settings.saveFolder).toBe(sandbox.saveFolder);
  });
});
