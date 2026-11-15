import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecordingEditor from "./RecordingEditor";

const PATH = "/shots/recordings/Grab-it 2026-03-07 09-05-01.mp4";

interface Backend {
  calls: { cmd: string; payload?: InvokeArgs; headers?: Record<string, string> }[];
  /** What `recording_export` resolves or rejects with, once the test says. */
  exported?: { resolve: (path: string) => void; reject: (err: string) => void };
}

function mockBackend(edits: unknown = null): Backend {
  const backend: Backend = { calls: [] };
  mockConvertFileSrc("linux");
  mockIPC(
    (cmd, payload) => {
      backend.calls.push({ cmd, payload });
      switch (cmd) {
      case "recording_info":
        return { path: PATH, fileName: "Grab-it 2026-03-07 09-05-01.mp4", edits, fps: 60 };
      case "get_editor_preferences":
        return {};
      case "recording_save_edits":
        return null;
      case "recording_export":
        return new Promise<string>((resolve, reject) => {
          backend.exported = { resolve, reject };
        });
      default:
        return null;
      }
    },
    { shouldMockEvents: true },
  );
  // The mock leaves out the request headers; keep them with the call they came with.
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown> } })
    .__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  internals.invoke = (cmd, args, options) => {
    const result = invoke(cmd, args, options);
    const call = backend.calls[backend.calls.length - 1];
    if (call?.cmd === cmd && options?.headers) call.headers = options.headers;
    return result;
  };
  return backend;
}

/** The plan and body the page sent with Export. */
async function exportCall(backend: Backend) {
  const call = await waitFor(() => {
    const found = backend.calls.find((entry) => entry.cmd === "recording_export");
    if (!found || !backend.exported) throw new Error("not exported yet");
    return found;
  });
  const header = call.headers?.["x-recording-export"] ?? "";
  return { plan: JSON.parse(decodeURIComponent(header)), body: Array.from(call.payload as unknown as Uint8Array) };
}

/** A canvas that records nothing and encodes each picture as the next of `pngs`. */
function stubCanvas(pngs: number[][]) {
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => ({ addColorStop: () => undefined })),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  let next = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob([new Uint8Array(pngs[next++] ?? [])]));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
  await waitFor(() => expect(screen.getByRole("slider", { name: "Trim end" })).toHaveAttribute("aria-valuemax", "12000"));
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
      expect(saved(backend)[saved(backend).length - 1]).toEqual({ version: 1, backdrop: expect.objectContaining({ fill: "sunset", aspect: "9:16" }) }),
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

  it("exports the trimmed recording alone when there is no backdrop", async () => {
    const backend = mockBackend({ version: 1, trim: { startMs: 1500, endMs: 6000 } });
    render(<RecordingEditor />);
    await loadVideo();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    const { plan, body } = await exportCall(backend);
    expect(plan).toEqual({ startMs: 1500, endMs: 6000, width: 1920, height: 1080, x: 0, y: 0, videoWidth: 1920, videoHeight: 1080, backdropBytes: 0 });
    expect(body).toEqual([]);

    await emit("recording-export-progress", { done: 135, total: 270 });
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "Export progress" })).toHaveAttribute("aria-valuenow", "50"));
    expect(screen.getByRole("status")).toHaveTextContent("Exporting… 50%");
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled();

    backend.exported?.resolve("/shots/recordings/Grab-it 2026-03-07 09-05-01 (edited).mp4");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Exported Grab-it 2026-03-07 09-05-01 (edited).mp4"));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("sends the backdrop and then the mask with a 9:16 export", async () => {
    stubCanvas([
      [1, 2, 3],
      [9, 9],
    ]);
    const backend = mockBackend({
      version: 1,
      trim: { startMs: 2000, endMs: 9500 },
      backdrop: { fill: "ocean", padding: 64, radius: 36, radiusUnit: "pt", shadow: true, aspect: "9:16" },
    });
    render(<RecordingEditor />);
    await loadVideo();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    const { plan, body } = await exportCall(backend);
    expect(plan).toEqual({ startMs: 2000, endMs: 9500, width: 1080, height: 1920, x: 34, y: 676, videoWidth: 1012, videoHeight: 570, backdropBytes: 3 });
    expect(body).toEqual([1, 2, 3, 9, 9]);
  });

  it("says why an export failed", async () => {
    const backend = mockBackend();
    render(<RecordingEditor />);
    await loadVideo();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await exportCall(backend);
    backend.exported?.reject("ffmpeg is not ready yet");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Export failed: ffmpeg is not ready yet"));
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });

  it("on Linux plays a blob of the whole file, fetched in ranges, and lets it go on close", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    const file = new Uint8Array(10).fill(7);
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const from = Number(/bytes=(\d+)-/.exec(new Headers(init?.headers).get("Range") ?? "")?.[1]);
      const to = Math.min(file.length, from + 6) - 1;
      return new Response(file.slice(from, to + 1), { status: 206, headers: { "Content-Range": `bytes ${from}-${to}/${file.length}` } });
    });
    vi.stubGlobal("fetch", fetcher);
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:tauri://localhost/recording-1";
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    mockBackend();
    const { unmount } = render(<RecordingEditor />);
    const video = await loadVideo();
    expect(video.getAttribute("src")).toBe("blob:tauri://localhost/recording-1");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `grab-it-video://localhost/${encodeURIComponent(PATH)}`,
      `grab-it-video://localhost/${encodeURIComponent(PATH)}`,
    ]);
    expect(created[0].size).toBe(10);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:tauri://localhost/recording-1");
    vi.unstubAllGlobals();
  });
});
