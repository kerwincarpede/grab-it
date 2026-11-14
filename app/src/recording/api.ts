import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RecordingEdits } from "./edits";

/** Mirrors `RecordingInfo` in src-tauri/src/recording_editor.rs. */
export interface RecordingInfo {
  path: string;
  fileName: string;
  /** The saved `<recording>.edits.json`, or null when there is none yet. */
  edits: unknown;
  /** The frame rate it was recorded at. */
  fps: number;
}

/** Mirrors `VIDEO_SCHEME` in src-tauri/src/recording_editor.rs. */
export const VIDEO_SCHEME = "grab-it-video";
/** Mirrors `EXPORT_PLAN_HEADER` in src-tauri/src/recording_editor.rs. */
export const EXPORT_PLAN_HEADER = "x-recording-export";
/** Mirrors `EXPORT_PROGRESS_EVENT` in src-tauri/src/recording_editor.rs. */
export const EXPORT_PROGRESS_EVENT = "recording-export-progress";

/**
 * What an export makes. Mirrors `ExportPlan` in
 * src-tauri/src/recording_editor.rs; sizes are in output pixels.
 */
export interface ExportPlan {
  startMs: number;
  endMs: number;
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
  return invoke<RecordingInfo>("recording_info");
}

/** Where the page plays `path` from: the recordings folder, served by `grab-it-video`. */
export function videoSrc(path: string): string {
  return convertFileSrc(path, VIDEO_SCHEME);
}

export function saveEdits(edits: RecordingEdits): Promise<void> {
  return invoke<void>("recording_save_edits", { edits });
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

/** Calls `handler` as an export in this window writes its frames. */
export function onExportProgress(handler: (progress: ExportProgress) => void): Promise<UnlistenFn> {
  return listen<ExportProgress>(EXPORT_PROGRESS_EVENT, (event) => handler(event.payload));
}
