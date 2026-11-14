import { invoke } from "@tauri-apps/api/core";

/** Mirrors `PinInfo` in src-tauri/src/pin.rs. */
export interface PinInfo {
  width: number;
  height: number;
  /** False for images pinned from the editor, which have no capture to open. */
  editable: boolean;
}

export function pinInfo(): Promise<PinInfo> {
  return invoke<PinInfo>("pin_info");
}

/** The pinned image's bytes. */
export function pinImage(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("pin_image");
}

/** Resizes the pin by `factor`; above 1 grows it. */
export function pinZoom(factor: number): Promise<void> {
  return invoke<void>("pin_zoom", { factor });
}

export function pinCopy(): Promise<void> {
  return invoke<void>("pin_copy");
}

export function pinEdit(): Promise<void> {
  return invoke<void>("pin_edit");
}

export function pinClose(): Promise<void> {
  return invoke<void>("pin_close");
}

/** One notch of the wheel or one press of + or -. */
export const ZOOM_STEP = 1.1;

/** The zoom factor for a wheel movement: up grows the pin. */
export function wheelFactor(deltaY: number): number | null {
  if (deltaY === 0) return null;
  return deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
}
