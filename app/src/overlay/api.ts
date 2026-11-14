import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { routeFromHash, routeHasFlag } from "../routes";
import type { Box } from "./geometry";

export type CaptureMode = "region" | "window" | "screen" | "monitor";

/** Mirrors `OverlayWindow` in src-tauri/src/overlay.rs: monitor units. */
export interface OverlayWindow {
  id: number;
  title: string;
  appName: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the selection is for: a screenshot, text recognition over the dragged
 * area, the colour of one pixel, or the area to record as a GIF.
 */
export type OverlayIntent = "capture" | "text" | "color" | "record";

/** Mirrors `OverlayInfo` in src-tauri/src/overlay.rs. */
export interface OverlayInfo {
  mode: CaptureMode;
  /** Older backends leave this out; treat that as "capture". */
  intent?: OverlayIntent;
  monitorWidth: number;
  monitorHeight: number;
  /**
   * The frozen image's width in its own pixels, known before the image
   * itself arrives. Older backends leave this out.
   */
  imageWidth?: number;
  /** Front to back. */
  windows: OverlayWindow[];
  /**
   * How far down the monitor the menu bar or a camera notch reaches, as a
   * share of its height. Older backends leave this out.
   */
  topInset?: number;
}

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

export type Selection =
  | { kind: "region"; rect: Box; viewportWidth: number }
  | { kind: "window"; id: number }
  /** One point in CSS pixels, scaled by the backend like a region is. */
  | { kind: "point"; x: number; y: number; viewportWidth: number };

/**
 * What this overlay is to show. Null in a spare overlay, loaded ahead of
 * time with no selection yet: `onOverlayStart` says when to ask again.
 */
export function overlayInfo(): Promise<OverlayInfo | null> {
  return invoke<OverlayInfo | null>("overlay_info");
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

/** The frozen image is on screen: the backend may show this overlay now. */
export function overlayReady(): Promise<void> {
  return invoke<void>("overlay_ready");
}

export function finishOverlay(selection: Selection): Promise<void> {
  return invoke<void>("overlay_finish", { selection });
}

export function cancelOverlay(): Promise<void> {
  return invoke<void>("overlay_cancel");
}
