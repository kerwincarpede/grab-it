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
