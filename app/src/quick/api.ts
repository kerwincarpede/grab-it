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

/**
 * What is on the card, numbered so an action can say which card it was
 * clicked on. Mirrors `Shown` in src-tauri/src/quick.rs.
 */
export interface QuickShown {
  /** Different for every item the card has shown. */
  generation: number;
  item: QuickItem;
  /** How long it stays, in seconds, as Settings has it; 0 keeps it until closed. */
  seconds?: number;
}

/** Mirrors `QuickAction` in src-tauri/src/quick.rs. */
export type QuickAction = "copy" | "edit" | "pin" | "reveal" | "delete" | "close";

/** Mirrors `QUICK_CHANGED_EVENT` in src-tauri/src/quick.rs. */
export const QUICK_CHANGED_EVENT = "quick-changed";

/** What the card should show; null when it was opened with nothing. */
export function quickInfo(): Promise<QuickShown | null> {
  return invoke<QuickShown | null>("quick_info");
}

/** The capture on the card as a small PNG. */
export function quickThumbnail(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("quick_thumbnail");
}

/**
 * Runs a button of the card that showed item `generation`. The backend
 * drops the action when the card has since moved on to a newer item.
 */
export function quickAction(action: QuickAction, generation: number): Promise<void> {
  return invoke<void>("quick_action", { action, generation });
}

/** Ends the recording under way; the card then shows the saved GIF. */
export function recordStop(): Promise<void> {
  return invoke<void>("record_stop");
}

/** Calls `handler` when the card is reused for something new. */
export function onQuickChanged(handler: (shown: QuickShown) => void): Promise<UnlistenFn> {
  return listen<QuickShown>(QUICK_CHANGED_EVENT, (event) => handler(event.payload));
}

/**
 * How long a card stays before it dismisses itself, in ms, given the
 * seconds chosen in Settings. `null` stays until something replaces it.
 */
export function dismissAfter(item: QuickItem, seconds = 8): number | null {
  if (item.kind === "working" || item.kind === "recording") return null;
  // 0 is the user's "until I close it".
  if (seconds <= 0) return null;
  // What needs reading gets a little longer, whatever the setting.
  if (item.kind === "error") return Math.max(seconds, 10) * 1000;
  if (item.kind === "recorded") return Math.max(seconds, 12) * 1000;
  return seconds * 1000;
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
