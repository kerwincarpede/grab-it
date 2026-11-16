import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEBCAM_SHAPES } from "../settings/api";
import WebcamBubble from "./WebcamBubble";
import { cameraConstraints, cameraProblem, webcamOptions, type WebcamOptions } from "./api";
import { SHAPE_OUTLINES, shapeOutline } from "./shapes";
import { camera, fakeMedia, type FakeMedia } from "./testMedia";

const SQUIRCLE: WebcamOptions = { shape: "squircle", mirror: true, camera: null };

let media: FakeMedia | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

describe("webcamOptions", () => {
  it("reads the shape, the mirroring and the camera from the hash", () => {
    expect(webcamOptions("#/webcam?shape=arch&mirror=0&camera=a%20b%2Fc%2Bd%3D%C3%A9")).toEqual({
      shape: "arch",
      mirror: false,
      camera: "a b/c+d=é",
    });
    expect(webcamOptions("#/webcam?shape=round")).toEqual({ shape: "round", mirror: true, camera: null });
    for (const { value } of WEBCAM_SHAPES) {
      expect(webcamOptions(`#/webcam?shape=${value}`).shape).toBe(value);
    }
  });

  it("is a mirrored squircle on the default camera when the hash says nothing it knows", () => {
    expect(webcamOptions("#/webcam")).toEqual(SQUIRCLE);
    expect(webcamOptions("#/webcam?shape=star&mirror=no&camera=")).toEqual(SQUIRCLE);
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
    mockIPC((cmd, payload) => {
      if (cmd === "remember_cameras") remembered.push((payload as { cameras: unknown }).cameras);
      return null;
    });
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
    const commands: string[] = [];
    mockIPC((cmd) => {
      commands.push(cmd);
      return null;
    });
    media = fakeMedia({ devices: [camera("cam-1", "")] });
    render(<WebcamBubble options={SQUIRCLE} />);
    await waitFor(() => expect(screen.getByTestId("webcam")).toHaveAttribute("data-live", "true"));
    await act(() => Promise.resolve());
    expect(commands).not.toContain("remember_cameras");
  });

  it("takes the chosen shape, unmirrored when asked", () => {
    media = fakeMedia();
    render(<WebcamBubble options={{ shape: "pill", mirror: false, camera: null }} />);
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
