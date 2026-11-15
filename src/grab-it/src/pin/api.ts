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

/**
 * Makes the pin click-through while it stays on top. It takes no mouse
 * input until Unlock pinned captures in the tray menu.
 */
export function pinLock(): Promise<void> {
  return invoke<void>("pin_lock");
}

/** Moves the pin by `dx`, `dy` logical pixels. */
export function pinNudge(dx: number, dy: number): Promise<void> {
  return invoke<void>("pin_nudge", { dx, dy });
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

/** The faintest a pin can be faded. */
export const MIN_OPACITY = 0.2;
/** One notch of Ctrl/⌘ + wheel, and one step of the slider. */
export const OPACITY_STEP = 0.1;

/** `opacity` kept between `MIN_OPACITY` and 1, on the slider's steps. */
export function clampOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return 1;
  const stepped = Math.round(opacity / OPACITY_STEP) * OPACITY_STEP;
  return Math.round(Math.min(1, Math.max(MIN_OPACITY, stepped)) * 100) / 100;
}

/** The opacity after a Ctrl/⌘ + wheel movement: up makes the pin more solid. */
export function wheelOpacity(current: number, deltaY: number): number {
  if (deltaY === 0) return clampOpacity(current);
  return clampOpacity(current + (deltaY < 0 ? OPACITY_STEP : -OPACITY_STEP));
}
