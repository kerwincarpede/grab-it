import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `QuickItem` in src-tauri/src/quick.rs. */
export type QuickItem =
  | { kind: "capture"; path: string; fileName: string; width: number; height: number; copied: boolean }
  | { kind: "text"; text: string }
  | { kind: "colour"; hex: string; rgb: string }
  | { kind: "working"; message: string }
  | { kind: "notice"; title: string; message: string }
  | { kind: "error"; message: string }
  | { kind: "recording"; startedAt: number; maxSeconds: number }
  | { kind: "recorded"; path: string; fileName: string; durationMs: number; bytes: number };

/** Mirrors `QuickAction` in src-tauri/src/quick.rs. */
export type QuickAction = "copy" | "edit" | "pin" | "reveal" | "delete" | "close";

/** Mirrors `QUICK_CHANGED_EVENT` in src-tauri/src/quick.rs. */
export const QUICK_CHANGED_EVENT = "quick-changed";

/** What the card should show; null when it was opened with nothing. */
export function quickInfo(): Promise<QuickItem | null> {
  return invoke<QuickItem | null>("quick_info");
}

/** The capture on the card as a small PNG. */
export function quickThumbnail(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("quick_thumbnail");
}

export function quickAction(action: QuickAction): Promise<void> {
  return invoke<void>("quick_action", { action });
}

/** Ends the recording under way; the card then shows the saved GIF. */
export function recordStop(): Promise<void> {
  return invoke<void>("record_stop");
}

/** Calls `handler` when the card is reused for something new. */
export function onQuickChanged(handler: (item: QuickItem) => void): Promise<UnlistenFn> {
  return listen<QuickItem>(QUICK_CHANGED_EVENT, (event) => handler(event.payload));
}

/**
 * How long each kind of card stays before it dismisses itself, in ms.
 * `null` stays until something replaces it.
 */
export function dismissAfter(item: QuickItem): number | null {
  switch (item.kind) {
    case "capture":
      return 8000;
    case "recorded":
      return 12000;
    case "working":
    case "recording":
      return null;
    case "error":
      return 10000;
    default:
      return 5000;
  }
}

/** Elapsed time as `m:ss`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A file size as people read it: `840 KB`, `1.3 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "12 lines, 340 characters" for a text capture. */
export function describeText(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0).length;
  const characters = text.length;
  return `${lines} ${lines === 1 ? "line" : "lines"}, ${characters} ${characters === 1 ? "character" : "characters"}`;
}
