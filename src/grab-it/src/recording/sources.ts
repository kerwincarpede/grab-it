import { open } from "@tauri-apps/plugin-dialog";
import { fetchRecording, playsFromBlob, videoSrc } from "./api";

/** What the page learns about a recording a clip plays, from its metadata. */
export interface SourceMeta {
  durationMs: number;
  width: number;
  height: number;
}

/** Asks for an MP4 in the recordings folder `folder`. Null when the user cancels. */
export async function chooseRecording(folder: string): Promise<string | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    title: "Add a recording",
    defaultPath: folder,
    filters: [{ name: "Recordings", extensions: ["mp4"] }],
  });
  return typeof picked === "string" ? picked : null;
}

/**
 * The duration and size of the MP4 at `path`, read from its metadata by a
 * video element of its own (from a blob on Linux, as the preview plays).
 */
export async function probeVideo(path: string): Promise<SourceMeta> {
  const blobUrl = playsFromBlob() ? URL.createObjectURL(await fetchRecording(videoSrc(path))) : null;
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  try {
    return await new Promise<SourceMeta>((resolve, reject) => {
      video.onloadedmetadata = () => {
        const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
        if (durationMs <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) reject(new Error("the recording has no video"));
        else resolve({ durationMs, width: video.videoWidth, height: video.videoHeight });
      };
      video.onerror = () => reject(new Error("the recording cannot be played"));
      video.src = blobUrl ?? videoSrc(path);
    });
  } finally {
    video.removeAttribute("src");
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}
