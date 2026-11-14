import type { Backdrop } from "../editor/model";
import { parseBackdrop } from "../editor/sidecar";

/** The stretch of the recording kept, in milliseconds from its start. */
export interface Trim {
  startMs: number;
  endMs: number;
}

/**
 * The sidecar document, `<recording>.edits.json`. Everything in it is
 * non-destructive: the recording is never changed, and the edits are only
 * rendered on export. Absent fields mean unchanged.
 */
export interface RecordingEdits {
  version: 1;
  /** Absent or null keeps the whole recording. */
  trim?: Trim | null;
  /** The same backdrop captures have; its aspect is the export's shape. */
  backdrop?: Backdrop | null;
}

/** The shortest a trimmed recording may be. */
export const MIN_CLIP_MS = 500;

export class EditsError extends Error {}

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function emptyEdits(): RecordingEdits {
  return { version: 1 };
}

/**
 * Reads a sidecar. `null` or `undefined` (no sidecar yet) gives no edits.
 * An unknown version throws, so it is never overwritten; a trim or backdrop
 * that is not understood is dropped on its own.
 */
export function parseEdits(value: unknown): RecordingEdits {
  if (value === null || value === undefined) return emptyEdits();
  if (typeof value !== "object") throw new EditsError("the edits are not an object");
  const doc = value as Record<string, unknown>;
  if (doc.version !== 1) throw new EditsError(`unsupported edits version ${String(doc.version)}`);
  const edits = emptyEdits();
  const trim = doc.trim as Record<string, unknown> | null | undefined;
  if (trim && typeof trim === "object" && isNum(trim.startMs) && isNum(trim.endMs) && trim.startMs >= 0 && trim.endMs > trim.startMs) {
    edits.trim = { startMs: Math.round(trim.startMs), endMs: Math.round(trim.endMs) };
  }
  const backdrop = parseBackdrop(doc.backdrop);
  if (backdrop) edits.backdrop = backdrop;
  return edits;
}

/** The JSON written to the sidecar: only what is set. */
export function serializeEdits(edits: RecordingEdits): RecordingEdits {
  return {
    version: 1,
    ...(edits.trim ? { trim: { startMs: Math.round(edits.trim.startMs), endMs: Math.round(edits.trim.endMs) } } : {}),
    ...(edits.backdrop ? { backdrop: edits.backdrop } : {}),
  };
}

/**
 * `trim` kept inside a recording `durationMs` long and at least
 * `MIN_CLIP_MS` (or the whole recording, when shorter). The end gives way
 * before the start does.
 */
export function clampTrim(trim: Trim, durationMs: number): Trim {
  const duration = Math.max(0, Math.round(durationMs));
  const shortest = Math.min(MIN_CLIP_MS, duration);
  const startMs = Math.round(Math.min(Math.max(0, trim.startMs), duration - shortest));
  const endMs = Math.round(Math.min(duration, Math.max(trim.endMs, startMs + shortest)));
  return { startMs, endMs };
}

/** The stretch to play and export: the sidecar's trim fitted to the recording, else all of it. */
export function trimOf(edits: RecordingEdits, durationMs: number): Trim {
  return clampTrim(edits.trim ?? { startMs: 0, endMs: durationMs }, durationMs);
}

/** True when `trim` keeps the whole recording, so the sidecar need not hold it. */
export function isWhole(trim: Trim, durationMs: number): boolean {
  return trim.startMs <= 0 && trim.endMs >= Math.round(durationMs);
}

/** A time as the timeline shows it: `m:ss.t`. */
export function formatTime(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const seconds = Math.floor(tenths / 10);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${tenths % 10}`;
}
