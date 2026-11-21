import fs from "node:fs";
import { $, $$, browser, expect } from "@wdio/globals";
import { clickText, switchToMainWindow, waitForJson } from "../support/app";
import { currentSandbox } from "../support/sandbox";

const COPY_SWITCH_ROW = "label.row";
const COPY_SWITCH_TITLE = "Copy every capture to the clipboard";

/** Opens Settings on its After a capture page and returns the copy switch. */
async function openCaptureSettings(): Promise<WebdriverIO.Element> {
  await switchToMainWindow();
  await clickText("nav.sidebar button.nav-item", "Settings");
  await $(".settings-dialog").waitForDisplayed();
  await clickText(".settings-nav button.nav-item", "After a capture");
  await $("#after-capture-heading").waitForDisplayed();
  let found: WebdriverIO.Element | undefined;
  await browser.waitUntil(async () => {
    for (const row of await $$(COPY_SWITCH_ROW)) {
      if ((await row.getText()).includes(COPY_SWITCH_TITLE)) {
        found = await row.$('input[role="switch"]').getElement();
        return true;
      }
    }
    return false;
  });
  if (!found) throw new Error(`No "${COPY_SWITCH_TITLE}" switch`);
  await found.waitForEnabled();
  return found;
}

describe("Settings", () => {
  const sandbox = currentSandbox();

  it("saves a changed setting at once", async () => {
    const copy = await openCaptureSettings();
    await expect(copy).toBeSelected();
    await copy.click();
    await expect(copy).not.toBeSelected();
    await waitForJson<{ copyToClipboard?: boolean }>(sandbox.settingsFile, (settings) => settings.copyToClipboard === false);
  });

  it("keeps it after a restart", async () => {
    await browser.reloadSession();
    expect(JSON.parse(fs.readFileSync(sandbox.settingsFile, "utf8")).copyToClipboard).toBe(false);
    const copy = await openCaptureSettings();
    await expect(copy).not.toBeSelected();
  });
});
