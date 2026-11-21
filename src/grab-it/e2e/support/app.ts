// Finding Grab-it's windows and driving them. Every window is a webview
// whose URL hash names its route (src/routes.ts), so windows are told apart
// by route and by what their page shows, never by the order of the handles.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { $, browser } from "@wdio/globals";
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

/**
 * Clicks `selector`: a WebDriver click, or a DOM click when WebDriver
 * cannot click it (covered, or still animating in).
 */
export async function clickElement(selector: string): Promise<void> {
  const element = $(selector);
  await element.waitForExist();
  try {
    await element.waitForClickable({ timeout: 5_000 });
    await element.click();
  } catch {
    const clicked = await browser.execute((wanted: string) => {
      const target = document.querySelector<HTMLElement>(wanted);
      target?.click();
      return target !== null;
    }, selector);
    if (!clicked) throw new Error(`Nothing to click at ${selector}`);
  }
}

let marks = 0;

/**
 * Marks the first `selector` match whose text contains `text`, waiting for
 * one, and returns a selector for just that element. The text is read from
 * the DOM (`textContent`) in the page, not through WebDriver's Get Element
 * Text, which WebKitWebDriver did not answer for these lists.
 */
export async function markByText(selector: string, text: string, timeout = 20_000): Promise<string> {
  const mark = `e2e-${process.pid}-${++marks}`;
  await browser.waitUntil(
    () =>
      browser.execute(
        (wanted: string, words: string, id: string) => {
          const match = Array.from(document.querySelectorAll(wanted)).find((element) =>
            (element.textContent ?? "").replace(/\s+/g, " ").includes(words),
          );
          match?.setAttribute("data-e2e-mark", id);
          return match !== undefined;
        },
        selector,
        text,
        mark,
      ),
    { timeout, interval: 250, timeoutMsg: `Nothing matching ${selector} says "${text}"` },
  );
  return `[data-e2e-mark="${mark}"]`;
}

/** Clicks the first `selector` match whose text contains `text`. */
export async function clickText(selector: string, text: string): Promise<void> {
  await clickElement(await markByText(selector, text));
}

/** Starts a region capture with the Grab-it window's New capture button. */
export async function startRegionCapture(): Promise<void> {
  await switchToMainWindow();
  await clickElement("button.capture-main");
}

/**
 * Starts a capture from the New capture menu, which offers the same
 * captures as the hub and goes through the same command (`hub_capture`).
 */
export async function startMenuCapture(title: "Capture screen" | "Capture & record…" | "Capture window"): Promise<void> {
  await switchToMainWindow();
  // The menu closes on a click outside it or on losing focus; open it
  // again if it closed before the item could be clicked.
  await browser.waitUntil(
    async () => {
      if (!(await $(".capture-menu").isExisting())) await clickElement("button.capture-more");
      return $(".capture-menu").isExisting();
    },
    { timeout: 20_000, interval: 500, timeoutMsg: "The New capture menu never opened" },
  );
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
    // Not released afterwards: a drag on the overlay captures and closes
    // it, and releasing in a closed window fails with "no such window".
    .perform(true)
    .catch((err: unknown) => {
      if (!/no such window/i.test(String(err))) throw err;
    });
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

/** Whether `file` is a whole PNG: the signature, then an IEND chunk at the very end. */
function isCompletePng(file: string): boolean {
  try {
    const bytes = fs.readFileSync(file);
    return (
      bytes.length > 20 &&
      bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
      bytes.subarray(-12).toString("hex") === "0000000049454e44ae426082"
    );
  } catch {
    return false;
  }
}

/** Whether `file` exists and parses as JSON. */
function isJson(file: string): boolean {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until the save folder holds `count` captures, and returns the
 * newest once it is fully saved. The PNG appears empty and fills as it is
 * encoded, and meta.json is written only after it (capture.rs
 * `save_capture_with_pointer`), so the newest counts as saved when its
 * meta.json parses and the PNG ends with its IEND chunk.
 */
export async function waitForCapture(sandbox: Sandbox, count: number, timeout = 30_000): Promise<string> {
  let newest = "";
  await browser.waitUntil(
    async () => {
      const all = captures(sandbox);
      if (all.length < count) return false;
      newest = all[all.length - 1];
      return isJson(sidecar(newest, "meta.json")) && isCompletePng(newest);
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `Expected ${count} saved capture(s) in ${sandbox.originals}, found ${captures(sandbox).length}`,
    },
  );
  return newest;
}

/**
 * Waits for the first `selector` match's text to satisfy `accept`, and
 * returns it. The text is read from the DOM (`textContent`) in the page:
 * WebKitWebDriver's Get Element Text does not answer reliably, so the specs
 * never use `getText` or `toHaveText`.
 */
export async function waitForText(selector: string, accept: (text: string) => boolean, timeout = 20_000): Promise<string> {
  let text = "";
  await browser.waitUntil(
    async () => {
      const read: string | null = await browser.execute(
        (wanted: string) => document.querySelector(wanted)?.textContent ?? null,
        selector,
      );
      if (read === null) return false;
      text = read.replace(/\s+/g, " ").trim();
      return accept(text);
    },
    { timeout, interval: 250, timeoutMsg: `${selector} never showed the expected text (last: "${text}")` },
  );
  return text;
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
