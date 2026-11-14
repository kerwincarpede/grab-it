import { invoke } from "@tauri-apps/api/core";
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
  /** Front to back. */
  windows: OverlayWindow[];
}

export type Selection =
  | { kind: "region"; rect: Box; viewportWidth: number }
  | { kind: "window"; id: number }
  /** One point in CSS pixels, scaled by the backend like a region is. */
  | { kind: "point"; x: number; y: number; viewportWidth: number };

export function overlayInfo(): Promise<OverlayInfo> {
  return invoke<OverlayInfo>("overlay_info");
}

/** The frozen monitor as PNG bytes. */
export function overlayImage(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("overlay_image");
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
