import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject, type VideoHTMLAttributes } from "react";
import { fetchRecording, playsFromBlob, videoSrc } from "./api";

interface RecordingVideoProps extends VideoHTMLAttributes<HTMLVideoElement> {
  source: string;
  path: string;
  active: boolean;
  activeRef: RefObject<HTMLVideoElement | null>;
  onReady: (video: HTMLVideoElement) => void;
  onFailure: (source: string, message: string) => void;
}

/**
 * The preview's player for one recording, mounted once and kept while any
 * clip plays that recording, hidden and paused while another is on show.
 * On Linux it plays a blob of the file, fetched once; its URL is revoked
 * only when the player goes, as WebKitGTK does not reliably show a
 * recording again in a new element or from a new URL.
 */
export default function RecordingVideo({ source, path, active, activeRef, onReady, onFailure, ...events }: RecordingVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const download = useRef<Promise<Blob> | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const fromBlob = playsFromBlob();
  const src = fromBlob ? blobUrl : videoSrc(path);

  useEffect(() => {
    if (!fromBlob) return;
    let closed = false;
    let url: string | undefined;
    // React can reconnect effects on the same mounted player.
    download.current ??= fetchRecording(videoSrc(path));
    download.current.then((blob) => {
      if (closed) return;
      url = URL.createObjectURL(blob);
      setBlobUrl(url);
    }).catch((err: unknown) => {
      if (!closed) onFailure(source, `The recording cannot be played: ${err instanceof Error ? err.message : String(err)}`);
    });
    return () => {
      closed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [fromBlob, path, source, onFailure]);

  const activate = useEffectEvent(onReady);
  useLayoutEffect(() => {
    const video = ref.current;
    if (!active || !video) return;
    activeRef.current = video;
    // An already loaded recording will not send loadedmetadata again when
    // it becomes visible. Apply the new clip's seek and playback immediately.
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) activate(video);
    return () => {
      if (activeRef.current === video) activeRef.current = null;
      if (!video.paused) video.pause();
    };
  }, [active, activeRef, src]);

  if (!src) return null;
  return (
    <video
      {...events}
      ref={ref}
      className="recording-video"
      data-source={source}
      hidden={!active}
      // Only the recording on show is heard.
      muted={!active}
      src={src}
      crossOrigin={fromBlob ? undefined : "anonymous"}
      preload="auto"
      playsInline
      onLoadedMetadata={(event) => onReady(event.currentTarget)}
      onLoadedData={(event) => onReady(event.currentTarget)}
      onCanPlay={(event) => onReady(event.currentTarget)}
      onError={() => onFailure(source, "The recording cannot be played.")}
    />
  );
}
