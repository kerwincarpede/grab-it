import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type Code, type QuickAction, type QuickItem_Serialize, type Shown_Serialize, type TextTidy_Serialize } from "../app/bindings";

/** What tidied text is laid out as. Mirrors `FORMATS` in src-tauri/src/tidy.rs. */
export const TEXT_FORMATS = ["plain", "json", "yaml", "xml", "sql", "code", "table"] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

/**
 * How tidying a text capture with AI is going; `by` is who tidies it.
 * Generated from `TextTidy` in src-tauri/src/quick.rs.
 */
export type TextTidy = TextTidy_Serialize;

/** A QR code or barcode read from the screen, generated from `Code` in src-tauri/src/codes.rs. */
export type QuickCode = Code;

/** What the card shows, generated from `QuickItem` in src-tauri/src/quick.rs. */
export type QuickItem = QuickItem_Serialize;

/**
 * What is on the card, numbered so an action can say which card it was
 * clicked on. Generated from `Shown` in src-tauri/src/quick.rs.
 */
export type QuickShown = Shown_Serialize;

/** A button on the card, generated from `QuickAction` in src-tauri/src/quick.rs. */
export type { QuickAction };

/** Mirrors `QUICK_CHANGED_EVENT` in src-tauri/src/quick.rs. */
export const QUICK_CHANGED_EVENT = "quick-changed";

/** What the card should show; null when it was opened with nothing. */
export function quickInfo(): Promise<QuickShown | null> {
  return commands.quickInfo();
}

/** The capture on the card as a small PNG, or a frame of the recording on it. */
export function quickThumbnail(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("quick_thumbnail");
}

/**
 * Runs a button of the card that showed item `generation`. The backend
 * drops the action when the card has since moved on to a newer item.
 */
export async function quickAction(action: QuickAction, generation: number): Promise<void> {
  await commands.quickAction(action, generation);
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
  if (item.kind === "working") return null;
  // The AI's text is on its way.
  if (item.kind === "text" && item.tidy?.state === "working") return null;
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

/** "QR code copied", or "3 codes copied" when an area held several. */
export function describeCodes(codes: QuickCode[]): string {
  return codes.length === 1 ? `${codes[0].format} copied` : `${codes.length} codes copied`;
}

/** The formats found, each once, for the card: "QR code · Code 128". */
export function codeFormats(codes: QuickCode[]): string {
  return [...new Set(codes.map((code) => code.format))].join(" · ");
}

/** The link Open link opens: the first code that holds one. */
export function firstLink(codes: QuickCode[]): string | null {
  return codes.find((code) => code.isLink)?.value.trim() ?? null;
}

const FORMAT_NAMES: Record<string, string> = {
  json: "JSON",
  yaml: "YAML",
  xml: "XML",
  sql: "SQL",
  table: "Table",
  code: "Code",
};

/** Proper names for languages that do not just take a capital. */
const LANGUAGE_NAMES: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  csharp: "C#",
  cpp: "C++",
  "c++": "C++",
  css: "CSS",
  html: "HTML",
  php: "PHP",
  sql: "SQL",
  json: "JSON",
  yaml: "YAML",
  toml: "TOML",
  graphql: "GraphQL",
};

/** What tidied text was laid out as, for the card: "JSON", "Python", or null for plain text. */
export function formatName(format: string, language: string | null): string | null {
  if (format === "code" && language) {
    return LANGUAGE_NAMES[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
  }
  return FORMAT_NAMES[format] ?? null;
}

/** Whether text in `format` reads best in a monospace font. */
export function isStructured(format: string | undefined): boolean {
  return format !== undefined && format !== "plain";
}

/** Waits for native drag completion (drop or cancel). */
export async function quickDrag(generation: number): Promise<void> {
  await commands.quickDrag(generation);
}
