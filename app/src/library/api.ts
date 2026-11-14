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
  /** What the AI describer saw in the image; null until it has described it. */
  aiDescription: string | null;
  /** One of {@link AI_CATEGORIES}; null until described. */
  aiCategory: string | null;
  /** Tags the AI describer suggested, kept apart from the user's own. */
  aiTags: string[];
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

/** Copies the shot's original image to the clipboard. */
export function copyShot(id: number): Promise<void> {
  return invoke<void>("library_copy", { id });
}

/** Floats the shot above other windows. */
export function pinShot(id: number): Promise<void> {
  return invoke<void>("library_pin", { id });
}

/** Shows the shot's file in the system file manager. */
export function revealShot(id: number): Promise<void> {
  return invoke<void>("library_reveal", { id });
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

/** Mirrors `MatchField` in src-tauri/src/search.rs. */
export type MatchField = "text" | "tags" | "notes" | "app" | "windowTitle" | "description";

/** How each field a search can match is named in results. */
export const FIELD_LABELS: Record<MatchField, string> = {
  text: "Text in image",
  tags: "Tags",
  notes: "Notes",
  app: "App",
  windowTitle: "Window",
  description: "Description",
};

/** Mirrors `SnippetPart` in src-tauri/src/search.rs. */
export interface SnippetPart {
  text: string;
  /** This part matched the search. */
  hit: boolean;
}

/** Mirrors `SearchHit` in src-tauri/src/search.rs. */
export interface SearchHit {
  shot: Shot;
  /** The first field the words were found in; null without words. */
  field: MatchField | null;
  /** Text around the match in that field; empty without words. */
  snippet: SnippetPart[];
}

/** Mirrors `SearchPage` in src-tauri/src/search.rs. */
export interface SearchPage {
  hits: SearchHit[];
  offset: number;
  /** Every shot that matches. */
  total: number;
}

/** Mirrors `SearchQuery` in src-tauri/src/search.rs. */
export interface SearchQuery {
  /** Words to find, each as a prefix; all must match. */
  text: string;
  /** Captured at or after, in ms since the Unix epoch. */
  from: number | null;
  /** Captured before, in ms since the Unix epoch. */
  to: number | null;
  app: string | null;
  /** Matches the user's tags and the AI's. */
  tag: string | null;
  /** An AI category, matched exactly; left out for any. */
  category?: string;
}

/** Mirrors `FilterOptions` in src-tauri/src/search.rs. */
export interface FilterOptions {
  apps: string[];
  tags: string[];
  /** AI categories some capture has. */
  categories: string[];
}

/** The filter bar as the user set it; "" means any. Dates are `YYYY-MM-DD`. */
export interface Filters {
  app: string;
  tag: string;
  category: string;
  fromDate: string;
  toDate: string;
}

export const NO_FILTERS: Filters = { app: "", tag: "", category: "", fromDate: "", toDate: "" };

/** How long typing must pause before the Library searches. */
export const SEARCH_DEBOUNCE_MS = 250;

/** Local midnight at the start of a `YYYY-MM-DD` day, in ms; null if invalid. */
export function dayStart(date: string, daysLater = 0): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + daysLater);
  const ms = day.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** The query for typed words and filters. The "to" day is included. */
export function buildQuery(text: string, filters: Filters): SearchQuery {
  return {
    text: text.trim(),
    from: dayStart(filters.fromDate),
    to: dayStart(filters.toDate, 1),
    app: filters.app || null,
    tag: filters.tag || null,
    ...(filters.category ? { category: filters.category } : {}),
  };
}

/** Whether the query narrows the Library at all. */
export function isSearching(query: SearchQuery): boolean {
  return (
    query.text.length > 0 ||
    query.from !== null ||
    query.to !== null ||
    query.app !== null ||
    query.tag !== null ||
    !!query.category
  );
}

/** Shots matching the query: best matches first with words, else newest first. */
export function searchShots(query: SearchQuery, offset: number, limit: number): Promise<SearchPage> {
  return invoke<SearchPage>("library_search", { query, offset, limit });
}

/** Every app, tag and AI category in the library, for the filter bar. */
export function filterOptions(): Promise<FilterOptions> {
  return invoke<FilterOptions>("library_filter_options");
}

/** Mirrors `OcrStatus` in src-tauri/src/ocr.rs. */
export type OcrStatus =
  | { state: "idle" }
  | { state: "downloading"; downloaded: number; total: number }
  | { state: "working"; pending: number }
  | { state: "failed"; message: string };

/** Mirrors `OCR_STATUS_EVENT` in src-tauri/src/ocr.rs. */
export const OCR_STATUS_EVENT = "ocr-status";

export function ocrStatus(): Promise<OcrStatus> {
  return invoke<OcrStatus>("ocr_status");
}

/** Retries a failed model download. */
export function retryOcr(): Promise<void> {
  return invoke<void>("ocr_retry");
}

/** Calls `handler` whenever the OCR queue changes state. */
export function onOcrStatus(handler: (status: OcrStatus) => void): Promise<UnlistenFn> {
  return listen<OcrStatus>(OCR_STATUS_EVENT, (event) => handler(event.payload));
}

/** The categories the AI describer sorts captures into, with how the Library names them. */
export const AI_CATEGORIES: Record<string, string> = {
  code: "Code",
  terminal: "Terminal",
  browser: "Browser / web page",
  chat: "Chat",
  document: "Document",
  design: "Design",
  error: "Error / dialog",
  receipt: "Receipt",
  photo: "Photo",
  other: "Other",
};

/** A category's friendly name; an unknown one is shown capitalised. */
export function categoryLabel(category: string): string {
  return AI_CATEGORIES[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

/** Mirrors `AiStatus` in src-tauri: the AI describer's queue. */
export interface AiStatus {
  /** "off" when AI descriptions are turned off in Settings. */
  state: "off" | "idle" | "working" | "error";
  /** Captures described so far in this run. */
  done: number;
  /** Captures in this run. */
  total: number;
  error: string | null;
}

/** Mirrors the AI status event in src-tauri. */
export const AI_STATUS_EVENT = "ai-status";

export function aiStatus(): Promise<AiStatus> {
  return invoke<AiStatus>("ai_status");
}

/** Queues the shot to be described again; the result arrives as a library change. */
export function redescribeShot(id: number): Promise<void> {
  return invoke<void>("ai_redescribe", { id });
}

/** Forgets the shot's AI description, category and tags. */
export function clearAiDescription(id: number): Promise<void> {
  return invoke<void>("ai_clear", { id });
}

/** Calls `handler` whenever the AI describer's queue changes. */
export function onAiStatus(handler: (status: AiStatus) => void): Promise<UnlistenFn> {
  return listen<AiStatus>(AI_STATUS_EVENT, (event) => handler(event.payload));
}

/** Opens the Settings window. */
export function openSettings(): Promise<void> {
  return invoke<void>("open_target", { target: "settings" });
}
