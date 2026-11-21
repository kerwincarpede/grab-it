import fs from "node:fs";
import { $, browser, expect } from "@wdio/globals";
import { clickElement, clickText, markByText, switchToMainWindow, waitForJson } from "../support/app";
import { currentSandbox } from "../support/sandbox";

/** Opens Settings on its After a capture page and returns the copy switch's selector. */
async function openCaptureSettings(): Promise<string> {
  await switchToMainWindow();
  await clickText("nav.sidebar button.nav-item", "Settings");
  await $(".settings-dialog").waitForDisplayed();
  await clickText(".settings-nav button.nav-item", "After a capture");
  await $("#after-capture-heading").waitForDisplayed();
  const row = await markByText("label.row", "Copy every capture to the clipboard");
  const copy = `${row} input[role="switch"]`;
  await $(copy).waitForEnabled();
  return copy;
}

/** Whether the switch at `selector` is on, read from the DOM. */
function isOn(selector: string): Promise<boolean> {
  return browser.execute((wanted: string) => document.querySelector<HTMLInputElement>(wanted)?.checked === true, selector);
}

describe("Settings", () => {
  const sandbox = currentSandbox();

  it("saves a changed setting at once", async () => {
    const copy = await openCaptureSettings();
    expect(await isOn(copy)).toBe(true);
    await clickElement(copy);
    await browser.waitUntil(async () => !(await isOn(copy)), { timeoutMsg: "The switch did not turn off" });
    await waitForJson<{ copyToClipboard?: boolean }>(sandbox.settingsFile, (settings) => settings.copyToClipboard === false);
  });

  it("keeps it after a restart", async () => {
    expect(JSON.parse(fs.readFileSync(sandbox.settingsFile, "utf8")).copyToClipboard).toBe(false);
    await browser.reloadSession();
    const copy = await openCaptureSettings();
    expect(await isOn(copy)).toBe(false);
  });
});
