import {
  RECORDING_COUNTDOWNS,
  recordsMicrophone,
  recordsSystemSound,
  type Camera,
  type Microphone,
  type RecordingAudio,
  type RecordingSettings,
} from "../settings/api";

/** The sound recorded with the microphone and the system sound each on or off. */
export function audioWith(microphone: boolean, system: boolean): RecordingAudio {
  if (microphone && system) return "both";
  if (microphone) return "microphone";
  if (system) return "system";
  return "none";
}

/** The microphone chosen in the setup bar: none, the system's default, or one by id. */
export type MicrophoneChoice = { kind: "none" } | { kind: "default" } | { kind: "device"; id: string };

/** `recording` with `choice` as its microphone. */
export function withMicrophone(recording: RecordingSettings, choice: MicrophoneChoice): RecordingSettings {
  const system = recordsSystemSound(recording.audio);
  if (choice.kind === "none") return { ...recording, audio: audioWith(false, system) };
  return {
    ...recording,
    audio: audioWith(true, system),
    microphone: choice.kind === "device" ? choice.id : null,
  };
}

/** `recording` with the system sound on or off, keeping the microphone as it was. */
export function withSystemSound(recording: RecordingSettings, on: boolean): RecordingSettings {
  return { ...recording, audio: audioWith(recordsMicrophone(recording.audio), on) };
}

/** The next countdown along, back to none after the longest. */
export function nextCountdown(seconds: number): number {
  const at = RECORDING_COUNTDOWNS.indexOf(seconds as (typeof RECORDING_COUNTDOWNS)[number]);
  return RECORDING_COUNTDOWNS[(at + 1) % RECORDING_COUNTDOWNS.length];
}

/** What the countdown button's tooltip says it does. */
export const COUNTDOWN_USE = "Waits off, 3, 5 or 10 s before recording starts.";

/** What the countdown button says, and its name, for `seconds`. */
export function countdownText(seconds: number): { text: string; label: string } {
  return seconds === 0
    ? { text: "Off", label: "No countdown" }
    : { text: `${seconds} s`, label: `Countdown ${seconds} s` };
}

/** What the microphone chip says. */
export function microphoneLabel(recording: RecordingSettings, microphones: Microphone[]): string {
  if (!recordsMicrophone(recording.audio)) return "No microphone";
  if (recording.microphone === null) return "Default microphone";
  return microphones.find((mic) => mic.id === recording.microphone)?.name ?? "Saved microphone";
}

/** The camera chosen in the setup bar: no webcam, the system's default, or one by id. */
export type CameraChoice = { kind: "none" } | { kind: "default" } | { kind: "device"; id: string };

/** `recording` with `choice` as its webcam; no webcam keeps the camera saved for next time. */
export function withCamera(recording: RecordingSettings, choice: CameraChoice): RecordingSettings {
  if (choice.kind === "none") return { ...recording, showWebcam: false };
  return { ...recording, showWebcam: true, camera: choice.kind === "device" ? choice.id : null };
}

/** What the camera chip says. */
export function cameraLabel(recording: RecordingSettings, cameras: Camera[]): string {
  if (!recording.showWebcam) return "No webcam";
  if (recording.camera === null) return "Default camera";
  return cameras.find((camera) => camera.id === recording.camera)?.name ?? "Saved camera";
}

/**
 * The microphone level on a perceptual scale: the peak in decibels, from
 * -60 dB (nothing) to 0 dB (full), so speech clearly moves it.
 */
export function perceivedLevel(level: number): number {
  if (!(level > 0)) return 0;
  const decibels = 20 * Math.log10(Math.min(1, level));
  return Math.max(0, Math.min(1, (decibels + 60) / 60));
}

/** The gap between a control and the list or panel it opens, in CSS px. */
const POPUP_GAP = 6;

/**
 * Whether a list or panel `height` px tall opens above its control, which
 * spans `anchor` on a screen `viewportHeight` px tall: the way it prefers
 * while it fits, else the way with more room, so it draws in full and
 * nothing has to scroll.
 */
export function opensUp(
  preferUp: boolean,
  anchor: { top: number; bottom: number },
  viewportHeight: number,
  height: number,
): boolean {
  const below = viewportHeight - anchor.bottom - POPUP_GAP;
  const above = anchor.top - POPUP_GAP;
  if (preferUp) return above >= height || above >= below;
  return below < height && above > below;
}

/** A popup's distance from the screen's edges, in CSS px. */
const SCREEN_MARGIN = 8;

/** Where a list or panel goes, in viewport CSS px. */
export interface PopupPlacement {
  top: number;
  left: number;
  up: boolean;
  /** Set only for one taller than the whole screen, which then scrolls. */
  maxHeight: number | null;
}

/**
 * Places a popup of `size` by its control's `anchor`, both measured: above
 * or below as {@link opensUp} chooses, lined up with the control's start or
 * end, then kept inside the screen with a margin. So any popup shorter
 * than the screen shows in full, even if that means it overlaps its
 * control.
 */
export function placePopup(
  anchor: { top: number; bottom: number; left: number; right: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  preferUp: boolean,
  align: "start" | "end",
): PopupPlacement {
  const room = viewport.height - 2 * SCREEN_MARGIN;
  const height = Math.min(size.height, room);
  const up = opensUp(preferUp, anchor, viewport.height, height);
  const wanted = up ? anchor.top - POPUP_GAP - height : anchor.bottom + POPUP_GAP;
  const top = Math.max(SCREEN_MARGIN, Math.min(wanted, viewport.height - SCREEN_MARGIN - height));
  const across = align === "end" ? anchor.right - size.width : anchor.left;
  const left = Math.max(SCREEN_MARGIN, Math.min(across, viewport.width - SCREEN_MARGIN - size.width));
  return { top, left, up, maxHeight: size.height > room ? room : null };
}
