import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Annotations } from "./model";

/** Mirrors `EditorInfo` in src-tauri/src/editor.rs. */
export interface EditorInfo {
  path: string;
  fileName: string;
  annotations: unknown;
  /** The capture's pixels per point, when its meta.json records it. */
  scaleFactor?: number | null;
}

/** Mirrors `EXPORT_PATH_HEADER` in src-tauri/src/editor.rs. */
export const EXPORT_PATH_HEADER = "x-export-path";

export function editorInfo(): Promise<EditorInfo> {
  return invoke<EditorInfo>("editor_info");
}

/** The original capture as PNG bytes. */
export function editorImage(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("editor_image");
}

/** The bytes of an image picked as the backdrop fill. */
export function backdropImage(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("editor_backdrop_image", { path });
}

/** Asks for an image to fill the backdrop with. Resolves to null when the user cancels. */
export async function chooseBackdropImage(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    title: "Choose a backdrop image",
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  return typeof picked === "string" ? picked : null;
}

export function saveAnnotations(annotations: Annotations): Promise<void> {
  return invoke<void>("editor_save_annotations", { annotations });
}

/** Copies a flattened PNG to the clipboard. */
export function copyImage(png: Uint8Array): Promise<void> {
  return invoke<void>("editor_copy", png);
}

/** Floats a flattened PNG in an always-on-top window. */
export function pinImage(png: Uint8Array): Promise<void> {
  return invoke<void>("editor_pin", png);
}

/** Writes a flattened PNG or JPEG to `path`. */
export function exportImage(path: string, bytes: Uint8Array): Promise<void> {
  return invoke<void>("editor_export", bytes, {
    headers: { [EXPORT_PATH_HEADER]: encodeURIComponent(path) },
  });
}
