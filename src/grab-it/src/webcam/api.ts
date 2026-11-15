import type { WebcamShape } from "../settings/api";

/** What the bubble shows, as webcam.rs puts it in the hash (`#/webcam?shape=round&camera=…`). */
export interface WebcamOptions {
  shape: WebcamShape;
  /** The camera's `deviceId`; null shows the system's default camera. */
  camera: string | null;
}

export function webcamOptions(hash: string): WebcamOptions {
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  const camera = query.get("camera");
  return {
    shape: query.get("shape") === "rounded" ? "rounded" : "round",
    camera: camera === null || camera === "" ? null : camera,
  };
}

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
