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

/** Mirrors `OverlayInfo` in src-tauri/src/overlay.rs. */
export interface OverlayInfo {
  mode: CaptureMode;
  monitorWidth: number;
  monitorHeight: number;
  /** Front to back. */
  windows: OverlayWindow[];
}

export type Selection =
  | { kind: "region"; rect: Box; viewportWidth: number }
  | { kind: "window"; id: number };

export function overlayInfo(): Promise<OverlayInfo> {
  return invoke<OverlayInfo>("overlay_info");
}

/** The frozen monitor as PNG bytes. */
export function overlayImage(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("overlay_image");
}

export function finishOverlay(selection: Selection): Promise<void> {
  return invoke<void>("overlay_finish", { selection });
}

export function cancelOverlay(): Promise<void> {
  return invoke<void>("overlay_cancel");
}
