import { MASK_SIZE, segmentFrame } from "./api";

/** `requestVideoFrameCallback`, where the webview has it: Chromium and WebKit do, older WebKitGTK may not. */
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface SegmentingOptions {
  /** Called each time a segmented frame has been drawn. */
  onDrawn: () => void;
  /** Called once, when a frame could not be segmented; nothing more is sent after it. */
  onFailed: (err: unknown) => void;
  /** Segments a frame: {@link segmentFrame} unless a test says otherwise. */
  segment?: (frame: Uint8ClampedArray) => Promise<Uint8Array>;
}

/**
 * Sends `video`'s frames to be segmented, one at a time: a frame that comes
 * while one is still being segmented is skipped, so a slow model drops
 * frames rather than slowing the camera. Each segmented frame is drawn on
 * `person` at the video's own size with only the person left in it, so
 * `person` can be laid over the video with the same CSS. Returns what stops
 * it.
 */
export function startSegmenting(
  video: HTMLVideoElement,
  person: HTMLCanvasElement,
  { onDrawn, onFailed, segment = segmentFrame }: SegmentingOptions,
): () => void {
  // The frame as it is sent, squashed for the model; the frame at full size,
  // kept until its mask comes back so the two line up; and the mask.
  const small = canvas(MASK_SIZE, MASK_SIZE);
  const sent = canvas(0, 0);
  const maskCanvas = canvas(MASK_SIZE, MASK_SIZE);
  const smallContext = small.getContext("2d", { willReadFrequently: true });
  const sentContext = sent.getContext("2d");
  const maskContext = maskCanvas.getContext("2d");
  const personContext = person.getContext("2d");
  if (!smallContext || !sentContext || !maskContext || !personContext) {
    onFailed(new Error("This window cannot draw the webcam background."));
    return () => undefined;
  }
  const maskPixels = maskContext.createImageData(MASK_SIZE, MASK_SIZE);
  const frameVideo = video as FrameVideo;
  const byFrame = typeof frameVideo.requestVideoFrameCallback === "function";
  let stopped = false;
  let busy = false;
  let handle = 0;

  function fail(err: unknown) {
    if (stopped) return;
    stopped = true;
    onFailed(err);
  }

  function draw(mask: Uint8Array, width: number, height: number) {
    const alpha = maskPixels.data;
    for (let i = 0; i < mask.length; i += 1) alpha[i * 4 + 3] = mask[i];
    maskContext!.putImageData(maskPixels, 0, 0);
    if (person.width !== width || person.height !== height) {
      person.width = width;
      person.height = height;
    }
    const context = personContext!;
    context.clearRect(0, 0, width, height);
    context.globalCompositeOperation = "source-over";
    context.drawImage(sent, 0, 0, width, height);
    // Keeps the frame only where the mask says the person is, scaled up
    // smoothly so the edge stays soft.
    context.globalCompositeOperation = "destination-in";
    context.drawImage(maskCanvas, 0, 0, width, height);
    context.globalCompositeOperation = "source-over";
  }

  function send() {
    const { videoWidth: width, videoHeight: height } = video;
    if (busy || width === 0 || height === 0) return;
    busy = true;
    let frame: Uint8ClampedArray;
    try {
      if (sent.width !== width || sent.height !== height) {
        sent.width = width;
        sent.height = height;
      }
      sentContext!.drawImage(video, 0, 0, width, height);
      smallContext!.drawImage(video, 0, 0, MASK_SIZE, MASK_SIZE);
      frame = smallContext!.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
    } catch (err) {
      fail(err);
      return;
    }
    segment(frame)
      .then((mask) => {
        if (stopped) return;
        if (mask.length !== MASK_SIZE * MASK_SIZE) throw new Error(`A mask of ${mask.length} bytes`);
        draw(mask, width, height);
        onDrawn();
      })
      .catch(fail)
      .finally(() => {
        busy = false;
      });
  }

  function tick() {
    if (stopped) return;
    send();
    next();
  }

  function next() {
    if (stopped) return;
    handle = byFrame ? frameVideo.requestVideoFrameCallback!(tick) : window.requestAnimationFrame(tick);
  }

  next();
  return () => {
    stopped = true;
    if (byFrame) frameVideo.cancelVideoFrameCallback?.(handle);
    else window.cancelAnimationFrame(handle);
  };
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  return element;
}
