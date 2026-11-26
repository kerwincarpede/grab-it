import { useEffect, useRef, useState } from "react";
import { fetchRecording, playsFromBlob, videoSrc } from "./api";
import type { PlacedClip } from "./tracks";

/** How far a playing clip's sound may run from the playhead before it is moved back at once. */
const SEEK_S = 0.15;
/** Below this the sound is in step; between it and `SEEK_S` its rate is nudged to catch up. */
const IN_STEP_S = 0.02;
/** The most the rate is nudged either way while catching up. */
const MAX_NUDGE = 0.1;

interface TrackAudioProps {
  /** Every clip on an audio track. */
  clips: PlacedClip[];
  /** Where each recording's file is, or null while unknown. */
  pathOf: (source: string) => string | null;
  /** The playhead, in sequence time. */
  currentMs: number;
  playing: boolean;
}

/**
 * The sound of the audio tracks while the preview's videos are muted: one
 * media element per clip, played over its place and kept in step with the
 * playhead, so overlapping sound is heard summed as the export mixes it.
 */
export default function TrackAudio({ clips, pathOf, currentMs, playing }: TrackAudioProps) {
  return (
    <div hidden>
      {clips.map((clip) => {
        const path = pathOf(clip.source);
        return path ? <ClipAudio key={clip.id} clip={clip} path={path} currentMs={currentMs} playing={playing} /> : null;
      })}
    </div>
  );
}

/** On Linux, one blob per recording, shared by every clip that plays it. */
const blobs = new Map<string, { url: Promise<string>; users: number }>();

/** A blob URL of `path`, shared while any clip uses it; null until it is fetched. */
function useSharedBlob(path: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let entry = blobs.get(path);
    if (!entry) {
      entry = { url: fetchRecording(videoSrc(path)).then((blob) => URL.createObjectURL(blob)), users: 0 };
      blobs.set(path, entry);
    }
    const held = entry;
    held.users += 1;
    let closed = false;
    held.url.then((made) => !closed && setUrl(made)).catch(() => undefined);
    return () => {
      closed = true;
      held.users -= 1;
      if (held.users > 0) return;
      blobs.delete(path);
      held.url.then((made) => URL.revokeObjectURL(made)).catch(() => undefined);
    };
  }, [path, enabled]);
  return enabled ? url : null;
}

function ClipAudio({ clip, path, currentMs, playing }: { clip: PlacedClip; path: string; currentMs: number; playing: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const fromBlob = playsFromBlob();
  const blobUrl = useSharedBlob(path, fromBlob);
  const src = fromBlob ? blobUrl : videoSrc(path);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    const before = currentMs < clip.atMs;
    const inside = !before && currentMs < clip.atMs + (clip.endMs - clip.startMs);
    try {
      if (!inside || !playing) {
        if (!audio.paused) audio.pause();
        audio.playbackRate = 1;
      }
      // Waiting for its place, it is ready at its first moment.
      const target = before ? clip.startMs / 1000 : (clip.startMs + currentMs - clip.atMs) / 1000;
      if (!inside && !before) return;
      const drift = audio.currentTime - target;
      if (!playing || !inside || Math.abs(drift) > SEEK_S) {
        if (Math.abs(drift) > IN_STEP_S / 2) audio.currentTime = target;
      } else {
        // Ahead slows down, behind speeds up, without an audible jump.
        audio.playbackRate = Math.abs(drift) > IN_STEP_S ? 1 - Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift)) : 1;
      }
      if (inside && playing && audio.paused) void audio.play()?.catch(() => undefined);
    } catch {
      // Not loaded yet: the next tick tries again.
    }
  }, [clip, currentMs, playing, src]);

  if (!src) return null;
  return <audio ref={ref} src={src} preload="auto" data-clip={clip.id} />;
}
