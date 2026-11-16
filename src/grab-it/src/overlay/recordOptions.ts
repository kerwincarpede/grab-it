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
