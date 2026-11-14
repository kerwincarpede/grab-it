import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./webcam.css";
import { cameraProblem, openCamera, webcamOptions, type WebcamOptions } from "./api";

interface WebcamBubbleProps {
  options?: WebcamOptions;
}

/**
 * The webcam bubble shown while recording: the camera fills a see-through,
 * borderless window, clipped to a circle or a rounded square, and is
 * recorded along with the screen. Drag it anywhere; it closes with the
 * recording.
 */
function WebcamBubble({ options = webcamOptions(window.location.hash) }: WebcamBubbleProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { shape, camera } = options;

  // The window is see-through: only the bubble may paint.
  useLayoutEffect(() => {
    document.documentElement.classList.add("webcam-clear");
    return () => document.documentElement.classList.remove("webcam-clear");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    openCamera(camera)
      .then((opened) => {
        if (cancelled) {
          for (const track of opened.getTracks()) track.stop();
          return;
        }
        stream = opened;
        const element = video.current;
        if (element) {
          element.srcObject = opened;
          // jsdom has no media playback, and returns nothing here.
          const playing = element.play() as Promise<void> | undefined;
          void playing?.catch(() => undefined);
        }
        setLive(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setProblem(cameraProblem(err));
      });
    return () => {
      cancelled = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [camera]);

  function onMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    try {
      void getCurrentWindow()
        .startDragging()
        .catch(() => undefined);
    } catch {
      // Outside a Tauri window there is nothing to drag.
    }
  }

  return (
    <main
      className={`webcam webcam-${shape}`}
      data-testid="webcam"
      data-live={live ? "true" : "false"}
      aria-label="Webcam"
      onMouseDown={onMouseDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <video ref={video} className="webcam-video" autoPlay muted playsInline />
      {problem && (
        <p className="webcam-problem" role="status">
          {problem}
        </p>
      )}
    </main>
  );
}

export default WebcamBubble;
