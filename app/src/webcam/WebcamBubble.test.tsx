import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import WebcamBubble from "./WebcamBubble";
import { cameraConstraints, cameraProblem, webcamOptions } from "./api";
import { fakeMedia, type FakeMedia } from "./testMedia";

let media: FakeMedia | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

describe("webcamOptions", () => {
  it("reads the shape and the camera from the hash", () => {
    expect(webcamOptions("#/webcam?shape=rounded&camera=a%20b%2Fc%2Bd%3D%C3%A9")).toEqual({
      shape: "rounded",
      camera: "a b/c+d=é",
    });
    expect(webcamOptions("#/webcam?shape=round")).toEqual({ shape: "round", camera: null });
  });

  it("is a round bubble on the default camera when the hash says nothing it knows", () => {
    expect(webcamOptions("#/webcam")).toEqual({ shape: "round", camera: null });
    expect(webcamOptions("#/webcam?shape=star&camera=")).toEqual({ shape: "round", camera: null });
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
  it("shows the chosen camera in a round bubble", async () => {
    media = fakeMedia();
    render(<WebcamBubble options={{ shape: "round", camera: "cam-1" }} />);
    const bubble = screen.getByTestId("webcam");
    expect(bubble).toHaveClass("webcam-round");
    expect(document.documentElement).toHaveClass("webcam-clear");
    await waitFor(() => expect(bubble).toHaveAttribute("data-live", "true"));
    expect(media.requests).toHaveLength(1);
    expect(media.requests[0].video).toMatchObject({ deviceId: { exact: "cam-1" } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is a rounded square when that shape is chosen", () => {
    media = fakeMedia();
    render(<WebcamBubble options={{ shape: "rounded", camera: null }} />);
    expect(screen.getByTestId("webcam")).toHaveClass("webcam-rounded");
  });

  it("falls back to the default camera when the chosen one is gone", async () => {
    media = fakeMedia({
      fail: { name: "OverconstrainedError", when: (constraints) => typeof constraints.video === "object" && "deviceId" in constraints.video },
    });
    render(<WebcamBubble options={{ shape: "round", camera: "unplugged" }} />);
    await waitFor(() => expect(screen.getByTestId("webcam")).toHaveAttribute("data-live", "true"));
    expect(media.requests).toHaveLength(2);
    expect(media.requests[1].video).not.toHaveProperty("deviceId");
  });

  it("says why when the camera cannot start", async () => {
    media = fakeMedia({ fail: { name: "NotAllowedError" } });
    render(<WebcamBubble options={{ shape: "round", camera: null }} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Camera not allowed");
    expect(screen.getByTestId("webcam")).toHaveAttribute("data-live", "false");
  });

  it("says so when the window has no camera access at all", async () => {
    render(<WebcamBubble options={{ shape: "round", camera: null }} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Camera unavailable");
  });

  it("stops the camera when it closes", async () => {
    media = fakeMedia();
    const { unmount } = render(<WebcamBubble options={{ shape: "round", camera: null }} />);
    await waitFor(() => expect(screen.getByTestId("webcam")).toHaveAttribute("data-live", "true"));
    unmount();
    expect(media.stopped).toBe(1);
    expect(document.documentElement).not.toHaveClass("webcam-clear");
  });
});
