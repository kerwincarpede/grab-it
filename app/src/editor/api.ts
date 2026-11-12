import { invoke } from "@tauri-apps/api/core";
import type { Annotations } from "./model";

/** Mirrors `EditorInfo` in src-tauri/src/editor.rs. */
export interface EditorInfo {
  path: string;
  fileName: string;
  annotations: unknown;
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

export function saveAnnotations(annotations: Annotations): Promise<void> {
  return invoke<void>("editor_save_annotations", { annotations });
}

/** Copies a flattened PNG to the clipboard. */
export function copyImage(png: Uint8Array): Promise<void> {
  return invoke<void>("editor_copy", png);
}

/** Writes a flattened PNG or JPEG to `path`. */
export function exportImage(path: string, bytes: Uint8Array): Promise<void> {
  return invoke<void>("editor_export", bytes, {
    headers: { [EXPORT_PATH_HEADER]: encodeURIComponent(path) },
  });
}
