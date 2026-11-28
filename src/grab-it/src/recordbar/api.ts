import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type BarLayout, type BarStatus_Serialize, type MutedInput, type Phase } from "../app/bindings";

/** Mirrors `RECORD_BAR_EVENT` in src-tauri/src/record_bar.rs. */
export const RECORD_BAR_EVENT = "record-bar-status";

/** From `Phase` in src-tauri/src/record.rs. */
export type BarPhase = Phase;

/** From `BarStatus` in src-tauri/src/record.rs. Times are ms since the Unix epoch. */
export type BarStatus = BarStatus_Serialize;

/** From `MutedInput` in src-tauri/src/record.rs. */
export type { MutedInput };

/** From `BarLayout` in src-tauri/src/record_bar.rs: whether the menu opens above the pill. */
export type { BarLayout };

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
  return commands.recordBarStatus();
}

export function onBarStatus(handler: (status: BarStatus) => void): Promise<UnlistenFn> {
  return listen<BarStatus>(RECORD_BAR_EVENT, (event) => handler(event.payload));
}

/** How loud the microphone has been since the last ask, 0 to 1; null when it is not recorded. */
export function microphoneLevel(): Promise<number | null> {
  return commands.recordBarLevel();
}

export function stopRecording(): Promise<void> {
  return commands.recordStop();
}

/** Ends the countdown, so the recording starts at once. */
export function startNow(): Promise<void> {
  return commands.recordStartNow();
}

export function pauseRecording(paused: boolean): Promise<void> {
  return commands.recordPause(paused);
}

export function muteInput(input: MutedInput, muted: boolean): Promise<void> {
  return commands.recordMute(input, muted);
}

export function showWebcam(shown: boolean): Promise<void> {
  return commands.recordWebcam(shown);
}

export function restartRecording(): Promise<void> {
  return commands.recordRestart();
}

export function discardRecording(): Promise<void> {
  return commands.recordDiscard();
}

/** Fits the window to a pill of `width` × `height` points, with a menu `menu` points tall open. */
export function fitBar(width: number, height: number, menu: number | null): Promise<BarLayout> {
  return commands.recordBarFit(width, height, menu);
}

/** Forgets where the toolbar was left and puts it back at the top centre. */
export function resetBarPosition(): Promise<void> {
  return commands.recordBarReset();
}
