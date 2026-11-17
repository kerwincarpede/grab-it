import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecordingEditor from "./RecordingEditor";

vi.mock("./sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sources")>();
  // jsdom loads no video, so each recording's metadata is made up here.
  return { ...actual, probeVideo: vi.fn((path: string) => Promise.resolve(path.includes("Other") ? { durationMs: 6000, width: 720, height: 720 } : { durationMs: 12_000, width: 1920, height: 1080 })) };
});

const PATH = "/shots/recordings/Grab-it 2026-03-07 09-05-01.mp4";
const OWN = "Grab-it 2026-03-07 09-05-01.mp4";
const OTHER = "Other take.mp4";
const OTHER_PATH = "/shots/recordings/Other take.mp4";
/** What the file picker gives next. */
let picked: string | null = null;
/** Recordings `recording_source` refuses, as if gone. */
let gone: string[] = [];

interface Backend {
  calls: { cmd: string; payload?: InvokeArgs; headers?: Record<string, string> }[];
  /** What `recording_export` resolves or rejects with, once the test says. */
  exported?: { resolve: (path: string) => void; reject: (err: string) => void };
}

function mockBackend(edits: unknown = null, cursor: unknown = null, audio: string[] = []): Backend {
  const backend: Backend = { calls: [] };
  mockConvertFileSrc("linux");
  mockIPC(
    (cmd, payload) => {
      backend.calls.push({ cmd, payload });
      switch (cmd) {
      case "recording_info":
        return { path: PATH, fileName: "Grab-it 2026-03-07 09-05-01.mp4", edits, fps: 60, cursor, audio };
      case "get_editor_preferences":
        return {};
      case "recording_save_edits":
        return null;
      case "plugin:dialog|open":
        return picked;
      case "recording_source": {
        const name = (payload as { fileName: string }).fileName;
        if (gone.includes(name)) return Promise.reject(`${name} is not in the recordings folder`);
        return { path: `/shots/recordings/${name}`, fileName: name, fps: 30, cursor: null, hasAudio: true };
      }
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
  picked = null;
  gone = [];
});

const saved = (backend: Backend) => backend.calls.filter((call) => call.cmd === "recording_save_edits").map((call) => (call.payload as { edits: unknown }).edits);
const lastSaved = (backend: Backend) => saved(backend)[saved(backend).length - 1];

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

/** Gives `element` a box on screen, as jsdom lays nothing out. */
function placeAt(element: Element, width: number, height: number) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height, toJSON: () => ({}) } as DOMRect);
}

const AREA_ZOOM = { id: "z1", startMs: 2000, endMs: 4000, scale: 2, focus: { kind: "area", x: 0.5, y: 0.5 } };

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
    expect(plan).toEqual({
      clips: [{ source: OWN, startMs: 1500, endMs: 6000, sourceWidth: 1920, sourceHeight: 1080, x: 0, y: 0, width: 1920, height: 1080, zooms: [] }],
      width: 1920,
      height: 1080,
      x: 0,
      y: 0,
      videoWidth: 1920,
      videoHeight: 1080,
      backdropBytes: 0,
    });
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
    expect(plan).toEqual({
      clips: [{ source: OWN, startMs: 2000, endMs: 9500, sourceWidth: 1920, sourceHeight: 1080, x: 0, y: 0, width: 1012, height: 570, zooms: [] }],
      width: 1080,
      height: 1920,
      x: 34,
      y: 676,
      videoWidth: 1012,
      videoHeight: 570,
      backdropBytes: 3,
    });
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

  it("adds an area zoom at the playhead and picks its area on the preview", async () => {
    const backend = mockBackend();
    render(<RecordingEditor />);
    await loadVideo();
    await userEvent.click(screen.getByRole("button", { name: "Zoom" }));
    const added = { id: expect.any(String), startMs: 0, endMs: 2000, scale: 2, focus: { kind: "area", x: 0.5, y: 0.5 } };
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, zooms: [added] }));
    expect(screen.getByRole("button", { name: /^Area zoom 2×, 0:00.0 to 0:02.0/ })).toBeInTheDocument();
    // Paused with an area zoom chosen: the whole frame shows, with the area on it.
    const picker = screen.getByTestId("zoom-picker");
    placeAt(picker, 400, 200);
    fireEvent.pointerDown(picker, { clientX: 390, clientY: 20 });
    fireEvent.pointerUp(picker, { clientX: 390, clientY: 20 });
    // Kept inside the frame: the top-right quarter.
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, zooms: [{ ...added, focus: { kind: "area", x: 0.75, y: 0.25 } }] }));
    expect(screen.getByTestId("zoom-area")).toHaveStyle({ left: "50%", top: "0%", width: "50%", height: "50%" });
  });

  it("moves, resizes and deletes a zoom on the timeline", async () => {
    const backend = mockBackend({ version: 1, zooms: [AREA_ZOOM] });
    render(<RecordingEditor />);
    await loadVideo();
    // 100 ms a pixel.
    placeAt(screen.getByTestId("zoom-track"), 120, 26);
    const segment = screen.getByTestId("zoom-segment");
    fireEvent.pointerDown(segment, { clientX: 25 });
    fireEvent.pointerMove(segment, { clientX: 45 });
    fireEvent.pointerUp(segment, { clientX: 45 });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, zooms: [{ ...AREA_ZOOM, startMs: 4000, endMs: 6000 }] }));

    const end = screen.getByTestId("zoom-edge-end");
    fireEvent.pointerDown(end, { clientX: 60 });
    fireEvent.pointerMove(end, { clientX: 90 });
    fireEvent.pointerUp(end, { clientX: 90 });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, zooms: [{ ...AREA_ZOOM, startMs: 4000, endMs: 9000 }] }));

    fireEvent.keyDown(screen.getByTestId("zoom-segment"), { key: "Delete" });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
    expect(screen.queryByTestId("zoom-segment")).not.toBeInTheDocument();
  });

  it("follows the cursor only when the recording has a pointer track", async () => {
    const backend = mockBackend({ version: 1, zooms: [AREA_ZOOM] }, { fps: 60, points: [[0.2, 0.3]] });
    render(<RecordingEditor />);
    await loadVideo();
    act(() => screen.getByTestId("zoom-segment").focus());
    await userEvent.click(screen.getByRole("button", { name: "Follow cursor" }));
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, zooms: [{ ...AREA_ZOOM, focus: { kind: "cursor" } }] }));
    expect(screen.queryByTestId("zoom-picker")).not.toBeInTheDocument();
    // Back to an area: it starts where the pointer was.
    await userEvent.click(screen.getByRole("button", { name: "Area" }));
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, zooms: [{ ...AREA_ZOOM, focus: { kind: "area", x: 0.25, y: 0.3 } }] }));
  });

  it("offers no cursor zoom without a pointer track", async () => {
    mockBackend({ version: 1, zooms: [AREA_ZOOM] });
    render(<RecordingEditor />);
    await loadVideo();
    act(() => screen.getByTestId("zoom-segment").focus());
    expect(screen.getByRole("button", { name: "Follow cursor" })).toBeDisabled();
  });

  it("shows the zoom in the preview at its time", async () => {
    mockBackend({ version: 1, zooms: [AREA_ZOOM] });
    render(<RecordingEditor />);
    const video = await loadVideo();
    expect(video.style.transform).toBe("none");
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 3 });
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(video.style.transform).toContain("scale(2)"));
  });

  it("undoes and redoes a trim from the top bar, saving each step", async () => {
    const backend = mockBackend();
    render(<RecordingEditor />);
    await loadVideo();
    const undoButton = screen.getByRole("button", { name: "Undo" });
    const redoButton = screen.getByRole("button", { name: "Redo" });
    expect(undoButton).toBeDisabled();
    expect(redoButton).toBeDisabled();

    const start = screen.getByRole("slider", { name: "Trim start" });
    fireEvent.keyDown(start, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(start, { key: "ArrowRight" });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, trim: { startMs: 1000, endMs: 12_000 } }));
    expect(undoButton).toBeEnabled();

    await userEvent.click(undoButton);
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
    expect(screen.getByRole("slider", { name: "Trim start" })).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
    expect(undoButton).toBeDisabled();
    expect(redoButton).toBeEnabled();

    await userEvent.click(redoButton);
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, trim: { startMs: 1000, endMs: 12_000 } }));
    expect(screen.getByRole("slider", { name: "Trim start" })).toHaveAttribute("aria-valuenow", "1000");
    expect(redoButton).toBeDisabled();
    expect(saved(backend)).toHaveLength(3);
  });

  it("undoes and redoes a backdrop with the keys", async () => {
    const backend = mockBackend();
    render(<RecordingEditor />);
    await loadVideo();
    await userEvent.click(screen.getByRole("button", { name: "Backdrop" }));
    await userEvent.click(screen.getByRole("button", { name: "Sunset gradient" }));
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, backdrop: expect.objectContaining({ fill: "sunset" }) }));

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
    expect(screen.getByTestId("recording-stage")).not.toHaveAttribute("data-framed");

    fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, backdrop: expect.objectContaining({ fill: "sunset" }) }));
    expect(screen.getByTestId("recording-stage")).toHaveAttribute("data-framed", "true");

    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
    fireEvent.keyDown(document.body, { key: "y", ctrlKey: true });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, backdrop: expect.objectContaining({ fill: "sunset" }) }));
  });

  it("undoes adding a zoom and drops the redo on a new edit", async () => {
    const backend = mockBackend({ version: 1, zooms: [AREA_ZOOM] });
    render(<RecordingEditor />);
    await loadVideo();
    await userEvent.click(screen.getByRole("button", { name: "Zoom" }));
    const added = { id: expect.any(String), startMs: 0, endMs: 2000, scale: 2, focus: { kind: "area", x: 0.5, y: 0.5 } };
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, zooms: [added, AREA_ZOOM] }));
    expect(screen.getAllByTestId("zoom-segment")).toHaveLength(2);

    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, zooms: [AREA_ZOOM] }));
    expect(screen.getAllByTestId("zoom-segment")).toHaveLength(1);
    // Nothing earlier to undo: the sidecar as it opened is the oldest step.
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();

    fireEvent.keyDown(screen.getByTestId("zoom-segment"), { key: "Delete" });
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, zooms: [AREA_ZOOM] }));
  });

  describe("names the recording's sound in the status bar", () => {
    it("lists each source kept apart", async () => {
      mockBackend(null, null, ["microphone", "system"]);
      render(<RecordingEditor />);
      expect(await screen.findByText("Microphone · System sound")).toBeInTheDocument();
      expect(screen.queryByText("Mixed sound")).not.toBeInTheDocument();
    });

    it("says why mixed sound can only be edited together", async () => {
      mockBackend(null, null, ["mixed"]);
      render(<RecordingEditor />);
      expect(await screen.findByText("Mixed sound")).toHaveAttribute(
        "title",
        "This recording's microphone and system sound are mixed into one track, so they can only be edited together.",
      );
    });

    it("says nothing for a silent recording", async () => {
      mockBackend();
      render(<RecordingEditor />);
      await screen.findByText("Grab-it 2026-03-07 09-05-01.mp4");
      expect(screen.queryByText(/Microphone|System sound|Mixed sound/)).not.toBeInTheDocument();
    });
  });

  describe("joining recordings", () => {
    const JOINED = {
      version: 2,
      clips: [
        { id: "a", source: OWN, startMs: 1000, endMs: 5000 },
        { id: "b", source: OTHER, startMs: 0, endMs: 6000 },
      ],
    };

    /** Loads the opened recording into the video when the sequence starts with it. */
    async function loadJoined(clips = 2): Promise<HTMLVideoElement> {
      const video = await waitFor(() => {
        const found = screen.getByTestId("recording-stage").querySelector("video");
        if (!found) throw new Error("the video has not loaded yet");
        return found;
      });
      Object.defineProperty(video, "duration", { configurable: true, value: 12 });
      Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
      Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
      fireEvent.loadedMetadata(video);
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(clips));
      return video;
    }

    it("adds a recording from the recordings folder after the clip under the playhead, and undoes it", async () => {
      const backend = mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      picked = OTHER_PATH;
      await userEvent.click(screen.getByRole("button", { name: "Recording" }));
      await waitFor(() =>
        expect(lastSaved(backend)).toEqual({
          version: 2,
          clips: [
            { id: "own", source: OWN, startMs: 0, endMs: 12_000 },
            { id: expect.any(String), source: OTHER, startMs: 0, endMs: 6000 },
          ],
        }),
      );
      expect(screen.getAllByRole("option")).toHaveLength(2);
      expect(screen.getByText("2 clips, 0:18.0")).toBeInTheDocument();
      // The trim handles give way to each clip's edges.
      expect(screen.queryByRole("slider", { name: "Trim start" })).not.toBeInTheDocument();

      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
      expect(screen.queryAllByRole("option")).toHaveLength(0);
    });

    it("refuses a recording from outside the recordings folder", async () => {
      const backend = mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      picked = "/home/me/Downloads/Other take.mp4";
      await userEvent.click(screen.getByRole("button", { name: "Recording" }));
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Only recordings in the recordings folder can be added."));
      expect(saved(backend)).toEqual([]);
      expect(backend.calls.some((call) => call.cmd === "recording_source")).toBe(false);
    });

    it("reopens a joined sequence and reorders it with Alt and the arrow keys, undoably", async () => {
      const backend = mockBackend(JOINED);
      render(<RecordingEditor />);
      await loadJoined();
      expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-label"))).toEqual([`${OWN}, 0:04.0`, `${OTHER}, 0:06.0`]);
      fireEvent.focus(screen.getByRole("option", { name: `${OTHER}, 0:06.0` }));
      fireEvent.keyDown(document.body, { key: "ArrowLeft", altKey: true });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [JOINED.clips[1], JOINED.clips[0]] }));
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-label", `${OTHER}, 0:06.0`);

      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual(JOINED));
    });

    it("removes a clip, but never the last", async () => {
      const backend = mockBackend(JOINED);
      render(<RecordingEditor />);
      await loadJoined();
      fireEvent.focus(screen.getByRole("option", { name: `${OWN}, 0:04.0` }));
      fireEvent.keyDown(document.body, { key: "Delete" });
      // Another recording alone is still a sequence.
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [JOINED.clips[1]] }));
      fireEvent.focus(screen.getByRole("option"));
      fireEvent.keyDown(document.body, { key: "Delete" });
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(saved(backend)).toHaveLength(1);
    });

    it("exports each clip fitted in the opened recording's box with its own zooms", async () => {
      const zoom = { id: "z2", source: OTHER, startMs: 1000, endMs: 3000, scale: 2, focus: { kind: "area", x: 0.5, y: 0.5 } };
      const backend = mockBackend({ ...JOINED, zooms: [zoom] });
      render(<RecordingEditor />);
      await loadJoined();
      await waitFor(() => expect(screen.getByRole("button", { name: "Export" })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      const { plan } = await exportCall(backend);
      expect(plan).toEqual({
        clips: [
          { source: OWN, startMs: 1000, endMs: 5000, sourceWidth: 1920, sourceHeight: 1080, x: 0, y: 0, width: 1920, height: 1080, zooms: [] },
          { source: OTHER, startMs: 0, endMs: 6000, sourceWidth: 720, sourceHeight: 720, x: 420, y: 0, width: 1080, height: 1080, zooms: [{ id: "z2", startMs: 1000, endMs: 3000, scale: 2, focus: { kind: "area", x: 0.5, y: 0.5 } }] },
        ],
        width: 1920,
        height: 1080,
        x: 0,
        y: 0,
        videoWidth: 1920,
        videoHeight: 1080,
        backdropBytes: 0,
      });
    });

    it("trims a clip by dragging its edge, undoably", async () => {
      const backend = mockBackend(JOINED);
      render(<RecordingEditor />);
      await loadJoined();
      // 10 s over 100 px: 100 ms a pixel, kept from when the drag began.
      placeAt(screen.getByRole("listbox", { name: "Clips" }), 100, 26);
      const edge = screen.getByRole("option", { name: `${OTHER}, 0:06.0` }).querySelector(".clip-edge.end") as HTMLElement;
      fireEvent.pointerDown(edge, { clientX: 100 });
      fireEvent.pointerMove(edge, { clientX: 90 });
      fireEvent.pointerMove(edge, { clientX: 80 });
      fireEvent.pointerUp(edge, { clientX: 80 });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [JOINED.clips[0], { ...JOINED.clips[1], endMs: 4000 }] }));
      expect(saved(backend)).toHaveLength(1);

      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual(JOINED));
    });

    it("reorders a clip by dragging it, undoably", async () => {
      const backend = mockBackend(JOINED);
      render(<RecordingEditor />);
      await loadJoined();
      placeAt(screen.getByRole("listbox", { name: "Clips" }), 100, 26);
      const first = screen.getByRole("option", { name: `${OWN}, 0:04.0` });
      fireEvent.pointerDown(first, { clientX: 10 });
      fireEvent.pointerMove(first, { clientX: 90 });
      fireEvent.pointerUp(first, { clientX: 90 });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [JOINED.clips[1], JOINED.clips[0]] }));

      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual(JOINED));
    });

    it("plays on into the next clip when the first runs to its recording's end", async () => {
      const clips = [
        { id: "a", source: OWN, startMs: 8000, endMs: 12_000 },
        { id: "b", source: OWN, startMs: 0, endMs: 2000 },
      ];
      mockBackend({ version: 2, clips });
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      render(<RecordingEditor />);
      const video = await loadJoined();
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.play(video);
      // The video stops on its last frame, short of the clip's 12 s end.
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 11.98 });
      Object.defineProperty(video, "ended", { configurable: true, value: true });
      Object.defineProperty(video, "paused", { configurable: true, value: true });
      fireEvent.pause(video);
      fireEvent.ended(video);
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
      act(() => frames.splice(0).forEach((frame) => frame(0)));
      // On to the second clip's start, playing again.
      expect(video.currentTime).toBe(0);
      expect(play).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    });

    it("gives a zoom in two clips of one recording to the first only, in the preview and the export", async () => {
      const zoom = { id: "z3", startMs: 2500, endMs: 3500, scale: 2, focus: { kind: "area", x: 0.5, y: 0.5 } };
      const backend = mockBackend({
        version: 2,
        clips: [
          { id: "a", source: OWN, startMs: 1000, endMs: 5000 },
          { id: "c", source: OWN, startMs: 2000, endMs: 6000 },
        ],
        zooms: [zoom],
      });
      render(<RecordingEditor />);
      await loadJoined();
      expect(screen.getAllByTestId("zoom-segment")).toHaveLength(1);
      await waitFor(() => expect(screen.getByRole("button", { name: "Export" })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      const { plan } = await exportCall(backend);
      expect((plan as { clips: { zooms: unknown[] }[] }).clips.map((clip) => clip.zooms)).toEqual([[zoom], []]);
    });

    it("on Linux gives each visit to a recording a fresh element and object URL, from a Blob fetched once", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)");
      const fetcher = vi.fn(async () => new Response(new Uint8Array(4), { status: 200 }));
      vi.stubGlobal("fetch", fetcher);
      let made = 0;
      const minted: Blob[] = [];
      const createObjectURL = vi.fn((blob: Blob) => {
        minted.push(blob);
        return `blob:tauri://localhost/${++made}`;
      });
      const revokeObjectURL = vi.fn();
      Object.assign(URL, { createObjectURL, revokeObjectURL });
      mockBackend(JOINED);
      const stageVideo = () => screen.getByTestId("recording-stage").querySelector("video");
      const { unmount } = render(<RecordingEditor />);
      const first = await loadJoined();
      expect(first.getAttribute("src")).toBe("blob:tauri://localhost/1");
      // 10 s over 100 px: 6 s is 2 s into the other recording.
      const track = screen.getByTestId("timeline-track");
      placeAt(track, 100, 26);
      fireEvent.pointerDown(track, { clientX: 60 });
      fireEvent.pointerUp(track, { clientX: 60 });
      const second = await waitFor(() => {
        const found = stageVideo();
        if (!found || found === first) throw new Error("still the first recording's element");
        return found;
      });
      expect(second.dataset.source).toBe(OTHER);
      expect(second.getAttribute("src")).toBe("blob:tauri://localhost/2");
      expect(second.hasAttribute("crossorigin")).toBe(false);
      // Its loadedmetadata goes unseen: the first frame still applies the seek.
      Object.defineProperty(second, "currentTime", { configurable: true, writable: true, value: 0 });
      Object.defineProperty(second, "duration", { configurable: true, value: 8 });
      Object.defineProperty(second, "videoWidth", { configurable: true, value: 720 });
      Object.defineProperty(second, "videoHeight", { configurable: true, value: 720 });
      fireEvent.canPlay(second);
      expect(second.currentTime).toBe(2);
      // The first element's URL goes with it.
      expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(["blob:tauri://localhost/1"]);

      // Back in the opened recording: a new element and URL from the kept Blob, not fetched again.
      fireEvent.pointerDown(track, { clientX: 10 });
      fireEvent.pointerUp(track, { clientX: 10 });
      await waitFor(() => expect(stageVideo()?.getAttribute("src")).toBe("blob:tauri://localhost/3"));
      expect(stageVideo()).not.toBe(first);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(minted[2]).toBe(minted[0]);
      expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(["blob:tauri://localhost/1", "blob:tauri://localhost/2"]);
      unmount();
      expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(["blob:tauri://localhost/1", "blob:tauri://localhost/2", "blob:tauri://localhost/3"]);
      vi.unstubAllGlobals();
    });

    it("marks a recording that is gone and holds Export back", async () => {
      gone = [OTHER];
      mockBackend(JOINED);
      render(<RecordingEditor />);
      await loadJoined();
      await waitFor(() => expect(screen.getByRole("option", { name: `${OTHER} (missing), 0:06.0` })).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    });
  });
});
