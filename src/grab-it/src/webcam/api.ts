import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_RECORDING,
  WEBCAM_BACKGROUNDS,
  WEBCAM_SHAPES,
  type WebcamBackground,
  type WebcamShape,
} from "../settings/api";

/**
 * What the bubble shows, as webcam.rs puts it in the hash
 * (`#/webcam?shape=squircle&mirror=0&camera=…&background=blur&blur=50`).
 */
export interface WebcamOptions {
  shape: WebcamShape;
  /** Whether the camera is shown mirrored, as a mirror would. */
  mirror: boolean;
  /** The camera's `deviceId`; null shows the system's default camera. */
  camera: string | null;
  /** What is shown behind the person. */
  background: WebcamBackground;
  /** How much a blurred background is blurred, 1 to 100 percent. */
  blur: number;
  /** The colour behind the person with the colour background, as `#rrggbb`. */
  color: string;
}

/** `blur=n` as a whole 1 to 100, or the default. */
function blurAmount(value: string | null): number {
  const amount = value === null || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isInteger(amount) && amount >= 1 && amount <= 100 ? amount : DEFAULT_RECORDING.webcamBlur;
}

/** `color=rrggbb` as `#rrggbb`, or the default. */
function backgroundColor(value: string | null): string {
  return value !== null && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : DEFAULT_RECORDING.webcamBackgroundColor;
}

export function webcamOptions(hash: string): WebcamOptions {
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  const camera = query.get("camera");
  const shape = WEBCAM_SHAPES.find((choice) => choice.value === query.get("shape"))?.value;
  return {
    shape: shape ?? "squircle",
    mirror: query.get("mirror") !== "0",
    camera: camera === null || camera === "" ? null : camera,
    background: WEBCAM_BACKGROUNDS.find((choice) => choice.value === query.get("background"))?.value ?? "none",
    blur: blurAmount(query.get("blur")),
    color: backgroundColor(query.get("color")),
  };
}

/** The side of the frames sent to be segmented and of their masks. Mirrors `FRAME_SIZE` in src-tauri/src/segmentation.rs. */
export const MASK_SIZE = 256;

/**
 * How likely each pixel of `frame` is the person, from 0 (the room) to 255,
 * row by row. `frame` is a camera frame squashed to {@link MASK_SIZE}
 * square, RGBA. Rejects when the model will not load or fails on it.
 */
export async function segmentFrame(frame: Uint8ClampedArray): Promise<Uint8Array> {
  const mask = await invoke<ArrayBuffer>("webcam_segment", new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
  return new Uint8Array(mask);
}

/** The CSS blur of a blurred background, in pixels, for an amount from 1 to 100 percent. */
export function blurPixels(amount: number): number {
  return Math.round((Math.min(Math.max(amount, 1), 100) / 100) * MAX_BLUR_PX * 10) / 10;
}

/** The most a background is blurred, at 100 percent, in CSS pixels across a bubble of about 200. */
const MAX_BLUR_PX = 24;

/** Square-ish video, enough for a bubble on a HiDPI screen; the camera picks the nearest it has. */
const VIDEO: MediaTrackConstraints = { width: { ideal: 720 }, height: { ideal: 720 } };

/** Asks for `camera`, or the default camera when it is null. Never asks for sound. */
export function cameraConstraints(camera: string | null): MediaStreamConstraints {
  return {
    audio: false,
    video: camera === null ? VIDEO : { ...VIDEO, deviceId: { exact: camera } },
  };
}

/**
 * The chosen camera's stream, or the default camera's when the chosen one is
 * gone (unplugged, or its id changed). Rejects when there is no camera at all
 * or it may not be used.
 */
export async function openCamera(camera: string | null): Promise<MediaStream> {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== "function") {
    throw new Error("This window cannot use the camera.");
  }
  try {
    return await media.getUserMedia(cameraConstraints(camera));
  } catch (err) {
    if (camera === null) throw err;
    return media.getUserMedia(cameraConstraints(null));
  }
}

/** What the bubble says when the camera does not start. */
export function cameraProblem(err: unknown): string {
  const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera not allowed";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera found";
    case "NotReadableError":
      return "Camera in use";
    default:
      return "Camera unavailable";
  }
}
