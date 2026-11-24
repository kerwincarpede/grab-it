import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { commands, type CaptureMode, type Intent, type OverlayInfo_Serialize, type OverlayWindow, type Selection } from "../app/bindings";
import { routeFromHash, routeHasFlag } from "../routes";
import type { Point } from "./geometry";

/** Generated from `CaptureMode` in src-tauri/src/overlay.rs. */
export type { CaptureMode };

/** A window the overlay can pick, in monitor units. Generated from `OverlayWindow` in src-tauri/src/overlay.rs. */
export type { OverlayWindow };

/**
 * What the selection is for: a screenshot, text recognition over the dragged
 * area, the colour of one pixel, or the area to record as a GIF. Generated
 * from `Intent` in src-tauri/src/overlay.rs.
 */
export type OverlayIntent = Intent;

/**
 * What this overlay is to show, generated from `OverlayInfo` in
 * src-tauri/src/overlay.rs. The toolbar's choice and the toolbar centre are
 * narrowed to what the backend sends in practice: a choice is only ever
 * shared complete (`OverlayChoice`), and a centre's coordinates are finite.
 */
export type OverlayInfo = Omit<OverlayInfo_Serialize, "choice" | "barCentre"> & {
  choice: OverlayChoice | null;
  barCentre: Point | null;
};

/** Mirrors `START_EVENT` in src-tauri/src/overlay.rs. */
export const START_EVENT = "overlay-start";

/**
 * True in an overlay whose window is see-through and on screen from the
 * start, ahead of its frozen image; the backend says so in the window's URL
 * (`#/overlay?instant`). Any other overlay is hidden until the image is
 * painted.
 */
export function isInstantOverlay(hash: string = window.location.hash): boolean {
  return routeFromHash(hash) === "overlay" && routeHasFlag(hash, "instant");
}

/**
 * True in a Windows overlay (`#/overlay?windows`): a see-through window laid
 * over the frozen screen, which the backend already has on show. The
 * overlays are shown together once every page is up, ahead of their images.
 */
export function isWindowsOverlay(hash: string = window.location.hash): boolean {
  return routeFromHash(hash) === "overlay" && routeHasFlag(hash, "windows");
}

/**
 * A finished selection: a region or a point in CSS pixels, a window, or
 * every monitor. Generated from `Selection` in src-tauri/src/overlay.rs.
 */
export type { Selection };

/**
 * What this overlay is to show. Null in a spare overlay, loaded ahead of
 * time with no selection yet: `onOverlayStart` says when to ask again.
 */
export function overlayInfo(): Promise<OverlayInfo | null> {
  // Narrowed as `OverlayInfo` says.
  return commands.overlayInfo() as Promise<OverlayInfo | null>;
}

/**
 * Calls `handler` when a selection starts on a spare overlay. Resolves to a
 * function that stops listening.
 */
export function onOverlayStart(handler: () => void): Promise<() => void> {
  return listen(START_EVENT, () => handler());
}

/** The frozen monitor: an uncompressed BMP on macOS, a PNG elsewhere. */
export function overlayImage(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("overlay_image");
}

/** The type of `overlayImage`'s bytes, from their first two: "BM" is a BMP. */
export function imageType(bytes: ArrayBuffer): string {
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  return head[0] === 0x42 && head[1] === 0x4d ? "image/bmp" : "image/png";
}

/** This overlay is ready for the backend to show. */
export async function overlayReady(): Promise<void> {
  await commands.overlayReady();
}

/** The Windows overlays are now visible. */
export function onOverlayRevealed(handler: () => void): Promise<() => void> {
  return listen("overlay-revealed", () => handler());
}

/**
 * What All-in-one's toolbar chose. `Choice` in src-tauri/src/overlay.rs, the
 * generated `Choice_Deserialize`, leaves each field optional; the overlay
 * always sends all three.
 */
export interface OverlayChoice {
  intent: OverlayIntent;
  mode: "region" | "window" | "screen";
  /** The Timer: seconds to wait, with the overlay closed, before capturing live. */
  delaySeconds: number;
  /** Scroll: the user scrolls by hand instead of Grab-it. */
  scrollByHand?: boolean;
}

/**
 * Ends the selection. An All-in-one overlay sends what its toolbar chose
 * with it; any other overlay sends the selection alone.
 */
export async function finishOverlay(selection: Selection, choice?: OverlayChoice): Promise<void> {
  await commands.overlayFinish(selection, choice ?? null);
}

/** Mirrors `CHOICE_EVENT` in src-tauri/src/overlay.rs. */
export const CHOICE_EVENT = "overlay-choice";

/**
 * Tells the backend, and through it every other monitor's overlay, what
 * All-in-one's toolbar now has chosen.
 */
export async function chooseOverlay(choice: OverlayChoice): Promise<void> {
  await commands.overlayChoose(choice);
}

/**
 * Calls `handler` when another monitor's toolbar changed the choice.
 * Resolves to a function that stops listening.
 */
export function onOverlayChoice(handler: (choice: OverlayChoice) => void): Promise<() => void> {
  return listen<OverlayChoice>(CHOICE_EVENT, (event) => handler(event.payload));
}

export function cancelOverlay(): Promise<void> {
  return commands.overlayCancel();
}

/**
 * Remembers where the setup toolbar was dragged to, its centre in this
 * overlay's CSS px, as the spot the recording toolbar opens at on this
 * display (`record_bar_remember`).
 */
export async function rememberSetupSpot(centre: Point): Promise<void> {
  await commands.recordBarRemember(centre);
}

/**
 * The overlay bench's comma-separated switches, or null when
 * `GRAB_IT_OVERLAY_BENCH` is not set. Only asked for on an overlay opened
 * for the bench (`#/overlay?bench`).
 */
export function overlayBenchConfig(): Promise<string | null> {
  return commands.overlayBenchConfig();
}

/** Prints one line of the bench's report to the app's stderr. */
export function overlayBenchLog(line: string): Promise<void> {
  return commands.overlayBenchLog(line);
}

/** macOS: makes the overlay's window opaque, for the bench's `opaque` switch. */
export function overlayBenchOpaque(): Promise<void> {
  return commands.overlayBenchOpaque();
}
