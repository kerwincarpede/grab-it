import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `Shot` in src-tauri/src/library.rs. */
export interface Shot {
  id: number;
  path: string;
  fileName: string;
  thumbPath: string;
  /** Milliseconds since the Unix epoch. */
  capturedAt: number;
  mode: string | null;
  app: string | null;
  windowTitle: string | null;
  width: number;
  height: number;
  tags: string[];
  notes: string;
}

/** Mirrors `ShotPage` in src-tauri/src/library.rs. */
export interface ShotPage {
  shots: Shot[];
  offset: number;
  /** Every shot in the library. */
  total: number;
}

/** Mirrors `LIBRARY_CHANGED_EVENT` in src-tauri/src/library.rs. */
export const LIBRARY_CHANGED_EVENT = "library-changed";

/** How many shots the Library loads at a time. */
export const PAGE_SIZE = 60;

/** Shots newest first. */
export function listShots(offset: number, limit: number): Promise<ShotPage> {
  return invoke<ShotPage>("library_list", { offset, limit });
}

/** A shot's thumbnail as PNG bytes. */
export function shotThumbnail(id: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("library_thumbnail", { id });
}

export function setShotTags(id: number, tags: string[]): Promise<Shot> {
  return invoke<Shot>("library_set_tags", { id, tags });
}

export function setShotNotes(id: number, notes: string): Promise<Shot> {
  return invoke<Shot>("library_set_notes", { id, notes });
}

/** Deletes the PNG, its sidecars and its thumbnail. */
export function deleteShot(id: number): Promise<void> {
  return invoke<void>("library_delete", { id });
}

/** Opens the shot in the annotation editor. */
export function openShot(id: number): Promise<void> {
  return invoke<void>("library_open", { id });
}

/** Calls `handler` whenever shots are added, changed or removed. */
export function onLibraryChanged(handler: () => void): Promise<UnlistenFn> {
  return listen(LIBRARY_CHANGED_EVENT, () => handler());
}

/** Splits comma-separated tags as typed by the user. */
export function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function formatCapturedAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
