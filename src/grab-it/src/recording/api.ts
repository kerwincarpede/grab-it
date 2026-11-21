import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type AudioKind, type RecordingClipSource_Serialize, type RecordingInfo_Serialize, type Value } from "../app/bindings";
import type { SidecarEdits } from "./edits";
import type { CursorPath, Zoom } from "./zooms";

/**
 * The recording the editor opened, from `RecordingInfo` in
 * src-tauri/src/recording_editor.rs. Its pointer path is narrowed to finite
 * points: specta types every `f64` as `number | null` for NaN, which the
 * smoothed path never holds.
 */
export type RecordingInfo = Omit<RecordingInfo_Serialize, "cursor"> & { cursor: CursorPath | null };

/**
 * What one source of a recording's sound is: `mixed` is the microphone and
 * system sound in one track. From `AudioKind` in src-tauri/src/recording_editor.rs.
 */
export type { AudioKind };

/**
 * A recording a clip plays, from `RecordingClipSource` in
 * src-tauri/src/recording_editor.rs, its pointer path narrowed as in `RecordingInfo`.
 */
export type RecordingSource = Omit<RecordingClipSource_Serialize, "cursor"> & { cursor: CursorPath | null };

/** Mirrors `VIDEO_SCHEME` in src-tauri/src/recording_editor.rs. */
export const VIDEO_SCHEME = "grab-it-video";
/** Mirrors `EXPORT_PLAN_HEADER` in src-tauri/src/recording_editor.rs. */
export const EXPORT_PLAN_HEADER = "x-recording-export";
/** Mirrors `EXPORT_PROGRESS_EVENT` in src-tauri/src/recording_editor.rs. */
export const EXPORT_PROGRESS_EVENT = "recording-export-progress";

/**
 * One clip of an export. Mirrors `ExportClip` in
 * src-tauri/src/recording_editor.rs.
 */
export interface ExportClip {
  /** Its recording's file name in the recordings folder. */
  source: string;
  /** The stretch kept, in its recording's time. */
  startMs: number;
  endMs: number;
  /** Its recording's own size, which frames are cut from. */
  sourceWidth: number;
  sourceHeight: number;
  /** Where it sits inside the video box (see `fitInside`), black around it. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Its zooms, in its recording's time. */
  zooms: Zoom[];
}

/**
 * A stretch with no clip: the backdrop with a black video box, and
 * silence. Mirrors `ExportGap` in src-tauri/src/recording_editor.rs.
 */
export interface ExportGap {
  gapMs: number;
}

/** One entry of an export's sequence. Mirrors `ExportEntry` in src-tauri/src/recording_editor.rs. */
export type ExportEntry = ExportClip | ExportGap;

/** Whether `entry` is a gap. */
export const isExportGap = (entry: ExportEntry): entry is ExportGap => "gapMs" in entry;

/**
 * What an export makes. Mirrors `ExportPlan` in
 * src-tauri/src/recording_editor.rs; sizes are in output pixels.
 */
export interface ExportPlan {
  /** The sequence, in order, at the opened recording's frame rate: clips and gaps. */
  clips: ExportEntry[];
  /** The output's size, even both ways. */
  width: number;
  height: number;
  /** Where the video's top-left corner goes, and the size it takes there. */
  x: number;
  y: number;
  videoWidth: number;
  videoHeight: number;
  /** How many bytes of the body are the backdrop PNG; the rest is the mask. 0 without a backdrop. */
  backdropBytes: number;
}

/** Mirrors `ExportProgress` in src-tauri/src/recording_editor.rs: frames written so far. */
export interface ExportProgress {
  done: number;
  total: number;
}

export function recordingInfo(): Promise<RecordingInfo> {
  return commands.recordingInfo() as Promise<RecordingInfo>;
}

/** A recordings-folder MP4 by file name; refused for anything else or a file that is gone. */
export function recordingSource(fileName: string): Promise<RecordingSource> {
  return commands.recordingSource(fileName) as Promise<RecordingSource>;
}

/** Where the page plays `path` from: the recordings folder, served by `grab-it-video`. */
export function videoSrc(path: string): string {
  return convertFileSrc(path, VIDEO_SCHEME);
}

/**
 * Whether the page runs in WebKitGTK, whose media player only loads http,
 * https and blob URLs: there the recording is fetched and played from a
 * blob (see `fetchRecording`).
 */
export function playsFromBlob(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /\bLinux\b/.test(userAgent) && !/\bAndroid\b/.test(userAgent);
}

/** `bytes <from>-<to>/<total>` from a Content-Range header. */
function contentRange(header: string | null): { from: number; to: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? "");
  return match ? { from: Number(match[1]), to: Number(match[2]), total: Number(match[3]) } : null;
}

/**
 * The whole recording at `url`, as a video/mp4 blob. The scheme answers at
 * most a few megabytes a request, so it is fetched a range at a time until
 * Content-Range's total is reached.
 */
export async function fetchRecording(url: string, fetcher: typeof fetch = fetch): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  let from = 0;
  for (;;) {
    const response = await fetcher(url, { headers: { Range: `bytes=${from}-` } });
    if (response.status === 200 && from === 0) return new Blob([await response.arrayBuffer()], { type: "video/mp4" });
    if (response.status !== 206) throw new Error(`could not read the recording (${response.status})`);
    const range = contentRange(response.headers.get("Content-Range"));
    if (!range || range.from !== from || range.to < from) throw new Error("the recording came back in the wrong pieces");
    parts.push(await response.arrayBuffer());
    from = range.to + 1;
    if (from >= range.total) return new Blob(parts, { type: "video/mp4" });
  }
}

export async function saveEdits(edits: SidecarEdits): Promise<void> {
  // The sidecar is free-form JSON to Rust (`serde_json::Value`).
  await commands.recordingSaveEdits(edits as unknown as Value);
}

/**
 * Exports the recording as `plan` says, with the backdrop and mask PNGs
 * (none without a backdrop). Resolves to the new file's path once it is
 * written; Grab-it shows it in Quick Access too.
 */
export function exportRecording(plan: ExportPlan, layers: { backdrop: Uint8Array; mask: Uint8Array } | null): Promise<string> {
  const body = new Uint8Array((layers?.backdrop.length ?? 0) + (layers?.mask.length ?? 0));
  if (layers) {
    body.set(layers.backdrop, 0);
    body.set(layers.mask, layers.backdrop.length);
  }
  const sent: ExportPlan = { ...plan, backdropBytes: layers?.backdrop.length ?? 0 };
  return invoke<string>("recording_export", body, {
    headers: { [EXPORT_PLAN_HEADER]: encodeURIComponent(JSON.stringify(sent)) },
  });
}

/** Stops the active export in this recording editor. */
export async function cancelExport(): Promise<void> {
  await commands.recordingExportCancel();
}

/** Calls `handler` as an export in this window writes its frames. */
export function onExportProgress(handler: (progress: ExportProgress) => void): Promise<UnlistenFn> {
  return listen<ExportProgress>(EXPORT_PROGRESS_EVENT, (event) => handler(event.payload));
}
