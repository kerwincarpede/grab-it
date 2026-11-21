// Finding Grab-it's windows and driving them. Every window is a webview
// whose URL hash names its route (src/routes.ts), so windows are told apart
// by route and by what their page shows, never by the order of the handles.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { $, $$, browser } from "@wdio/globals";
import type { Sandbox } from "./sandbox";

/** A point in the current window's viewport, in CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

/** What `routeOf` reads from a page. */
interface PageState {
  hash: string;
  has: boolean;
}

/**
 * Switches to a window showing `route` (`app`, `overlay`, `quick`, `editor`)
 * whose page has `selector`, waiting for one to appear. Spare overlays are
 * loaded but hidden, so callers pass a selector that only a live one has.
 */
export async function switchToPage(route: string, selector?: string, timeout = 30_000): Promise<string> {
  let found: string | undefined;
  await browser.waitUntil(
    async () => {
      for (const handle of await browser.getWindowHandles()) {
        try {
          await browser.switchToWindow(handle);
          const page: PageState = await browser.execute(
            (wanted: string | null) => ({
              hash: location.hash,
              has: wanted === null || document.querySelector(wanted) !== null,
            }),
            selector ?? null,
          );
          const [shown] = page.hash.replace(/^#\/?/, "").split(/[?/]/);
          if (shown === route && page.has) {
            found = handle;
            return true;
          }
        } catch {
          // The window closed while it was being looked at.
        }
      }
      return false;
    },
    { timeout, interval: 300, timeoutMsg: `No ${route} window${selector ? ` showing ${selector}` : ""} within ${timeout} ms` },
  );
  if (!found) throw new Error(`No ${route} window`);
  await browser.switchToWindow(found);
  return found;
}

/** The Grab-it window: the Library, with Settings over it. */
export function switchToMainWindow(): Promise<string> {
  return switchToPage("app", ".app-window");
}

/** Clicks the first `selector` match whose visible text contains `text`. */
export async function clickText(selector: string, text: string): Promise<void> {
  let target: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const element of await $$(selector)) {
        if ((await element.getText()).includes(text)) {
          target = element;
          return true;
        }
      }
      return false;
    },
    { timeoutMsg: `Nothing matching ${selector} says "${text}"` },
  );
  await target?.click();
}

/** Starts a region capture with the Grab-it window's New capture button. */
export async function startRegionCapture(): Promise<void> {
  await switchToMainWindow();
  const button = $("button.capture-main");
  await button.waitForClickable();
  await button.click();
}

/**
 * Starts a capture from the New capture menu, which offers the same
 * captures as the hub and goes through the same command (`hub_capture`).
 */
export async function startMenuCapture(title: "Capture screen" | "Capture & record…" | "Capture window"): Promise<void> {
  await switchToMainWindow();
  const more = $("button.capture-more");
  await more.waitForClickable();
  await more.click();
  await clickText('.capture-menu [role="menuitem"]', title);
}

/** The overlay that is on screen with its frozen image, not a hidden spare. */
export const LIVE_OVERLAY = '[data-testid="overlay"][data-ready="true"][data-shown="true"]';

/** Drags with the left mouse button from `from` to `to` in the current window. */
export async function drag(from: Point, to: Point): Promise<void> {
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ x: Math.round(from.x), y: Math.round(from.y) })
    .down({ button: 0 })
    .pause(50)
    .move({ x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2), duration: 150 })
    .move({ x: Math.round(to.x), y: Math.round(to.y), duration: 150 })
    .pause(50)
    .up({ button: 0 })
    .perform();
}

/** Drags a region over the live capture overlay, which captures it at once. */
export async function dragRegionOnOverlay(from: Point, to: Point): Promise<void> {
  await switchToPage("overlay", LIVE_OVERLAY);
  await $(`${LIVE_OVERLAY} img.overlay-image`).waitForExist();
  await drag(from, to);
}

/** The viewport rectangle of the first `selector` match in the current window. */
export async function boxOf(selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  await $(selector).waitForDisplayed();
  return browser.execute((wanted: string) => {
    const box = document.querySelector(wanted)?.getBoundingClientRect();
    return { x: box?.left ?? 0, y: box?.top ?? 0, width: box?.width ?? 0, height: box?.height ?? 0 };
  }, selector);
}

/** The PNG captures in the save folder, oldest first. */
export function captures(sandbox: Sandbox): string[] {
  if (!fs.existsSync(sandbox.originals)) return [];
  return fs
    .readdirSync(sandbox.originals)
    .filter((name) => name.endsWith(".png"))
    .sort()
    .map((name) => path.join(sandbox.originals, name));
}

/** Waits until the save folder holds `count` captures, and returns the newest. */
export async function waitForCapture(sandbox: Sandbox, count: number, timeout = 30_000): Promise<string> {
  await browser.waitUntil(async () => captures(sandbox).length >= count, {
    timeout,
    interval: 250,
    timeoutMsg: `Expected ${count} capture(s) in ${sandbox.originals}, found ${captures(sandbox).length}`,
  });
  const all = captures(sandbox);
  return all[all.length - 1];
}

/** `<name>.meta.json` and the other sidecars beside a capture. */
export function sidecar(capture: string, suffix: "meta.json" | "annotations.json"): string {
  return capture.replace(/\.png$/, `.${suffix}`);
}

/** Waits for a JSON file to exist and parse, and for `accept` to agree, then returns it. */
export async function waitForJson<T>(file: string, accept: (value: T) => boolean = () => true, timeout = 20_000): Promise<T> {
  let value: T | undefined;
  await browser.waitUntil(
    async () => {
      try {
        value = JSON.parse(fs.readFileSync(file, "utf8")) as T;
        return accept(value);
      } catch {
        // Not written yet, or written halfway.
        return false;
      }
    },
    { timeout, interval: 250, timeoutMsg: `${file} never held what was expected` },
  );
  return value as T;
}

/** A PNG's width and height, from its header. */
export function pngSize(file: string): { width: number; height: number } {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Linux: answers the native Save dialog (GTK's, through rfd) with `target`,
 * typed into its name field with xdotool on the test display. WebDriver
 * only reaches webviews, so this is the one native window the suite drives.
 */
export function answerSaveDialog(target: string): void {
  if (process.platform !== "linux") throw new Error("answerSaveDialog only drives GTK's dialog on Linux");
  const xdotool = (...args: string[]) => execFileSync("xdotool", args, { encoding: "utf8", timeout: 30_000 }).trim();
  const [dialog] = xdotool("search", "--sync", "--onlyvisible", "--name", "^Save File$").split(/\s+/);
  xdotool("windowfocus", "--sync", dialog);
  xdotool("key", "--clearmodifiers", "ctrl+a");
  xdotool("type", "--delay", "15", target);
  xdotool("key", "Return");
}
