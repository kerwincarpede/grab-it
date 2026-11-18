import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { OcrLine } from "../library/api";
import type { Annotations } from "./model";

/** Mirrors `EditorInfo` in src-tauri/src/editor.rs. */
export interface EditorInfo {
  path: string;
  fileName: string;
  annotations: unknown;
  /** The capture's pixels per point, when its meta.json records it. */
  scaleFactor?: number | null;
  /** The mouse pointer saved with the capture, when there is one. */
  pointer?: CapturedPointer | null;
}

/** Mirrors `CapturedPointer` in src-tauri/src/pointer.rs. */
export interface CapturedPointer {
  /** The hot spot, in the capture's pixels. */
  x: number;
  y: number;
  /** The hot spot within the pointer image. */
  hotX: number;
  hotY: number;
  width: number;
  height: number;
  /** The pointer image as base64 PNG. */
  image: string;
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

/**
 * Copies an image file dropped on the editor into the capture's assets
 * folder. Resolves to the copy's file name, the new image shape's `src`.
 */
export function addImageFile(path: string): Promise<string> {
  return invoke<string>("editor_add_image_file", { path });
}

/** Saves the clipboard's image into the capture's assets folder; resolves to its file name. */
export function addClipboardImage(): Promise<string> {
  return invoke<string>("editor_add_clipboard_image");
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
  return invoke<string>("save_backdrop_preset_image", { path });
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

/** A box in the capture's pixels. Mirrors `Rect` in src-tauri/src/capture.rs. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The capture's lines of text with their word boxes, in capture pixels:
 * the library's stored ones, else read now. Nothing leaves the computer.
 */
export function editorWords(): Promise<OcrLine[]> {
  return invoke<OcrLine[]>("editor_words");
}

/** The faces found in the capture, in capture pixels. */
export function editorFaces(): Promise<PixelRect[]> {
  return invoke<PixelRect[]>("editor_faces");
}
