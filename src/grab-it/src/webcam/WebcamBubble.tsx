import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./webcam.css";
import { CameraIcon, CameraOffIcon } from "../app/icons";
import { listCameras, rememberListing } from "../settings/api";
import { cameraProblem, openCamera, webcamOptions, type WebcamOptions } from "./api";
import { BLOB_SECONDS, shapeOutline } from "./shapes";

interface WebcamBubbleProps {
  options?: WebcamOptions;
}

/**
 * How long the video waits after its first frame before it fades in:
 * cameras send a few dark frames while their exposure settles.
 */
const SETTLE_MS = 150;
/** Shown anyway this long after the camera opened, should the video never say it is playing. */
const SHOW_ANYWAY_MS = 1000;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The webcam bubble shown while recording: the camera, in a see-through,
 * borderless window, clipped to the chosen shape with a soft shadow
 * around it, and recorded along with the screen. Drag it anywhere; it
 * closes with the recording.
 */
function WebcamBubble({ options = webcamOptions(window.location.hash) }: WebcamBubbleProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [still] = useState(prefersReducedMotion);
  const { shape, mirror, camera } = options;
  const outline = shapeOutline(shape);

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

  // With a camera live, the webview names its cameras: they are remembered
  // for the setup toolbar's Camera chip.
  useEffect(() => {
    if (!live) return;
    listCameras()
      .then(rememberListing)
      .catch(() => undefined);
  }, [live]);

  // The video fades in once its picture has settled.
  useEffect(() => {
    if (!live) return;
    const timer = window.setTimeout(() => setShown(true), playing ? SETTLE_MS : SHOW_ANYWAY_MS);
    return () => window.clearTimeout(timer);
  }, [live, playing]);

  function onMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    // A drag must not start a text selection, which would be recorded.
    event.preventDefault();
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
      className={`webcam webcam-${shape}${mirror ? " webcam-mirrored" : ""}`}
      data-testid="webcam"
      data-live={live ? "true" : "false"}
      data-shown={shown ? "true" : "false"}
      aria-label="Webcam"
      onMouseDown={onMouseDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {/*
        The shape, once, for everything drawn to it: the bubble's clip,
        the video's (mirrored with the video, so it lands back on the
        bubble's) and the outline's.
      */}
      <svg className="webcam-defs" width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <path id="webcam-shape" d={outline.path} vectorEffect="non-scaling-stroke">
            {outline.morph && !still && (
              <animate
                attributeName="d"
                values={outline.morph}
                dur={`${BLOB_SECONDS}s`}
                repeatCount="indefinite"
                calcMode="spline"
                keyTimes="0;0.33;0.67;1"
                keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1"
              />
            )}
          </path>
          <clipPath id="webcam-clip" clipPathUnits="objectBoundingBox">
            <use href="#webcam-shape" />
          </clipPath>
          <clipPath id="webcam-clip-flipped" clipPathUnits="objectBoundingBox">
            <use href="#webcam-shape" transform="matrix(-1 0 0 1 1 0)" />
          </clipPath>
          <clipPath id="webcam-inside">
            <use href="#webcam-shape" />
          </clipPath>
        </defs>
      </svg>
      <div className="webcam-frame">
        {!shown && !problem && (
          <div className="webcam-waiting" aria-hidden="true">
            <span className="webcam-pulse" />
            <CameraIcon size={28} />
          </div>
        )}
        <video
          ref={video}
          className="webcam-video"
          autoPlay
          muted
          playsInline
          onPlaying={() => setPlaying(true)}
        />
        <div className="webcam-sheen" />
        {problem && (
          <p className="webcam-problem" role="status">
            <CameraOffIcon size={26} />
            {problem}
          </p>
        )}
      </div>
      <svg className="webcam-outline" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <g clipPath="url(#webcam-inside)">
          <use href="#webcam-shape" className="webcam-edge-inner" />
        </g>
        <use href="#webcam-shape" className="webcam-edge-outer" />
      </svg>
    </main>
  );
}

export default WebcamBubble;
