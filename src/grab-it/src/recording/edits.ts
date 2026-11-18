import type { Backdrop } from "../editor/model";
import { parseBackdrop } from "../editor/sidecar";
import { parseClips, type Clip } from "./clips";
import { parseZooms, type Zoom } from "./zooms";

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
  /** 3 when `clips` holds a gap, 2 when `clips` is set, else 1; see `withClips` in ./clips. */
  version: 1 | 2 | 3;
  /** Absent or null keeps the whole recording. Ignored when `clips` is set. */
  trim?: Trim | null;
  /**
   * The joined sequence, in order; absent for one clip of the sidecar's
   * own recording cut by `trim`. Written with version 2, or 3 when it
   * holds a gap (`{id, gapMs}` in the sidecar).
   */
  clips?: Clip[];
  /** The same backdrop captures have; its aspect is the export's shape. */
  backdrop?: Backdrop | null;
  /** Zoom segments, sorted and never overlapping on one source; absent or empty for none. */
  zooms?: Zoom[];
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
 * An unknown version throws, so it is never overwritten; a trim, backdrop
 * or zoom that is not understood is dropped on its own.
 */
export function parseEdits(value: unknown): RecordingEdits {
  if (value === null || value === undefined) return emptyEdits();
  if (typeof value !== "object") throw new EditsError("the edits are not an object");
  const doc = value as Record<string, unknown>;
  if (doc.version !== 1 && doc.version !== 2 && doc.version !== 3) throw new EditsError(`unsupported edits version ${String(doc.version)}`);
  const edits = emptyEdits();
  if (doc.version === 2 || doc.version === 3) {
    const clips = parseClips(doc.clips, doc.version === 3);
    if (clips.length > 0) {
      edits.version = clips.some((clip) => clip.gap) ? 3 : 2;
      edits.clips = clips;
    }
  }
  const trim = doc.trim as Record<string, unknown> | null | undefined;
  if (trim && typeof trim === "object" && isNum(trim.startMs) && isNum(trim.endMs) && trim.startMs >= 0 && trim.endMs > trim.startMs) {
    edits.trim = { startMs: Math.round(trim.startMs), endMs: Math.round(trim.endMs) };
  }
  const backdrop = parseBackdrop(doc.backdrop);
  if (backdrop) edits.backdrop = backdrop;
  const zooms = parseZooms(doc.zooms);
  if (zooms.length > 0) edits.zooms = zooms;
  return edits;
}

/** A gap as the sidecar holds it (version 3). */
export interface SavedGap {
  id: string;
  gapMs: number;
}

/** The sidecar's JSON: `RecordingEdits` with gaps written as `SavedGap`. */
export type SidecarEdits = Omit<RecordingEdits, "clips"> & { clips?: (Clip | SavedGap)[] };

/** The JSON written to the sidecar: only what is set. */
export function serializeEdits(edits: RecordingEdits): SidecarEdits {
  const clips = edits.clips && edits.clips.length > 0 ? edits.clips : null;
  const gaps = clips?.some((clip) => clip.gap) ?? false;
  return {
    version: gaps ? 3 : clips ? 2 : 1,
    ...(clips
      ? {
          clips: clips.map((clip) =>
            clip.gap
              ? { id: clip.id, gapMs: Math.round(clip.endMs - clip.startMs) }
              : { id: clip.id, source: clip.source, startMs: Math.round(clip.startMs), endMs: Math.round(clip.endMs) },
          ),
        }
      : {}),
    ...(!clips && edits.trim ? { trim: { startMs: Math.round(edits.trim.startMs), endMs: Math.round(edits.trim.endMs) } } : {}),
    ...(edits.backdrop ? { backdrop: edits.backdrop } : {}),
    ...(edits.zooms && edits.zooms.length > 0
      ? {
          zooms: edits.zooms.map((zoom) => ({
            id: zoom.id,
            ...(zoom.source ? { source: zoom.source } : {}),
            startMs: Math.round(zoom.startMs),
            endMs: Math.round(zoom.endMs),
            scale: zoom.scale,
            focus: zoom.focus.kind === "area" ? { kind: "area" as const, x: zoom.focus.x, y: zoom.focus.y } : { kind: "cursor" as const },
          })),
        }
      : {}),
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
