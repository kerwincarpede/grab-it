import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RecordingFormat } from "../settings/api";

/** Mirrors `RECORD_BAR_EVENT` in src-tauri/src/record_bar.rs. */
export const RECORD_BAR_EVENT = "record-bar-status";

/** Mirrors `Phase` in src-tauri/src/record.rs. */
export type BarPhase = "countdown" | "recording" | "saving";

/** Mirrors `BarStatus` in src-tauri/src/record.rs. Times are ms since the Unix epoch. */
export interface BarStatus {
  phase: BarPhase;
  countdownEndsAt: number | null;
  /** When the first frame was grabbed; null while counting down. */
  startedAt: number | null;
  /** How long it has been paused, before the pause under way. */
  pausedMs: number;
  /** When the pause under way began; null while it records. */
  pausedAt: number | null;
  /** A GIF stops by itself after this many seconds; an MP4 has no limit. */
  maxSeconds: number | null;
  format: RecordingFormat;
  /** Whether the microphone is muted; null when it is not recorded. */
  microphone: boolean | null;
  /** Whether the system sound is muted; null when it is not recorded. */
  system: boolean | null;
  /** Whether the webcam bubble is showing. */
  webcam: boolean;
}

/** Mirrors `MutedInput` in src-tauri/src/record.rs. */
export type MutedInput = "microphone" | "system";

/** Mirrors `BarLayout` in src-tauri/src/record_bar.rs. */
export interface BarLayout {
  /** Whether the menu opens above the pill. */
  up: boolean;
}

/** How long it has recorded at `now`, leaving out the time it was paused. */
export function recordedMs(status: BarStatus, now: number): number {
  if (status.startedAt === null) return 0;
  const until = status.pausedAt ?? now;
  return Math.max(0, until - status.startedAt - status.pausedMs);
}

/** Whole seconds left of the countdown at `now`, at least 1 while it runs. */
export function countdownLeft(status: BarStatus, now: number): number {
  if (status.countdownEndsAt === null) return 0;
  return Math.max(1, Math.ceil((status.countdownEndsAt - now) / 1000));
}

/** Recorded time as `m:ss`, or `h:mm:ss` from an hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function barStatus(): Promise<BarStatus | null> {
  return invoke<BarStatus | null>("record_bar_status");
}

export function onBarStatus(handler: (status: BarStatus) => void): Promise<UnlistenFn> {
  return listen<BarStatus>(RECORD_BAR_EVENT, (event) => handler(event.payload));
}

/** How loud the microphone has been since the last ask, 0 to 1; null when it is not recorded. */
export function microphoneLevel(): Promise<number | null> {
  return invoke<number | null>("record_bar_level");
}

export function stopRecording(): Promise<void> {
  return invoke<void>("record_stop");
}

export function pauseRecording(paused: boolean): Promise<void> {
  return invoke<void>("record_pause", { paused });
}

export function muteInput(input: MutedInput, muted: boolean): Promise<void> {
  return invoke<void>("record_mute", { input, muted });
}

export function showWebcam(shown: boolean): Promise<void> {
  return invoke<void>("record_webcam", { shown });
}

export function restartRecording(): Promise<void> {
  return invoke<void>("record_restart");
}

export function discardRecording(): Promise<void> {
  return invoke<void>("record_discard");
}

/** Fits the window to a pill of `width` × `height` points, with a menu `menu` points tall open. */
export function fitBar(width: number, height: number, menu: number | null): Promise<BarLayout> {
  return invoke<BarLayout>("record_bar_fit", { width, height, menu });
}

/** Forgets where the toolbar was left and puts it back at the top centre. */
export function resetBarPosition(): Promise<void> {
  return invoke<void>("record_bar_reset");
}
