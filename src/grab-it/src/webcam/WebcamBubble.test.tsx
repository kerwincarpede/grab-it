import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEBCAM_SHAPES } from "../settings/api";
import WebcamBubble from "./WebcamBubble";
import { MASK_SIZE, blurPixels, cameraConstraints, cameraProblem, segmentFrame, webcamOptions, type WebcamOptions } from "./api";
import { startSegmenting } from "./background";
import { SHAPE_OUTLINES, shapeOutline } from "./shapes";
import { camera, fakeMedia, type FakeMedia } from "./testMedia";
import { mockCommands } from "../test/mockCommands";

const SQUIRCLE: WebcamOptions = {
  shape: "squircle",
  mirror: true,
  camera: null,
  background: "none",
  blur: 50,
  color: "#202124",
};

let media: FakeMedia | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

describe("webcamOptions", () => {
  it("reads the shape, the mirroring and the camera from the hash", () => {
    expect(webcamOptions("#/webcam?shape=arch&mirror=0&camera=a%20b%2Fc%2Bd%3D%C3%A9")).toEqual({
      ...SQUIRCLE,
      shape: "arch",
      mirror: false,
      camera: "a b/c+d=é",
    });
    expect(webcamOptions("#/webcam?shape=round")).toEqual({ ...SQUIRCLE, shape: "round" });
    for (const { value } of WEBCAM_SHAPES) {
      expect(webcamOptions(`#/webcam?shape=${value}`).shape).toBe(value);
    }
  });

  it("is a mirrored squircle on the default camera when the hash says nothing it knows", () => {
    expect(webcamOptions("#/webcam")).toEqual(SQUIRCLE);
    expect(webcamOptions("#/webcam?shape=star&mirror=no&camera=")).toEqual(SQUIRCLE);
  });

  it("reads the background, its blur and its colour", () => {
    expect(webcamOptions("#/webcam?shape=squircle&background=blur&blur=72")).toEqual({
      ...SQUIRCLE,
      background: "blur",
      blur: 72,
    });
    expect(webcamOptions("#/webcam?shape=squircle&background=color&color=33AA66")).toEqual({
      ...SQUIRCLE,
      background: "color",
      color: "#33aa66",
    });
  });

  it("shows no background, or the default blur and colour, for values it does not know", () => {
    expect(webcamOptions("#/webcam?background=image").background).toBe("none");
    for (const blur of ["0", "101", "2.5", "", "lots"]) {
      expect(webcamOptions(`#/webcam?background=blur&blur=${blur}`).blur).toBe(50);
    }
    for (const color of ["red", "12345", "%23123456", ""]) {
      expect(webcamOptions(`#/webcam?background=color&color=${color}`).color).toBe("#202124");
    }
  });
});

describe("shapeOutline", () => {
  it("has an outline for every shape, drawn inside the unit box", () => {
    for (const { value } of WEBCAM_SHAPES) {
      const outlines = SHAPE_OUTLINES[value];
      expect(outlines.length).toBeGreaterThan(0);
      for (const outline of outlines) {
        const numbers = outline.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
        expect(numbers.every((n) => n >= 0 && n <= 1)).toBe(true);
      }
    }
  });

  it("moves only the blob, through outlines that share their commands", () => {
    expect(shapeOutline("squircle").morph).toBeNull();
    const blob = shapeOutline("blob");
    expect(blob.path).toBe(SHAPE_OUTLINES.blob[0]);
    const frames = blob.morph?.split(";") ?? [];
    expect(frames).toHaveLength(SHAPE_OUTLINES.blob.length + 1);
    expect(frames[frames.length - 1]).toBe(frames[0]);
    const commands = (path: string) => path.replace(/[^A-Za-z]/g, "");
    expect(new Set(frames.map(commands)).size).toBe(1);
  });
});

describe("cameraConstraints", () => {
  it("asks for the chosen camera only, and never for sound", () => {
    const chosen = cameraConstraints("cam-1");
    expect(chosen.audio).toBe(false);
    expect(chosen.video).toMatchObject({ deviceId: { exact: "cam-1" } });
    const fallback = cameraConstraints(null);
    expect(fallback.audio).toBe(false);
    expect(fallback.video).not.toHaveProperty("deviceId");
  });
});

describe("cameraProblem", () => {
  it.each([
    ["NotAllowedError", "Camera not allowed"],
    ["NotFoundError", "No camera found"],
    ["NotReadableError", "Camera in use"],
    ["AbortError", "Camera unavailable"],
  ])("says %s as %j", (name, message) => {
    expect(cameraProblem(Object.assign(new Error("x"), { name }))).toBe(message);
  });

  it("copes with something that is not an error", () => {
    expect(cameraProblem("nope")).toBe("Camera unavailable");
  });
});

describe("WebcamBubble", () => {
  it("shows the chosen camera in a mirrored squircle", async () => {
    media = fakeMedia();
    render(<WebcamBubble options={{ ...SQUIRCLE, camera: "cam-1" }} />);
    const bubble = screen.getByTestId("webcam");
    expect(bubble).toHaveClass("webcam-squircle", "webcam-mirrored");
    expect(document.getElementById("webcam-shape")).toHaveAttribute("d", SHAPE_OUTLINES.squircle[0]);
    expect(document.documentElement).toHaveClass("webcam-clear");
    await waitFor(() => expect(bubble).toHaveAttribute("data-live", "true"));
    expect(media.requests).toHaveLength(1);
    expect(media.requests[0].video).toMatchObject({ deviceId: { exact: "cam-1" } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("remembers the cameras' names once its camera is live", async () => {
    const remembered: unknown[] = [];
    mockCommands(
      {
        remember_cameras: ({ cameras }) => {
          remembered.push(cameras);
          return null;
        },
      },
      { otherwise: () => null },
    );
    media = fakeMedia({
      devices: [camera("", "")],
      devicesAfterOpen: [camera("cam-1", "FaceTime HD Camera"), camera("cam-2", "USB Webcam")],
    });
    render(<WebcamBubble options={{ ...SQUIRCLE, camera: "cam-1" }} />);
    await waitFor(() =>
      expect(remembered).toEqual([
        [
          { id: "cam-1", name: "FaceTime HD Camera" },
          { id: "cam-2", name: "USB Webcam" },
        ],
      ]),
    );
    // Listing them never opens another camera.
    expect(media.requests).toHaveLength(1);
  });

  it("keeps the cameras remembered when their names are hidden", async () => {
    const calls = mockCommands({}, { otherwise: () => null });
    media = fakeMedia({ devices: [camera("cam-1", "")] });
    render(<WebcamBubble options={SQUIRCLE} />);
    await waitFor(() => expect(screen.getByTestId("webcam")).toHaveAttribute("data-live", "true"));
    await act(() => Promise.resolve());
    expect(calls.map((call) => call.cmd)).not.toContain("remember_cameras");
  });

  it("takes the chosen shape, unmirrored when asked", () => {
    media = fakeMedia();
    render(<WebcamBubble options={{ ...SQUIRCLE, shape: "pill", mirror: false }} />);
    const bubble = screen.getByTestId("webcam");
    expect(bubble).toHaveClass("webcam-pill");
    expect(bubble).not.toHaveClass("webcam-mirrored");
    expect(document.getElementById("webcam-shape")).toHaveAttribute("d", SHAPE_OUTLINES.pill[0]);
    expect(document.querySelector("animate")).toBeNull();
  });

  it("lets the blob drift", () => {
    media = fakeMedia();
    render(<WebcamBubble options={{ ...SQUIRCLE, shape: "blob" }} />);
    expect(document.querySelector("#webcam-shape animate")).toHaveAttribute("values", shapeOutline("blob").morph);
  });

  it("waits with a pulse, and fades the video in once its picture has settled", async () => {
    vi.useFakeTimers();
    try {
      media = fakeMedia();
      const { container } = render(<WebcamBubble options={SQUIRCLE} />);
      const bubble = screen.getByTestId("webcam");
      expect(container.querySelector(".webcam-waiting")).not.toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(bubble).toHaveAttribute("data-live", "true");
      expect(bubble).toHaveAttribute("data-shown", "false");

      fireEvent.playing(container.querySelector("video")!);
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(bubble).toHaveAttribute("data-shown", "false");
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(bubble).toHaveAttribute("data-shown", "true");
      expect(container.querySelector(".webcam-waiting")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the video anyway should it never say it is playing", async () => {
    vi.useFakeTimers();
    try {
      media = fakeMedia();
      render(<WebcamBubble options={SQUIRCLE} />);
      const bubble = screen.getByTestId("webcam");
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(bubble).toHaveAttribute("data-live", "true");
      await act(() => vi.advanceTimersByTimeAsync(999));
      expect(bubble).toHaveAttribute("data-shown", "false");
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(bubble).toHaveAttribute("data-shown", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the default camera when the chosen one is gone", async () => {
    media = fakeMedia({
      fail: { name: "OverconstrainedError", when: (constraints) => typeof constraints.video === "object" && "deviceId" in constraints.video },
    });
    render(<WebcamBubble options={{ ...SQUIRCLE, camera: "unplugged" }} />);
    await waitFor(() => expect(screen.getByTestId("webcam")).toHaveAttribute("data-live", "true"));
    expect(media.requests).toHaveLength(2);
    expect(media.requests[1].video).not.toHaveProperty("deviceId");
  });

  it("says why when the camera cannot start", async () => {
    media = fakeMedia({ fail: { name: "NotAllowedError" } });
    render(<WebcamBubble options={SQUIRCLE} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Camera not allowed");
    expect(screen.getByTestId("webcam")).toHaveAttribute("data-live", "false");
  });

  it("says so when the window has no camera access at all", async () => {
    render(<WebcamBubble options={SQUIRCLE} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Camera unavailable");
  });

  it("never starts a text selection when the bubble is dragged", async () => {
    media = fakeMedia({ fail: { name: "NotFoundError" } });
    render(<WebcamBubble options={SQUIRCLE} />);
    const message = await screen.findByRole("status");
    // fireEvent returns false when the default action was prevented.
    expect(fireEvent.mouseDown(message, { button: 0 })).toBe(false);
    expect(fireEvent.mouseDown(screen.getByTestId("webcam"), { button: 0 })).toBe(false);
  });

  it("stops the camera when it closes", async () => {
    media = fakeMedia();
    const { unmount } = render(<WebcamBubble options={SQUIRCLE} />);
    await waitFor(() => expect(screen.getByTestId("webcam")).toHaveAttribute("data-live", "true"));
    unmount();
    expect(media.stopped).toBe(1);
    expect(document.documentElement).not.toHaveClass("webcam-clear");
  });
});

/** A 2D context that draws nothing, for jsdom, which has no canvas. */
function fakeContext() {
  return {
    globalCompositeOperation: "source-over",
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    putImageData: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(MASK_SIZE * MASK_SIZE * 4).fill(7) })),
    createImageData: vi.fn((width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
  };
}

/** Where the video frame callbacks live, which jsdom's videos lack. */
type FrameCallbacks = {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Gives jsdom's videos a 640×480 picture and `requestVideoFrameCallback`,
 * with each frame delivered by `next`. Returns what puts them back.
 */
function fakeFrames() {
  const proto = HTMLVideoElement.prototype as unknown as FrameCallbacks;
  const width = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoWidth");
  const height = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoHeight");
  let waiting: (() => void)[] = [];
  let cancelled = 0;
  proto.requestVideoFrameCallback = (callback) => waiting.push(callback);
  proto.cancelVideoFrameCallback = () => (cancelled += 1);
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { get: () => 640, configurable: true });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { get: () => 480, configurable: true });
  return {
    /** Delivers a frame to whatever is waiting for one. */
    next() {
      const callbacks = waiting;
      waiting = [];
      for (const callback of callbacks) callback();
    },
    waiting: () => waiting.length,
    cancelled: () => cancelled,
    restore() {
      delete proto.requestVideoFrameCallback;
      delete proto.cancelVideoFrameCallback;
      for (const [name, descriptor] of [
        ["videoWidth", width],
        ["videoHeight", height],
      ] as const) {
        if (descriptor) Object.defineProperty(HTMLVideoElement.prototype, name, descriptor);
        else delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)[name];
      }
    },
  };
}

describe("segmentFrame", () => {
  it("sends the frame's bytes and reads the mask back", async () => {
    const mask = new Uint8Array(MASK_SIZE * MASK_SIZE).fill(200);
    const sent: unknown[] = [];
    mockCommands({
      webcam_segment: (frame) => {
        sent.push(frame);
        return mask.buffer;
      },
    });
    const frame = new Uint8ClampedArray(MASK_SIZE * MASK_SIZE * 4).fill(3);
    const reply = await segmentFrame(frame);
    expect(reply).toEqual(mask);
    expect(sent[0]).toBeInstanceOf(Uint8Array);
    expect((sent[0] as Uint8Array).byteLength).toBe(MASK_SIZE * MASK_SIZE * 4);
  });
});

describe("blurPixels", () => {
  it("blurs up to 24px, from a hint at 1%", () => {
    expect(blurPixels(100)).toBe(24);
    expect(blurPixels(50)).toBe(12);
    expect(blurPixels(1)).toBe(0.2);
    expect(blurPixels(0)).toBe(0.2);
    expect(blurPixels(500)).toBe(24);
  });
});

describe("startSegmenting", () => {
  let frames: ReturnType<typeof fakeFrames> | null = null;

  afterEach(() => {
    frames?.restore();
    frames = null;
  });

  it("cuts the person out of the frame that was segmented", async () => {
    frames = fakeFrames();
    const contexts: ReturnType<typeof fakeContext>[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      const context = fakeContext();
      contexts.push(context);
      return context as unknown as CanvasRenderingContext2D;
    });
    const video = document.createElement("video");
    const person = document.createElement("canvas");
    const drawn = vi.fn();
    const mask = new Uint8Array(MASK_SIZE * MASK_SIZE).fill(255);
    const segment = vi.fn(() => Promise.resolve(mask));
    const stop = startSegmenting(video, person, { onDrawn: drawn, onFailed: vi.fn(), segment });
    frames.next();
    await waitFor(() => expect(drawn).toHaveBeenCalledTimes(1));
    expect(segment).toHaveBeenCalledWith(expect.any(Uint8ClampedArray));
    expect([person.width, person.height]).toEqual([640, 480]);
    // The small, sent, mask and person canvases, in that order.
    const [, sent, masks, cutOut] = contexts;
    expect(sent.drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 480);
    expect(masks.putImageData).toHaveBeenCalledTimes(1);
    const alpha = masks.putImageData.mock.calls[0][0] as { data: Uint8ClampedArray };
    expect(alpha.data[3]).toBe(255);
    expect(cutOut.drawImage).toHaveBeenCalledTimes(2);
    expect(cutOut.globalCompositeOperation).toBe("source-over");
    stop();
    expect(frames.cancelled()).toBe(1);
  });

  it("fails at once without a canvas to draw on", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const failed = vi.fn();
    const segment = vi.fn();
    startSegmenting(document.createElement("video"), document.createElement("canvas"), {
      onDrawn: vi.fn(),
      onFailed: failed,
      segment,
    });
    expect(failed).toHaveBeenCalledTimes(1);
    expect(segment).not.toHaveBeenCalled();
  });

  it("fails on a mask of the wrong size, and sends nothing more", async () => {
    frames = fakeFrames();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fakeContext() as unknown as CanvasRenderingContext2D,
    );
    const failed = vi.fn();
    const segment = vi.fn(() => Promise.resolve(new Uint8Array(4)));
    startSegmenting(document.createElement("video"), document.createElement("canvas"), {
      onDrawn: vi.fn(),
      onFailed: failed,
      segment,
    });
    frames.next();
    await waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
    frames.next();
    frames.next();
    expect(segment).toHaveBeenCalledTimes(1);
    expect(frames.waiting()).toBe(0);
  });

  it("waits for the video's first frame with a picture", () => {
    frames = fakeFrames();
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { get: () => 0, configurable: true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fakeContext() as unknown as CanvasRenderingContext2D,
    );
    const segment = vi.fn(() => Promise.resolve(new Uint8Array(MASK_SIZE * MASK_SIZE)));
    startSegmenting(document.createElement("video"), document.createElement("canvas"), {
      onDrawn: vi.fn(),
      onFailed: vi.fn(),
      segment,
    });
    frames.next();
    expect(segment).not.toHaveBeenCalled();
    expect(frames.waiting()).toBe(1);
  });

  it("falls back to animation frames where videos cannot call back per frame", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fakeContext() as unknown as CanvasRenderingContext2D,
    );
    const requested = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(5);
    const cancelled = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const stop = startSegmenting(document.createElement("video"), document.createElement("canvas"), {
      onDrawn: vi.fn(),
      onFailed: vi.fn(),
      segment: vi.fn(),
    });
    expect(requested).toHaveBeenCalledTimes(1);
    stop();
    expect(cancelled).toHaveBeenCalledWith(5);
  });
});

describe("WebcamBubble with a background", () => {
  let frames: ReturnType<typeof fakeFrames> | null = null;

  afterEach(() => {
    frames?.restore();
    frames = null;
  });

  /** Fakes the canvas, and `webcam_segment` answering with `answer`. Returns the frames it was sent. */
  function segmenting(answer: () => ArrayBuffer | Promise<ArrayBuffer>) {
    frames = fakeFrames();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => fakeContext() as unknown as CanvasRenderingContext2D,
    );
    const sent: unknown[] = [];
    mockCommands(
      {
        webcam_segment: (frame) => {
          sent.push(frame);
          return answer();
        },
      },
      { otherwise: () => null },
    );
    return sent;
  }

  const mask = () => new Uint8Array(MASK_SIZE * MASK_SIZE).fill(255).buffer;

  /** Waits `ms` of real time, letting every promise waiting before it settle. */
  const settle = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  it("keeps the pulse until the first mask is drawn, then blurs the room", async () => {
    const sent = segmenting(mask);
    media = fakeMedia();
    const { container } = render(<WebcamBubble options={{ ...SQUIRCLE, background: "blur", blur: 50 }} />);
    const bubble = screen.getByTestId("webcam");
    await waitFor(() => expect(bubble).toHaveAttribute("data-live", "true"));
    fireEvent.playing(container.querySelector("video")!);
    await act(() => settle(250));
    // Settled, but the room is never shown with a background chosen.
    expect(bubble).toHaveAttribute("data-shown", "false");
    expect(container.querySelector(".webcam-waiting")).not.toBeNull();

    act(() => frames!.next());
    await waitFor(() => expect(bubble).toHaveAttribute("data-shown", "true"));
    expect(sent).toHaveLength(1);
    expect(bubble).toHaveAttribute("data-background", "blur");
    expect(container.querySelector("video")).toHaveStyle({ filter: "blur(12px)" });
    expect(container.querySelector("canvas.webcam-person")).not.toBeNull();
    expect(container.querySelector(".webcam-backdrop")).toBeNull();
    expect(container.querySelector(".webcam-waiting")).toBeNull();
  });

  it("skips frames while one is being segmented", async () => {
    let reply: (mask: ArrayBuffer) => void = () => undefined;
    const sent = segmenting(() => new Promise<ArrayBuffer>((resolve) => (reply = resolve)));
    media = fakeMedia();
    render(<WebcamBubble options={{ ...SQUIRCLE, background: "color", color: "#336699" }} />);
    const bubble = screen.getByTestId("webcam");
    await waitFor(() => expect(bubble).toHaveAttribute("data-live", "true"));
    await waitFor(() => expect(frames!.waiting()).toBe(1));
    act(() => frames!.next());
    await waitFor(() => expect(sent).toHaveLength(1));
    act(() => frames!.next());
    act(() => frames!.next());
    expect(sent).toHaveLength(1);
    await act(async () => {
      reply(mask());
      await settle(0);
    });
    act(() => frames!.next());
    await waitFor(() => expect(sent).toHaveLength(2));
  });

  it("covers the room with the colour", async () => {
    segmenting(mask);
    media = fakeMedia();
    const { container } = render(<WebcamBubble options={{ ...SQUIRCLE, background: "color", color: "#336699" }} />);
    const bubble = screen.getByTestId("webcam");
    await waitFor(() => expect(frames!.waiting()).toBe(1));
    act(() => frames!.next());
    await waitFor(() => expect(bubble).toHaveAttribute("data-shown", "true"));
    expect(bubble).toHaveAttribute("data-background", "color");
    expect(container.querySelector(".webcam-backdrop")).toHaveStyle({ background: "#336699" });
    expect(container.querySelector("video")?.style.filter).toBe("");
  });

  it("shows the plain camera for good once segmenting fails", async () => {
    const sent = segmenting(() => {
      throw new Error("could not load the person segmentation model");
    });
    media = fakeMedia();
    const { container } = render(<WebcamBubble options={{ ...SQUIRCLE, background: "blur" }} />);
    const bubble = screen.getByTestId("webcam");
    await waitFor(() => expect(frames!.waiting()).toBe(1));
    act(() => frames!.next());
    await waitFor(() => expect(bubble).toHaveAttribute("data-background", "none"));
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("video")?.style.filter).toBe("");
    // The plain camera fades in as it would with no background.
    fireEvent.playing(container.querySelector("video")!);
    await waitFor(() => expect(bubble).toHaveAttribute("data-shown", "true"));
    // Nothing more is sent.
    act(() => frames!.next());
    expect(sent).toHaveLength(1);
    expect(frames!.waiting()).toBe(0);
  });

  it("segments nothing with no background", async () => {
    const sent = segmenting(mask);
    media = fakeMedia();
    const { container } = render(<WebcamBubble options={SQUIRCLE} />);
    await waitFor(() => expect(screen.getByTestId("webcam")).toHaveAttribute("data-live", "true"));
    expect(frames!.waiting()).toBe(0);
    expect(container.querySelector("canvas")).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
