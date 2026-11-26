import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type AudioKind, type RecordingClipSource_Serialize, type RecordingInfo_Serialize, type RecordingPauses_Serialize, type TranscribeModel, type Value } from "../app/bindings";
import { chooseExportFile } from "../app/exportDialog";
import type { SubtitleCue, Transcript } from "./captions";
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
  /** Its recording's reference within the recordings folder. */
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
  /**
   * Whether background noise is removed from the microphone of every clip
   * whose recording keeps it apart (`separateMicrophone`); other clips keep
   * the sound they were recorded with.
   */
  removeNoise: boolean;
  /**
   * Images laid over the finished frames for a stretch of the output, such
   * as captions; their PNGs follow the mask in the body. Absent means none.
   */
  overlays?: ExportOverlay[];
}

/**
 * An image laid over every output frame from `startMs` until `endMs`, in the
 * exported sequence's time, with its top-left corner at `x`, `y` in output
 * pixels. Mirrors `ExportOverlay` in src-tauri/src/recording_editor.rs.
 */
export interface ExportOverlay {
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** How many bytes of the body its PNG takes; `exportRecording` fills it in. */
  bytes: number;
}

/** An overlay to export: where and when it shows, and its PNG, `width` × `height`. */
export interface ExportOverlayImage extends Omit<ExportOverlay, "bytes"> {
  png: Uint8Array;
}

/** Mirrors `ExportProgress` in src-tauri/src/recording_editor.rs: frames written so far. */
export interface ExportProgress {
  done: number;
  total: number;
}

export function recordingInfo(): Promise<RecordingInfo> {
  return commands.recordingInfo() as Promise<RecordingInfo>;
}

/** A recordings-folder MP4 by its flat or month-qualified reference. */
export function recordingSource(fileName: string): Promise<RecordingSource> {
  return commands.recordingSource(fileName) as Promise<RecordingSource>;
}

/** An MP4 picked from this recording editor's recordings folder. */
export function recordingPickSource(path: string): Promise<RecordingSource> {
  return commands.recordingPickSource(path) as Promise<RecordingSource>;
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
 * (none without a backdrop) and `overlays` laid over the frames. Resolves to
 * the new file's path once it is written; Grab-it shows it in Quick Access too.
 */
export function exportRecording(
  plan: ExportPlan,
  layers: { backdrop: Uint8Array; mask: Uint8Array } | null,
  overlays: readonly ExportOverlayImage[] = [],
): Promise<string> {
  const parts = [...(layers ? [layers.backdrop, layers.mask] : []), ...overlays.map((overlay) => overlay.png)];
  const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  const sent: ExportPlan = { ...plan, backdropBytes: layers?.backdrop.length ?? 0 };
  if (overlays.length > 0) {
    sent.overlays = overlays.map(({ png, ...overlay }) => ({ ...overlay, bytes: png.length }));
  }
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

/**
 * The pauses in a recording's sound, for Suggest edits: `RecordingPauses`
 * in src-tauri/src/recording_suggest.rs, its pointer as recorded narrowed
 * as in `RecordingInfo`.
 */
export type RecordingPauses = Omit<RecordingPauses_Serialize, "pointer"> & { pointer: CursorPath | null };

/** The stretches of recordings-folder recording `fileName` quieter than `noiseDb` dBFS (-60 to -20). */
export function recordingPauses(fileName: string, noiseDb: number): Promise<RecordingPauses> {
  return commands.recordingPauses(fileName, noiseDb) as Promise<RecordingPauses>;
}

/**
 * A stretch of `fileName`'s sound as a WAV: as recorded, or `cleaned` as
 * the export removes background noise. At most 30 seconds.
 */
export async function recordingAudition(fileName: string, startMs: number, endMs: number, cleaned: boolean): Promise<Blob> {
  const bytes = await invoke<ArrayBuffer>("recording_audition", { fileName, startMs: Math.round(startMs), endMs: Math.round(endMs), cleaned });
  return new Blob([bytes], { type: "audio/wav" });
}

/** How many peaks `recordingWaveform` gives for each second of sound. */
export const WAVEFORM_PEAKS_PER_SECOND = 100;

/**
 * The peaks of source `audio` of `fileName`'s sound, in the order its
 * `audio` kinds list them: one byte (0 silent, 255 full scale) for each
 * 10 ms from the start of the recording. Computed once, then cached.
 */
export async function recordingWaveform(fileName: string, audio: number): Promise<Uint8Array> {
  const bytes = await invoke<ArrayBuffer>("recording_waveform", { fileName, audio });
  return new Uint8Array(bytes);
}

/** Mirrors `TRANSCRIBE_PROGRESS_EVENT` in src-tauri/src/transcribe.rs. */
export const TRANSCRIBE_PROGRESS_EVENT = "recording-transcribe-progress";

/**
 * How far transcribing one recording is: the model download in bytes, then
 * its sound in milliseconds. Mirrors `TranscribeProgress` in src-tauri/src/transcribe.rs.
 */
export interface TranscribeProgress {
  /** The recording being transcribed. */
  source: string;
  stage: "download" | "transcribe";
  done: number;
  total: number;
}

export type { TranscribeModel };

/** Whether the speech model is downloaded, and its size in bytes. */
export function transcribeModel(): Promise<TranscribeModel> {
  return commands.recordingTranscribeModel();
}

/**
 * Transcribes recordings-folder recording `source` on this computer and
 * saves `<name>.transcript.json` beside it, downloading the model first
 * when it is not here yet. No sound to hear gives no segments.
 */
export function recordingTranscribe(source: string): Promise<Transcript> {
  return commands.recordingTranscribe(source);
}

/** The saved transcript of `source`, or null when it has none. */
export function recordingTranscript(source: string): Promise<Transcript | null> {
  return commands.recordingTranscript(source);
}

/** Stops transcribing, or the model download, in this window. */
export async function cancelTranscribe(): Promise<void> {
  await commands.recordingTranscribeCancel();
}

/** Calls `handler` as transcribing in this window moves on. */
export function onTranscribeProgress(handler: (progress: TranscribeProgress) => void): Promise<UnlistenFn> {
  return listen<TranscribeProgress>(TRANSCRIBE_PROGRESS_EVENT, (event) => handler(event.payload));
}

/** A subtitle file's default name: the recording's, as SRT. */
export const subtitleFileName = (recordingName: string) => `${recordingName.replace(/\.[^./\\]+$/, "")}.srt`;

/** Asks where to save subtitles, `<name>.srt` by default; null when cancelled. */
export function chooseSubtitlesFile(recordingName: string): Promise<string | null> {
  return chooseExportFile(subtitleFileName(recordingName), {
    title: "Save subtitles",
    filters: [
      { name: "SubRip subtitles", extensions: ["srt"] },
      { name: "WebVTT subtitles", extensions: ["vtt"] },
    ],
  });
}

/** Writes `cues` to `path` as SRT or, for a `.vtt` path, WebVTT. */
export async function saveSubtitles(path: string, cues: SubtitleCue[]): Promise<void> {
  await commands.recordingSaveSubtitles(path, cues);
}
