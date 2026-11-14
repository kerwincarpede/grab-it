import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import RecordingEditor from "./RecordingEditor";

const PATH = "/shots/recordings/Grab-it 2026-03-07 09-05-01.mp4";

interface Backend {
  calls: { cmd: string; payload?: InvokeArgs }[];
}

function mockBackend(edits: unknown = null): Backend {
  const backend: Backend = { calls: [] };
  mockConvertFileSrc("linux");
  mockIPC((cmd, payload) => {
    backend.calls.push({ cmd, payload });
    switch (cmd) {
      case "recording_info":
        return { path: PATH, fileName: "Grab-it 2026-03-07 09-05-01.mp4", edits, fps: 60 };
      case "get_editor_preferences":
        return {};
      case "recording_save_edits":
        return null;
      default:
        return null;
    }
  });
  return backend;
}

const saved = (backend: Backend) => backend.calls.filter((call) => call.cmd === "recording_save_edits").map((call) => (call.payload as { edits: unknown }).edits);

/** Loads a 12-second 1920×1080 recording into the page's video. */
async function loadVideo(): Promise<HTMLVideoElement> {
  const video = await waitFor(() => {
    const found = screen.getByTestId("recording-stage").querySelector("video");
    if (!found) throw new Error("the video has not loaded yet");
    return found;
  });
  Object.defineProperty(video, "duration", { configurable: true, value: 12 });
  Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
  fireEvent.loadedMetadata(video);
  await screen.findByText("Clip 0:12.0");
  return video;
}

describe("RecordingEditor", () => {
  it("plays the recording from the grab-it-video scheme", async () => {
    mockBackend();
    render(<RecordingEditor />);
    const video = await loadVideo();
    expect(video.getAttribute("src")).toBe(`grab-it-video://localhost/${encodeURIComponent(PATH)}`);
    expect(screen.getByText("Output 1920×1080")).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Trim start" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("slider", { name: "Trim end" })).toHaveAttribute("aria-valuenow", "12000");
  });

  it("saves a trim when a handle is let go", async () => {
    const backend = mockBackend();
    render(<RecordingEditor />);
    await loadVideo();
    const start = screen.getByRole("slider", { name: "Trim start" });
    fireEvent.keyDown(start, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(start, { key: "ArrowRight" });
    await waitFor(() => expect(saved(backend)).toEqual([{ version: 1, trim: { startMs: 1000, endMs: 12_000 } }]));
    expect(screen.getByText("Clip 0:11.0")).toBeInTheDocument();
    await screen.findByText("Edits saved");
  });

  it("opens with the saved trim and backdrop", async () => {
    mockBackend({
      version: 1,
      trim: { startMs: 2000, endMs: 9500 },
      backdrop: { fill: "ocean", padding: 64, radius: 36, radiusUnit: "pt", shadow: true, aspect: "9:16" },
    });
    render(<RecordingEditor />);
    await loadVideo();
    expect(screen.getByRole("slider", { name: "Trim start" })).toHaveAttribute("aria-valuenow", "2000");
    expect(screen.getByRole("slider", { name: "Trim end" })).toHaveAttribute("aria-valuenow", "9500");
    expect(screen.getByText("Clip 0:07.5")).toBeInTheDocument();
    expect(screen.getByText("Output 1080×1920")).toBeInTheDocument();
  });

  it("puts the recording on a backdrop, shaped 9:16", async () => {
    const backend = mockBackend();
    render(<RecordingEditor />);
    await loadVideo();
    await userEvent.click(screen.getByRole("button", { name: "Backdrop" }));
    await userEvent.click(screen.getByRole("button", { name: "Sunset gradient" }));
    await userEvent.click(screen.getByRole("button", { name: "9:16" }));
    expect(screen.getByText("Output 1080×1920")).toBeInTheDocument();
    await waitFor(() =>
      expect(saved(backend).at(-1)).toEqual({ version: 1, backdrop: expect.objectContaining({ fill: "sunset", aspect: "9:16" }) }),
    );
  });

  it("never writes over edits it cannot read", async () => {
    const backend = mockBackend({ version: 7 });
    render(<RecordingEditor />);
    await loadVideo();
    expect(screen.getByRole("status")).toHaveTextContent("cannot be read");
    const end = screen.getByRole("slider", { name: "Trim end" });
    fireEvent.keyDown(end, { key: "ArrowLeft" });
    fireEvent.keyUp(end, { key: "ArrowLeft" });
    expect(screen.getByText("Clip 0:11.9")).toBeInTheDocument();
    expect(saved(backend)).toEqual([]);
  });
});
