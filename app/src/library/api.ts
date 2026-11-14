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
export type MatchField = "text" | "tags" | "notes" | "app" | "windowTitle";

/** How each field a search can match is named in results. */
export const FIELD_LABELS: Record<MatchField, string> = {
  text: "Text in image",
  tags: "Tags",
  notes: "Notes",
  app: "App",
  windowTitle: "Window",
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
  tag: string | null;
}

/** Mirrors `FilterOptions` in src-tauri/src/search.rs. */
export interface FilterOptions {
  apps: string[];
  tags: string[];
}

/** The filter bar as the user set it; "" means any. Dates are `YYYY-MM-DD`. */
export interface Filters {
  app: string;
  tag: string;
  fromDate: string;
  toDate: string;
}

export const NO_FILTERS: Filters = { app: "", tag: "", fromDate: "", toDate: "" };

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
  };
}

/** Whether the query narrows the Library at all. */
export function isSearching(query: SearchQuery): boolean {
  return (
    query.text.length > 0 || query.from !== null || query.to !== null || query.app !== null || query.tag !== null
  );
}

/** Shots matching the query: best matches first with words, else newest first. */
export function searchShots(query: SearchQuery, offset: number, limit: number): Promise<SearchPage> {
  return invoke<SearchPage>("library_search", { query, offset, limit });
}

/** Every app and tag in the library, for the filter bar. */
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

/** A capture's time of day, e.g. "5:36 AM". */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Local midnight at the start of the day `ms` falls on. */
export function startOfDay(ms: number): number {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

/** The local `YYYY-MM-DD` of `ms`, as date inputs and filters use it. */
export function isoDay(ms: number): string {
  const day = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** Whole local days between two day starts (DST-safe). */
function daysBetween(earlier: number, later: number): number {
  return Math.round((later - earlier) / 86_400_000);
}

/** A day's heading and its full date beneath it, relative to `now`. */
export function dayLabel(dayMs: number, now = Date.now()): { title: string; subtitle: string | null } {
  const ago = daysBetween(dayMs, startOfDay(now));
  const date = new Date(dayMs);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const full = date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  if (ago === 0) return { title: "Today", subtitle: full };
  if (ago === 1) return { title: "Yesterday", subtitle: full };
  if (ago > 1 && ago < 7) {
    const monthDay = date.toLocaleDateString(undefined, { month: "long", day: "numeric" });
    return { title: date.toLocaleDateString(undefined, { weekday: "long" }), subtitle: monthDay };
  }
  return { title: full, subtitle: null };
}

export interface DayGroup<T> {
  /** Local midnight of the day. */
  day: number;
  items: T[];
}

/** Splits newest-first shots into runs captured on the same local day. */
export function groupByDay<T extends { capturedAt: number }>(items: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const day = startOfDay(item.capturedAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

export interface DatePreset {
  id: string;
  label: string;
  /** `fromDate`/`toDate` for the preset, relative to `now`. */
  range: (now: number) => { fromDate: string; toDate: string };
}

const daysAgo = (now: number, days: number) => isoDay(new Date(startOfDay(now)).setDate(new Date(now).getDate() - days));

export const DATE_PRESETS: DatePreset[] = [
  { id: "today", label: "Today", range: (now) => ({ fromDate: isoDay(now), toDate: isoDay(now) }) },
  { id: "week", label: "Past 7 days", range: (now) => ({ fromDate: daysAgo(now, 6), toDate: isoDay(now) }) },
  { id: "month", label: "Past 30 days", range: (now) => ({ fromDate: daysAgo(now, 29), toDate: isoDay(now) }) },
  {
    id: "year",
    label: "This year",
    range: (now) => ({ fromDate: `${new Date(now).getFullYear()}-01-01`, toDate: isoDay(now) }),
  },
];

/** How the date filter reads on its chip, e.g. "Past 7 days" or "Mar 1 – Mar 5". */
export function dateFilterLabel(fromDate: string, toDate: string, now = Date.now()): string | null {
  if (!fromDate && !toDate) return null;
  const preset = DATE_PRESETS.find((item) => {
    const range = item.range(now);
    return range.fromDate === fromDate && range.toDate === toDate;
  });
  if (preset) return preset.label;
  const short = (date: string) => {
    const ms = dayStart(date);
    return ms === null ? date : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  if (fromDate && toDate) return fromDate === toDate ? short(fromDate) : `${short(fromDate)} – ${short(toDate)}`;
  return fromDate ? `Since ${short(fromDate)}` : `Until ${short(toDate)}`;
}
