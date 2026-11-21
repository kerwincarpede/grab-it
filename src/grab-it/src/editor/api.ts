import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { commands, type EditorInfo_Serialize, type OcrLine, type Rect, type Value } from "../app/bindings";
import type { Annotations } from "./model";

/** What the editor opens with: `EditorInfo` in src-tauri/src/editor.rs. */
export type EditorInfo = EditorInfo_Serialize;

/** The mouse pointer saved with a capture: `CapturedPointer` in src-tauri/src/pointer.rs. */
export type { CapturedPointer } from "../app/bindings";

/** Mirrors `EXPORT_PATH_HEADER` in src-tauri/src/editor.rs. */
export const EXPORT_PATH_HEADER = "x-export-path";

export function editorInfo(): Promise<EditorInfo> {
  return commands.editorInfo();
}

/** The original capture as PNG bytes. */
export function editorImage(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("editor_image");
}

/** The bytes of an image picked as the backdrop fill. */
export function backdropImage(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("editor_backdrop_image", { path });
}

/**
 * Copies an image file dropped on the editor into the capture's assets
 * folder. Resolves to the copy's file name, the new image shape's `src`.
 */
export function addImageFile(path: string): Promise<string> {
  return commands.editorAddImageFile(path);
}

/** Saves the clipboard's image into the capture's assets folder; resolves to its file name. */
export function addClipboardImage(): Promise<string> {
  return commands.editorAddClipboardImage();
}

/** The bytes of an image added to the capture, by its file name in the assets folder. */
export function assetImage(name: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("editor_asset_image", { name });
}

/**
 * Keeps a preset's own copy of a backdrop image, so the preset still works
 * when the original is moved. Resolves to the copy's path; an image that is
 * already a preset's copy comes back as it is.
 */
export function saveBackdropPresetImage(path: string): Promise<string> {
  return commands.saveBackdropPresetImage(path);
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

export async function saveAnnotations(annotations: Annotations): Promise<void> {
  // Rust keeps the sidecar as JSON (`Value`); `Annotations` is that JSON, typed.
  await commands.editorSaveAnnotations(annotations as unknown as Value);
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

/** A box in the capture's pixels: `Rect` in src-tauri/src/capture.rs. */
export type PixelRect = Rect;

/**
 * The capture's lines of text with their word boxes, in capture pixels:
 * the library's stored ones, else read now. Nothing leaves the computer.
 */
export function editorWords(): Promise<OcrLine[]> {
  return commands.editorWords();
}

/** The faces found in the capture, in capture pixels. */
export function editorFaces(): Promise<PixelRect[]> {
  return commands.editorFaces();
}
