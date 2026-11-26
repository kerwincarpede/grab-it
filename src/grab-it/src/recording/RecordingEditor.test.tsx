import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import RecordingEditor from "./RecordingEditor";
import type { AudioKind, Value } from "../app/bindings";
import { mockCommands, type CommandCall } from "../test/mockCommands";
import type { CursorPath } from "./zooms";
import type { RecordingPauses } from "./api";

vi.mock("./sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sources")>();
  // jsdom loads no video, so each recording's metadata is made up here.
  return { ...actual, probeVideo: vi.fn((path: string) => Promise.resolve(path.includes("Other") ? { durationMs: 6000, width: 720, height: 720 } : { durationMs: 12_000, width: 1920, height: 1080 })) };
});

const PATH = "/shots/recordings/Grab-it 2026-03-07 09-05-01.mp4";
const RECORDINGS = "/shots/recordings";
const OWN = "Grab-it 2026-03-07 09-05-01.mp4";
const OTHER = "Other take.mp4";
const OTHER_PATH = "/shots/recordings/Other take.mp4";
/** What the file picker gives next. */
let picked: string | null = null;
/** Recordings `recording_source` refuses, as if gone. */
let gone: string[] = [];
/** Recordings `recording_source` says keep their microphone apart. */
let separate: string[] = [];
/** What `recording_pauses` gives, or the error it rejects with; a function hears each threshold apart. */
let heard: RecordingPauses | string | ((noiseDb: number) => RecordingPauses | Promise<RecordingPauses>) = { sound: "microphone", pauses: [], canClean: true, pointer: null };
/** What `recording_audition` resolves with, when a test holds it back. */
let auditioned: (() => Promise<ArrayBuffer>) | null = null;
/** The sound sources `recording_source` says each other recording has. */
let sourceAudio: Record<string, AudioKind[]> = {};
/** 12 seconds of half-loud peaks, 100 a second. */
const PEAKS = () => new Uint8Array(1200).fill(128).buffer;
/** What `recording_waveform` gives for each recording and sound source. */
let waveform: (fileName: string, audio: number) => ArrayBuffer | Promise<ArrayBuffer> = PEAKS;

/** How the opened recording's sound was kept and whether noise was removed from it. */
interface Noise {
  removeNoise?: boolean;
  separateMicrophone?: boolean;
}

interface Backend {
  calls: (CommandCall & { headers?: Record<string, string> })[];
  /** What `recording_export` resolves or rejects with, once the test says. */
  exported?: { resolve: (path: string) => void; reject: (err: string) => void };
}

function mockBackend(edits: Value | null = null, cursor: CursorPath | null = null, audio: AudioKind[] = [], noise: Noise = {}, own = OWN): Backend {
  const backend: Backend = { calls: [] };
  mockConvertFileSrc("linux");
  const source = (name: string) => {
    if (gone.includes(name)) return Promise.reject(`${name} is not in the recordings folder`);
    return {
      path: `${RECORDINGS}/${name}`,
      fileName: name.slice(name.lastIndexOf("/") + 1),
      source: name,
      fps: 30,
      cursor: null,
      hasAudio: true,
      audio: sourceAudio[name] ?? [],
      removeNoise: false,
      separateMicrophone: separate.includes(name),
    };
  };
  backend.calls = mockCommands(
    {
      recording_info: () => ({
        path: `${RECORDINGS}/${own}`,
        fileName: own.slice(own.lastIndexOf("/") + 1),
        source: own,
        recordingsFolder: RECORDINGS,
        edits,
        fps: 60,
        cursor,
        audio,
        removeNoise: noise.removeNoise ?? false,
        separateMicrophone: noise.separateMicrophone ?? false,
      }),
      get_editor_preferences: () => ({}),
      recording_save_edits: () => null,
      recording_source: ({ fileName }) => source(fileName),
      recording_pick_source: ({ path }) => {
        if (!path.startsWith(`${RECORDINGS}/`)) return Promise.reject("Only recordings in the recordings folder can be added.");
        return source(path.slice(RECORDINGS.length + 1));
      },
      recording_export_cancel: () => undefined,
      recording_pauses: ({ noiseDb }) => (typeof heard === "function" ? heard(noiseDb) : typeof heard === "string" ? Promise.reject(heard) : heard),
      recording_audition: () => (auditioned ? auditioned() : new ArrayBuffer(4)),
      recording_waveform: ({ fileName, audio }) => waveform(fileName, audio),
      recording_export: () =>
        new Promise<string>((resolve, reject) => {
          backend.exported = { resolve, reject };
        }),
    },
    {
      shouldMockEvents: true,
      otherwise: (cmd) => (cmd === "plugin:dialog|open" ? picked : null),
    },
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
  separate = [];
  heard = { sound: "microphone", pauses: [], canClean: true, pointer: null };
  auditioned = null;
  sourceAudio = {};
  waveform = PEAKS;
});

const saved = (backend: Backend) => backend.calls.filter((call) => call.cmd === "recording_save_edits").map((call) => (call.payload as { edits: unknown }).edits);
const lastSaved = (backend: Backend) => saved(backend)[saved(backend).length - 1];

/** jsdom has no media decoder. Supply the metadata a loaded element would expose. */
function setVideoMetadata(video: HTMLVideoElement, duration: number, width: number, height: number) {
  Object.defineProperties(video, {
    readyState: { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA },
    duration: { configurable: true, value: duration },
    videoWidth: { configurable: true, value: width },
    videoHeight: { configurable: true, value: height },
  });
}

async function previewVideo(source: string): Promise<HTMLVideoElement> {
  return waitFor(() => {
    const video = Array.from(screen.getByTestId("recording-stage").querySelectorAll("video")).find((element) => element.dataset.source === source);
    if (!video) throw new Error(`Waiting for the preview of ${source}`);
    return video;
  });
}

/** Loads a 12-second 1920×1080 recording into the page's video. */
async function loadVideo(source = OWN): Promise<HTMLVideoElement> {
  const video = await previewVideo(source);
  setVideoMetadata(video, 12, 1920, 1080);
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
      removeNoise: false,
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
      removeNoise: false,
    });
    expect(body).toEqual([1, 2, 3, 9, 9]);
  });

  it("cancels this export and enables exporting again after cleanup", async () => {
    const backend = mockBackend();
    render(<RecordingEditor />);
    await loadVideo();
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await exportCall(backend);
    await emit("recording-export-progress", { done: 0, total: 100 });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(backend.calls.some(({ cmd }) => cmd === "recording_export_cancel")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    backend.exported?.reject("Export cancelled");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/^Export cancelled$/));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
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

  it("splits the recording at the playhead with S and the Split button, one undo step each", async () => {
    const backend = mockBackend();
    render(<RecordingEditor />);
    await loadVideo();
    // 12 s over 120 px: 100 ms a pixel.
    const track = screen.getByTestId("timeline-track");
    placeAt(track, 120, 26);
    // Within half a second of an edge, Split is off.
    fireEvent.pointerDown(track, { clientX: 3 });
    fireEvent.pointerUp(track, { clientX: 3 });
    expect(screen.getByRole("button", { name: "Split" })).toBeDisabled();
    fireEvent.keyDown(document.body, { key: "s" });
    expect(saved(backend)).toEqual([]);

    fireEvent.pointerDown(track, { clientX: 60 });
    fireEvent.pointerUp(track, { clientX: 60 });
    expect(screen.getByRole("button", { name: "Split" })).toBeEnabled();
    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() =>
      expect(lastSaved(backend)).toEqual({
        version: 2,
        clips: [
          { id: "own", source: OWN, startMs: 0, endMs: 6000 },
          { id: expect.any(String), source: OWN, startMs: 6000, endMs: 12_000 },
        ],
      }),
    );
    expect(screen.getAllByRole("option")).toHaveLength(2);
    // The playhead stays on the line between the two parts.
    expect(screen.getByLabelText("Time")).toHaveTextContent("0:06.0 / 0:12.0");

    // 12 s over 120 px still: split the second part at 9 s.
    const joinedTrack = screen.getByTestId("timeline-track");
    placeAt(joinedTrack, 120, 26);
    fireEvent.pointerDown(joinedTrack, { clientX: 90 });
    fireEvent.pointerUp(joinedTrack, { clientX: 90 });
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(saved(backend)).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("keeps zooms on their recording's time through a split and a gap, and exports without the cut", async () => {
    const zoom = { id: "z1", startMs: 7000, endMs: 8000, scale: 2, focus: { kind: "area", x: 0.5, y: 0.5 } };
    const backend = mockBackend({ version: 1, zooms: [zoom] });
    render(<RecordingEditor />);
    await loadVideo();
    const track = screen.getByTestId("timeline-track");
    placeAt(track, 120, 26);
    fireEvent.pointerDown(track, { clientX: 20 });
    fireEvent.pointerUp(track, { clientX: 20 });
    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const joinedTrack = screen.getByTestId("timeline-track");
    placeAt(joinedTrack, 120, 26);
    fireEvent.pointerDown(joinedTrack, { clientX: 40 });
    fireEvent.pointerUp(joinedTrack, { clientX: 40 });
    fireEvent.keyDown(document.body, { key: "s" });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    // Ripple delete the middle part, 2 s to 4 s.
    fireEvent.focus(screen.getAllByRole("option")[1]);
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() =>
      expect(lastSaved(backend)).toEqual({
        version: 2,
        clips: [
          { id: "own", source: OWN, startMs: 0, endMs: 2000 },
          { id: expect.any(String), source: OWN, startMs: 4000, endMs: 12_000 },
        ],
        zooms: [zoom],
      }),
    );
    expect(saved(backend)).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    const { plan } = await exportCall(backend);
    const entries = (plan as { clips: { startMs: number; endMs: number; zooms: unknown[] }[] }).clips;
    expect(entries.map((clip) => [clip.startMs, clip.endMs])).toEqual([
      [0, 2000],
      [4000, 12_000],
    ]);
    expect(entries[1].zooms).toEqual([zoom]);
  });

  describe("Remove background noise", () => {
    const toggle = () => screen.getByRole("button", { name: "Remove background noise" });
    const KEPT = { separateMicrophone: true };

    it("saves the toggle, undoably, and sends it with the export", async () => {
      const backend = mockBackend(null, null, ["microphone", "system"], KEPT);
      render(<RecordingEditor />);
      await loadVideo();
      expect(toggle()).toBeEnabled();
      expect(toggle()).toHaveAttribute("aria-pressed", "false");
      expect(toggle()).toHaveAttribute("title", "Remove background noise from the microphone when exporting. The preview plays as recorded.");

      await userEvent.click(toggle());
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, removeNoise: true }));
      expect(toggle()).toHaveAttribute("aria-pressed", "true");

      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
      expect(toggle()).toHaveAttribute("aria-pressed", "false");
      fireEvent.keyDown(document.body, { key: "Z", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(toggle()).toHaveAttribute("aria-pressed", "true"));

      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      const { plan } = await exportCall(backend);
      expect(plan.removeNoise).toBe(true);
    });

    it("follows how the opened recording was made until it is changed", async () => {
      const backend = mockBackend(null, null, ["microphone"], { ...KEPT, removeNoise: true });
      render(<RecordingEditor />);
      await loadVideo();
      expect(toggle()).toHaveAttribute("aria-pressed", "true");

      await userEvent.click(toggle());
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, removeNoise: false }));
      expect(toggle()).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      const { plan } = await exportCall(backend);
      expect(plan.removeNoise).toBe(false);
    });

    it("opens with the saved choice over the recording's own", async () => {
      const backend = mockBackend({ version: 1, removeNoise: false }, null, ["microphone"], { ...KEPT, removeNoise: true });
      render(<RecordingEditor />);
      await loadVideo();
      expect(toggle()).toHaveAttribute("aria-pressed", "false");
      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      const { plan } = await exportCall(backend);
      expect(plan.removeNoise).toBe(false);
    });

    it("is off for a recording that does not keep its microphone apart", async () => {
      const backend = mockBackend(null, null, ["mixed"]);
      render(<RecordingEditor />);
      await loadVideo();
      expect(toggle()).toBeDisabled();
      expect(toggle()).toHaveAttribute("aria-pressed", "false");
      expect(toggle()).toHaveAttribute("title", "Only newer recordings with a microphone can remove background noise");
      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      const { plan } = await exportCall(backend);
      expect(plan.removeNoise).toBe(false);
    });

    it("can be turned on when a joined clip keeps its microphone apart", async () => {
      separate = [OTHER];
      const backend = mockBackend({
        version: 2,
        clips: [
          { id: "a", source: OWN, startMs: 1000, endMs: 5000 },
          { id: "b", source: OTHER, startMs: 0, endMs: 6000 },
        ],
      });
      render(<RecordingEditor />);
      await waitFor(() => expect(toggle()).toBeEnabled());
      await userEvent.click(toggle());
      await waitFor(() => expect(lastSaved(backend)).toMatchObject({ version: 2, removeNoise: true }));
    });
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
      await screen.findByText("Grab-it 2026-03-07 09-05-01.mp4");
      const status = document.querySelector<HTMLElement>(".editor-status");
      expect(await within(status!).findByText("Mixed sound")).toHaveAttribute(
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

  describe("zooming the timeline", () => {
    const JOINED_ZOOM = {
      version: 2,
      clips: [
        { id: "a", source: OWN, startMs: 1000, endMs: 5000 },
        { id: "b", source: OTHER, startMs: 0, endMs: 6000 },
      ],
    };

    /** Loads the opened recording at the start of the 10 s JOINED_ZOOM sequence. */
    async function loadJoinedZoom() {
      const video = await previewVideo(OWN);
      setVideoMetadata(video, 12, 1920, 1080);
      fireEvent.loadedMetadata(video);
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    }

    /** Gives the timeline's scroller a 100 px track in view, with a scroll offset jsdom keeps. */
    function layOutTimeline(): HTMLElement {
      const scroller = screen.getByTestId("timeline-scroll");
      // 12 px of padding each side around a 100 px track.
      Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 124 });
      Object.defineProperty(scroller, "scrollLeft", { configurable: true, writable: true, value: 0 });
      placeAt(scroller, 124, 80);
      fireEvent.scroll(scroller);
      return scroller;
    }

    /** Gives `element` a box starting at `left`, as a zoomed and scrolled row has. */
    function spanAt(element: Element, left: number, width: number) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left, top: 0, x: left, y: 0, width, height: 26, right: left + width, bottom: 26, toJSON: () => ({}) } as DOMRect);
    }

    const zoomOf = () => screen.getByTestId("timeline-content").dataset.zoom;

    it("zooms in and out with the buttons around the playhead, and Fit shows it all", async () => {
      mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Fit" })).toBeDisabled();
      const scroller = layOutTimeline();
      // Seek to 6 s, half way along the fitted track.
      const track = screen.getByTestId("timeline-track");
      placeAt(track, 100, 40);
      fireEvent.pointerDown(track, { clientX: 50 });
      fireEvent.pointerUp(track, { clientX: 50 });

      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(zoomOf()).toBe("2");
      // The playhead stays 50 px into the view: 6 s is now 100 px along.
      expect(scroller.scrollLeft).toBe(50);
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(zoomOf()).toBe("4");
      expect(scroller.scrollLeft).toBe(150);
      await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
      expect(zoomOf()).toBe("2");
      expect(scroller.scrollLeft).toBe(50);

      await userEvent.click(screen.getByRole("button", { name: "Fit" }));
      expect(zoomOf()).toBe("1");
      expect(scroller.scrollLeft).toBe(0);
      expect(screen.getByRole("button", { name: "Fit" })).toBeDisabled();
    });

    it("stops at 400 px a second", async () => {
      mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      layOutTimeline();
      // 12 s over 100 px: 48x is 400 px a second.
      const zoomIn = screen.getByRole("button", { name: "Zoom in" });
      for (let i = 0; i < 6; i++) await userEvent.click(zoomIn);
      expect(zoomOf()).toBe("48");
      expect(zoomIn).toBeDisabled();
    });

    it("zooms with Ctrl or Cmd + wheel at the pointer, and leaves a plain wheel alone", async () => {
      mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      const scroller = layOutTimeline();
      fireEvent.wheel(scroller, { deltaY: -100, clientX: 37 });
      expect(zoomOf()).toBe("1");
      // 25 px into the track is 3 s; at 2x it is 50 px along, still under the pointer.
      fireEvent.wheel(scroller, { deltaY: -100, clientX: 37, ctrlKey: true });
      expect(zoomOf()).toBe("2");
      expect(scroller.scrollLeft).toBe(25);
      fireEvent.wheel(scroller, { deltaY: -100, clientX: 37, metaKey: true });
      expect(zoomOf()).toBe("4");
      expect(scroller.scrollLeft).toBe(75);
      fireEvent.wheel(scroller, { deltaY: 100, clientX: 37, ctrlKey: true });
      expect(zoomOf()).toBe("2");
      expect(scroller.scrollLeft).toBe(25);
    });

    it("adds small wheel moves up to one zoom step, as a trackpad sends them", async () => {
      mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      const scroller = layOutTimeline();
      fireEvent.wheel(scroller, { deltaY: -10, clientX: 37, ctrlKey: true });
      expect(zoomOf()).toBe("1");
      for (let i = 0; i < 9; i++) fireEvent.wheel(scroller, { deltaY: -10, clientX: 37, ctrlKey: true });
      expect(zoomOf()).toBe("2");
      // Three lines are about half a notch; seven make the next step.
      fireEvent.wheel(scroller, { deltaY: -3, deltaMode: 1, clientX: 37, metaKey: true });
      expect(zoomOf()).toBe("2");
      fireEvent.wheel(scroller, { deltaY: -4, deltaMode: 1, clientX: 37, metaKey: true });
      expect(zoomOf()).toBe("4");
      // Turning back drops what was left over the other way.
      fireEvent.wheel(scroller, { deltaY: 90, clientX: 37, ctrlKey: true });
      expect(zoomOf()).toBe("4");
      fireEvent.wheel(scroller, { deltaY: 10, clientX: 37, ctrlKey: true });
      expect(zoomOf()).toBe("2");
    });

    it("seeks, trims and drags zooms at the pointer while zoomed", async () => {
      const backend = mockBackend({ version: 1, zooms: [AREA_ZOOM] });
      render(<RecordingEditor />);
      await loadVideo();
      layOutTimeline();
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // At 2x the 12 s track is 200 px; scrolled 50 px, it starts off screen: 60 ms a pixel.
      const track = screen.getByTestId("timeline-track");
      spanAt(track, -50, 200);
      fireEvent.pointerDown(track, { clientX: 100 });
      fireEvent.pointerUp(track, { clientX: 100 });
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:09.0 / 0:12.0");

      const end = screen.getByRole("slider", { name: "Trim end" });
      fireEvent.pointerDown(end, { clientX: 150 });
      fireEvent.pointerMove(end, { clientX: 125 });
      fireEvent.pointerUp(end, { clientX: 125 });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, trim: { startMs: 0, endMs: 10_500 }, zooms: [AREA_ZOOM] }));

      // The zoom row is as wide as the track: 40 px is 2.4 s.
      spanAt(screen.getByTestId("zoom-track"), -50, 200);
      const segment = screen.getByTestId("zoom-segment");
      fireEvent.pointerDown(segment, { clientX: 0 });
      fireEvent.pointerMove(segment, { clientX: 40 });
      fireEvent.pointerUp(segment, { clientX: 40 });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, trim: { startMs: 0, endMs: 10_500 }, zooms: [{ ...AREA_ZOOM, startMs: 4400, endMs: 6400 }] }));

      // Its end edge goes to the pointer too: 150 px along is 9 s.
      const edge = screen.getByTestId("zoom-edge-end");
      fireEvent.pointerDown(edge, { clientX: 70 });
      fireEvent.pointerMove(edge, { clientX: 100 });
      fireEvent.pointerUp(edge, { clientX: 100 });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, trim: { startMs: 0, endMs: 10_500 }, zooms: [{ ...AREA_ZOOM, startMs: 4400, endMs: 9000 }] }));
    });

    it("zooms around the middle of the view when the playhead is out of it", async () => {
      mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      const scroller = layOutTimeline();
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // At 2x, scrolled to show 6 s to 12 s: the playhead at 0 is off to the left.
      scroller.scrollLeft = 100;
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // 9 s stays in the middle: 300 px along the 400 px track, 50 px into the view.
      expect(scroller.scrollLeft).toBe(250);
    });

    it("doesn't move the view under a scrub or a trim while playing, and follows again once let go", async () => {
      mockBackend();
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      render(<RecordingEditor />);
      const video = await loadVideo();
      const scroller = layOutTimeline();
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // 4x: the 400 px track starts 12 px into the scroller, less its scroll.
      const track = screen.getByTestId("timeline-track");
      vi.spyOn(track, "getBoundingClientRect").mockImplementation(() => {
        const left = 12 - scroller.scrollLeft;
        return { left, top: 0, x: left, y: 0, width: 400, height: 40, right: left + 400, bottom: 40, toJSON: () => ({}) } as DOMRect;
      });
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.play(video);
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

      // 95 px into the view is past where following would page on.
      fireEvent.pointerDown(track, { clientX: 107 });
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:02.8 / 0:12.0");
      fireEvent.pointerMove(track, { clientX: 111 });
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:02.9 / 0:12.0");
      fireEvent.pointerUp(track, { clientX: 111 });
      expect(scroller.scrollLeft).toBe(0);

      const start = screen.getByRole("slider", { name: "Trim start" });
      fireEvent.pointerDown(start, { clientX: 0 });
      fireEvent.pointerMove(start, { clientX: 108 });
      expect(start).toHaveAttribute("aria-valuenow", "2880");
      fireEvent.pointerMove(start, { clientX: 109 });
      expect(start).toHaveAttribute("aria-valuenow", "2910");
      fireEvent.pointerUp(start, { clientX: 109 });
      expect(scroller.scrollLeft).toBe(0);

      // Let go, the view follows again: 3.5 s is 117 px along, so it pages on to 10 px in.
      const runFrames = () => act(() => frames.splice(0).forEach((frame) => frame(0)));
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 3.5 });
      runFrames();
      expect(scroller.scrollLeft).toBe(107);

      // A press on an empty stretch of the zoom row let go outside the timeline doesn't stop it either.
      fireEvent.pointerDown(screen.getByTestId("zoom-track"), { clientX: 50 });
      fireEvent.pointerUp(document.body, { clientX: 50 });
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 6 });
      runFrames();
      expect(scroller.scrollLeft).toBe(190);

      // Nor does one whose release the window never sees, as it lost focus.
      fireEvent.pointerDown(track, { clientX: 150 });
      fireEvent.blur(window);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 8.5 });
      runFrames();
      expect(scroller.scrollLeft).toBe(273);
    });

    it("keeps a clip edge under the pointer at the zoom limit", async () => {
      const backend = mockBackend(JOINED_ZOOM);
      render(<RecordingEditor />);
      await loadJoinedZoom();
      const scroller = layOutTimeline();
      const zoomIn = screen.getByRole("button", { name: "Zoom in" });
      for (let i = 0; i < 6; i++) await userEvent.click(zoomIn);
      // 10 s over 100 px: 40x is 400 px a second, the most.
      expect(zoomIn).toBeDisabled();
      expect(Number(zoomOf())).toBeCloseTo(40);
      scroller.scrollLeft = 1550;
      // Clip a ends at 4 s, 1600 px along: 50 px into the view.
      spanAt(screen.getByRole("listbox", { name: "Clips" }), -1550, 4000);
      const edge = screen.getByRole("option", { name: `${OWN}, 0:04.0` }).querySelector(".clip-edge.end") as HTMLElement;
      fireEvent.pointerDown(edge, { clientX: 50 });
      fireEvent.pointerMove(edge, { clientX: 10 });
      // 40 px is 0.1 s: the 9.9 s sequence shows at 39.6x, still 400 px a second and scrolled as it was.
      expect(Number(zoomOf())).toBeCloseTo(39.6);
      expect(scroller.scrollLeft).toBe(1550);
      const first = screen.getByRole("option", { name: `${OWN}, 0:03.9` });
      expect((parseFloat(first.style.width) / 100) * 3960 - 1550).toBeCloseTo(10);
      fireEvent.pointerUp(edge, { clientX: 10 });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [{ ...JOINED_ZOOM.clips[0], endMs: 4900 }, JOINED_ZOOM.clips[1]] }));
      expect(scroller.scrollLeft).toBe(1550);
    });

    it("comes back to the chosen zoom after a drag shortens the sequence past fitting", async () => {
      // Clip a's recording is the opened one, so its length is known and it can grow back.
      mockBackend({ version: 2, clips: [{ id: "a", source: OWN, startMs: 0, endMs: 8000 }, JOINED_ZOOM.clips[1]] });
      render(<RecordingEditor />);
      await loadJoinedZoom();
      layOutTimeline();
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // 2x of the 14 s sequence: the clip row 200 px wide, 70 ms a pixel.
      expect(zoomOf()).toBe("2");
      spanAt(screen.getByRole("listbox", { name: "Clips" }), 0, 200);
      const edge = screen.getByRole("option", { name: `${OWN}, 0:08.0` }).querySelector(".clip-edge.end") as HTMLElement;
      const at = (8000 / 14_000) * 200;
      fireEvent.pointerDown(edge, { clientX: at });
      // Down to half a second, the 6.5 s sequence is narrower than the view at that scale, so it fits.
      fireEvent.pointerMove(edge, { clientX: at - 110 });
      expect(screen.getByRole("option", { name: `${OWN}, 0:00.5` })).toBeInTheDocument();
      expect(zoomOf()).toBe("1");
      fireEvent.pointerMove(edge, { clientX: at });
      fireEvent.pointerUp(edge, { clientX: at });
      expect(screen.getByRole("option", { name: `${OWN}, 0:08.0` })).toBeInTheDocument();
      expect(Number(zoomOf())).toBeCloseTo(2);
    });

    it("trims and reorders clips at the pointer while zoomed", async () => {
      const joined = {
        version: 2,
        clips: [
          { id: "a", source: OWN, startMs: 1000, endMs: 5000 },
          { id: "b", source: OTHER, startMs: 0, endMs: 6000 },
        ],
      };
      const backend = mockBackend(joined);
      render(<RecordingEditor />);
      const video = await previewVideo(OWN);
      setVideoMetadata(video, 12, 1920, 1080);
      fireEvent.loadedMetadata(video);
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
      const scroller = layOutTimeline();
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(zoomOf()).toBe("4");
      scroller.scrollLeft = 100;
      // The 10 s clip row is 400 px at 4x, scrolled 100 px: 25 ms a pixel.
      const row = screen.getByRole("listbox", { name: "Clips" });
      spanAt(row, -100, 400);
      const edge = screen.getByRole("option", { name: `${OTHER}, 0:06.0` }).querySelector(".clip-edge.end") as HTMLElement;
      fireEvent.pointerDown(edge, { clientX: 300 });
      fireEvent.pointerMove(edge, { clientX: 260 });
      fireEvent.pointerUp(edge, { clientX: 260 });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [joined.clips[0], { ...joined.clips[1], endMs: 5000 }] }));
      // The sequence is 9 s now, at the same 40 px a second: 3.6x, still scrolled 100 px,
      // so the clip's end stays under the pointer, 360 px along.
      expect(Number(zoomOf())).toBeCloseTo(3.6);
      expect(scroller.scrollLeft).toBe(100);
      const second = screen.getByRole("option", { name: `${OTHER}, 0:05.0` });
      expect(parseFloat(second.style.left) + parseFloat(second.style.width)).toBeCloseTo(100);

      // 350 px along the 9 s sequence's 360 px is 8.75 s, in the second clip.
      spanAt(screen.getByRole("listbox", { name: "Clips" }), -100, 360);
      const first = screen.getByRole("option", { name: `${OWN}, 0:04.0` });
      fireEvent.pointerDown(first, { clientX: 10 });
      fireEvent.pointerMove(first, { clientX: 250 });
      fireEvent.pointerUp(first, { clientX: 250 });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [{ ...joined.clips[1], endMs: 5000 }, joined.clips[0]] }));
    });

    it("keeps the playhead in view while playing", async () => {
      mockBackend();
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      render(<RecordingEditor />);
      const video = await loadVideo();
      const scroller = layOutTimeline();
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // 4x: 400 px for 12 s, with 3 s in view.
      expect(scroller.scrollLeft).toBe(0);
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.play(video);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 1.5 });
      act(() => frames.splice(0).forEach((frame) => frame(0)));
      // Well inside the view, it stays put.
      expect(scroller.scrollLeft).toBe(0);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 3 });
      act(() => frames.splice(0).forEach((frame) => frame(0)));
      // Past the edge, the view pages on to put it 10 px in.
      expect(scroller.scrollLeft).toBe(90);
    });

    it("keeps the playhead in view through a gap", async () => {
      const clips: Value[] = [
        { id: "a", source: OWN, startMs: 8000, endMs: 12_000 },
        { id: "g", gapMs: 4000 },
        { id: "b", source: OWN, startMs: 0, endMs: 2000 },
      ];
      mockBackend({ version: 3, clips });
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      render(<RecordingEditor />);
      const video = await previewVideo(OWN);
      setVideoMetadata(video, 12, 1920, 1080);
      fireEvent.loadedMetadata(video);
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
      const scroller = layOutTimeline();
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // 4x: 400 px for the 10 s sequence, 40 px a second, with 2.5 s in view.
      expect(scroller.scrollLeft).toBe(0);
      const runFrames = () => act(() => frames.splice(0).forEach((frame) => frame(now)));
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.play(video);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 12 });
      Object.defineProperty(video, "paused", { configurable: true, value: true });
      runFrames();
      // Into the gap at 4 s, 160 px along: paged on to 10 px in.
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:04.0 / 0:10.0");
      expect(scroller.scrollLeft).toBe(150);
      now = 1000;
      runFrames();
      expect(scroller.scrollLeft).toBe(150);
      // 6.5 s in the gap is 260 px along, past the view's edge at 240.
      now = 2500;
      runFrames();
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:06.5 / 0:10.0");
      expect(scroller.scrollLeft).toBe(250);
    });

    it("keeps a clip edge under the pointer when a drag shortens the sequence scrolled to its end", async () => {
      const backend = mockBackend(JOINED_ZOOM);
      render(<RecordingEditor />);
      await loadJoinedZoom();
      const scroller = layOutTimeline();
      // A browser keeps the scroll offset within the content less the view; jsdom doesn't.
      let offset = 0;
      const contentWidth = () => {
        const hold = screen.queryByTestId("timeline-hold");
        return Math.max(Number(zoomOf()) * 100 + 24, hold ? parseFloat(hold.style.width) : 0);
      };
      Object.defineProperty(scroller, "scrollLeft", {
        configurable: true,
        get: () => (offset = Math.min(offset, Math.max(0, contentWidth() - 124))),
        set: (value: number) => {
          offset = Math.max(0, value);
        },
      });
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // 4x: the 10 s clip row is 400 px, 40 px a second, scrolled to its end.
      expect(zoomOf()).toBe("4");
      scroller.scrollLeft = 1000;
      expect(scroller.scrollLeft).toBe(300);
      spanAt(screen.getByRole("listbox", { name: "Clips" }), -300, 400);
      const edge = screen.getByRole("option", { name: `${OTHER}, 0:06.0` }).querySelector(".clip-edge.end") as HTMLElement;
      fireEvent.pointerDown(edge, { clientX: 100 });
      fireEvent.pointerMove(edge, { clientX: 50 });
      // 50 px is 1.25 s: the 8.75 s sequence shows at 3.5x, 350 px, but the scroller keeps its width,
      // so the offset holds and the clip's end is at the pointer, 50 px into the view.
      expect(Number(zoomOf())).toBeCloseTo(3.5);
      expect(scroller.scrollLeft).toBe(300);
      const second = screen.getByRole("option", { name: new RegExp(`^${OTHER}, 0:04`) });
      expect(((parseFloat(second.style.left) + parseFloat(second.style.width)) / 100) * 350 - scroller.scrollLeft).toBeCloseTo(50);
      fireEvent.pointerUp(edge, { clientX: 50 });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [JOINED_ZOOM.clips[0], { ...JOINED_ZOOM.clips[1], endMs: 4750 }] }));
      // Let go, the scroller is as wide as the sequence again.
      expect(screen.queryByTestId("timeline-hold")).not.toBeInTheDocument();
      expect(scroller.scrollLeft).toBe(250);
    });

    it("keeps the chosen scale and the scroll offset when the view is resized", async () => {
      mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      const scroller = layOutTimeline();
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      // 4x: 400 px for 12 s.
      expect(zoomOf()).toBe("4");
      scroller.scrollLeft = 100;
      // Twice as wide a view shows the same pixels a second at half the multiple of fit.
      Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 224 });
      fireEvent.scroll(scroller);
      expect(zoomOf()).toBe("2");
      expect(scroller.scrollLeft).toBe(100);
      Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 124 });
      fireEvent.scroll(scroller);
      expect(zoomOf()).toBe("4");
      expect(scroller.scrollLeft).toBe(100);
    });

    it("keeps the chosen scale and the scroll offset when a Suggest edits preview changes the length", async () => {
      heard = { sound: "microphone", pauses: [{ startMs: 3000, endMs: 6000 }], canClean: true, pointer: null };
      mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      const preview = await screen.findByRole("button", { name: "Preview" });
      const scroller = layOutTimeline();
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(zoomOf()).toBe("4");
      scroller.scrollLeft = 100;
      await userEvent.click(preview);
      // The 9.5 s preview at the same 33.3 px a second is 9.5 / 12 of 4x.
      expect(screen.getByText("2 clips, 0:09.5")).toBeInTheDocument();
      expect(Number(zoomOf())).toBeCloseTo((4 * 9.5) / 12);
      expect(scroller.scrollLeft).toBe(100);
      await userEvent.click(screen.getByRole("button", { name: "Stop preview" }));
      expect(zoomOf()).toBe("4");
      expect(scroller.scrollLeft).toBe(100);
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
      const video = await previewVideo(OWN);
      setVideoMetadata(video, 12, 1920, 1080);
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

    it("reopens and exports a join of same-named files from different months", async () => {
      const own = `2026-03/${OTHER}`;
      const other = `2026-04/${OTHER}`;
      const backend = mockBackend(null, null, [], {}, own);
      const view = render(<RecordingEditor />);
      await loadVideo(own);
      picked = `${RECORDINGS}/${other}`;
      await userEvent.click(screen.getByRole("button", { name: "Recording" }));
      const joined = await waitFor(() => {
        const edits = lastSaved(backend);
        expect(edits).toMatchObject({ version: 4, clips: [{ source: own }, { source: other }] });
        return edits;
      });
      expect(backend.calls.find(({ cmd }) => cmd === "plugin:dialog|open")?.payload).toMatchObject({ options: { defaultPath: RECORDINGS } });
      view.unmount();

      const reopened = mockBackend(joined as Value, null, [], {}, own);
      render(<RecordingEditor />);
      const ownVideo = await previewVideo(own);
      setVideoMetadata(ownVideo, 12, 1920, 1080);
      fireEvent.loadedMetadata(ownVideo);
      const otherVideo = await previewVideo(other);
      setVideoMetadata(otherVideo, 6, 720, 720);
      fireEvent.loadedMetadata(otherVideo);
      expect(otherVideo.getAttribute("src")).toBe(`grab-it-video://localhost/${encodeURIComponent(picked)}`);

      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await waitFor(() => expect(reopened.calls.filter(({ cmd }) => cmd === "recording_pauses").map(({ payload }) => payload)).toEqual([
        { fileName: own, noiseDb: -40 },
        { fileName: other, noiseDb: -40 },
      ]));
      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      const { plan } = await exportCall(reopened);
      expect(plan.clips).toMatchObject([{ source: own, sourceWidth: 1920 }, { source: other, sourceWidth: 720 }]);
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
      const other = await previewVideo(OTHER);
      setVideoMetadata(other, 6, 720, 720);
      fireEvent.loadedMetadata(other);
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
        removeNoise: false,
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

    it("on Linux reuses both loaded players across repeated seeks and releases each URL when its source leaves", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)");
      const fetcher = vi.fn(async () => new Response(new Uint8Array(4), { status: 200 }));
      vi.stubGlobal("fetch", fetcher);
      let made = 0;
      const createObjectURL = vi.fn(() => `blob:tauri://localhost/${++made}`);
      const revokeObjectURL = vi.fn();
      Object.assign(URL, { createObjectURL, revokeObjectURL });
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      mockBackend(JOINED);
      const { unmount } = render(<StrictMode><RecordingEditor /></StrictMode>);
      const first = await loadJoined();
      const second = await previewVideo(OTHER);
      const firstUrl = first.src;
      const secondUrl = second.src;
      expect(firstUrl).not.toBe(secondUrl);
      expect(second).not.toBeVisible();
      expect(second.hasAttribute("crossorigin")).toBe(false);

      // 10 s over 100 px. The first clip keeps source seconds 1–5.
      const track = screen.getByTestId("timeline-track");
      placeAt(track, 100, 26);
      const seekTo = (clientX: number) => {
        fireEvent.pointerDown(track, { clientX });
        fireEvent.pointerUp(track, { clientX });
      };
      seekTo(60);
      // The first frame still applies the seek if its loadedmetadata was missed.
      setVideoMetadata(second, 6, 720, 720);
      fireEvent.canPlay(second);
      expect(second.currentTime).toBe(2);
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.play(second);
      Object.defineProperty(second, "paused", { configurable: true, value: false });

      for (const offset of [0, 1, 2]) {
        seekTo(10 + offset);
        expect(first).toBeVisible();
        expect(second).not.toBeVisible();
        expect(first.currentTime).toBeCloseTo(2 + offset / 10);
        expect(play.mock.instances[play.mock.instances.length - 1]).toBe(first);
        // The hidden player is paused and silent.
        expect(pause.mock.instances[pause.mock.instances.length - 1]).toBe(second);
        expect(second.muted).toBe(true);
        expect(first.muted).toBe(false);
        fireEvent.timeUpdate(second);
        fireEvent.pause(second);
        fireEvent.ended(second);
        expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
        seekTo(60 + offset);
        expect(second).toBeVisible();
        expect(first).not.toBeVisible();
        expect(second.currentTime).toBeCloseTo(2 + offset / 10);
        expect(play.mock.instances[play.mock.instances.length - 1]).toBe(second);
        expect(first.muted).toBe(true);
        expect(second.muted).toBe(false);
      }
      // Each recording kept its one player throughout.
      expect(screen.getByTestId("recording-stage").querySelectorAll("video")).toHaveLength(2);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(createObjectURL).toHaveBeenCalledTimes(2);
      expect(revokeObjectURL).not.toHaveBeenCalled();
      fireEvent.focus(screen.getByRole("option", { name: `${OTHER}, 0:06.0` }));
      fireEvent.keyDown(document.body, { key: "Delete" });
      expect(second).not.toBeInTheDocument();
      expect(first).toBeVisible();
      expect(revokeObjectURL.mock.calls).toEqual([[secondUrl]]);
      unmount();
      expect(revokeObjectURL.mock.calls).toEqual([[secondUrl], [firstUrl]]);
      vi.unstubAllGlobals();
    });

    it("duplicates the selected clip right after itself, with the button and Ctrl+D, one undo step each", async () => {
      const backend = mockBackend(JOINED);
      render(<RecordingEditor />);
      await loadJoined();
      fireEvent.focus(screen.getByRole("option", { name: `${OTHER}, 0:06.0` }));
      await userEvent.click(screen.getByRole("button", { name: "Duplicate" }));
      const copy = { ...JOINED.clips[1], id: expect.any(String) };
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [...JOINED.clips, copy] }));
      expect(screen.getAllByRole("option")).toHaveLength(3);
      // The copy is selected, so Ctrl+D copies it again.
      fireEvent.keyDown(document.body, { key: "d", ctrlKey: true });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [...JOINED.clips, copy, copy] }));
      expect(saved(backend)).toHaveLength(2);

      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [...JOINED.clips, copy] }));
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual(JOINED));
    });

    it("leaves a gap with Shift+Delete and the button, and Delete closes it", async () => {
      const zoom = { id: "z2", source: OTHER, startMs: 1000, endMs: 3000, scale: 2, focus: { kind: "area", x: 0.5, y: 0.5 } };
      const backend = mockBackend({ ...JOINED, zooms: [zoom] });
      render(<RecordingEditor />);
      await loadJoined();
      fireEvent.focus(screen.getByRole("option", { name: `${OWN}, 0:04.0` }));
      fireEvent.keyDown(document.body, { key: "Delete", shiftKey: true });
      // Later clips stay where they were, and zooms keep their recording's time.
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 3, clips: [{ id: expect.any(String), gapMs: 4000 }, JOINED.clips[1]], zooms: [zoom] }));
      const gap = screen.getByRole("option", { name: "Gap, 0:04.0" });
      expect(gap).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("2 clips, 0:10.0")).toBeInTheDocument();
      // The last clip that plays a recording cannot be deleted either way.
      fireEvent.focus(screen.getByRole("option", { name: `${OTHER}, 0:06.0` }));
      expect(screen.getByRole("button", { name: "Leave gap" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
      fireEvent.keyDown(document.body, { key: "Delete", shiftKey: true });
      expect(saved(backend)).toHaveLength(1);

      fireEvent.focus(screen.getByRole("option", { name: "Gap, 0:04.0" }));
      expect(screen.queryByRole("button", { name: "Duplicate" })).not.toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: "Delete" });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [JOINED.clips[1]], zooms: [zoom] }));

      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 3, clips: [{ id: expect.any(String), gapMs: 4000 }, JOINED.clips[1]], zooms: [zoom] }));
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual({ ...JOINED, zooms: [zoom] }));
    });

    it("ripple deletes the selected clip with the Delete button", async () => {
      const backend = mockBackend({ ...JOINED, clips: [...JOINED.clips, { id: "c", source: OWN, startMs: 6000, endMs: 8000 }] });
      render(<RecordingEditor />);
      await loadJoined(3);
      fireEvent.focus(screen.getByRole("option", { name: `${OTHER}, 0:06.0` }));
      await userEvent.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 2, clips: [JOINED.clips[0], { id: "c", source: OWN, startMs: 6000, endMs: 8000 }] }));
      expect(screen.getByText("2 clips, 0:06.0")).toBeInTheDocument();
    });

    it("merges a gap moved next to another, keeping it selected and the playhead on it", async () => {
      const third = { id: "c", source: OWN, startMs: 6000, endMs: 8000 };
      const backend = mockBackend({ version: 3, clips: [JOINED.clips[0], { id: "g1", gapMs: 1000 }, JOINED.clips[1], { id: "g2", gapMs: 500 }, third] });
      render(<RecordingEditor />);
      await loadJoined(5);
      fireEvent.focus(screen.getByRole("option", { name: "Gap, 0:00.5" }));
      fireEvent.keyDown(document.body, { key: "ArrowLeft", altKey: true });
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 3, clips: [JOINED.clips[0], { id: "g1", gapMs: 1500 }, JOINED.clips[1], third] }));
      expect(screen.getByRole("option", { name: "Gap, 0:01.5" })).toHaveAttribute("aria-selected", "true");
      // The playhead is at the merged gap's start, after the first clip.
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:04.0 / 0:13.5");
    });

    it("exports a gap as its length, between the clips", async () => {
      const backend = mockBackend({ version: 3, clips: [JOINED.clips[0], { id: "g", gapMs: 1500 }, JOINED.clips[1]] });
      render(<RecordingEditor />);
      await loadJoined(3);
      expect(screen.getByRole("option", { name: "Gap, 0:01.5" })).toBeInTheDocument();
      const other = await previewVideo(OTHER);
      setVideoMetadata(other, 6, 720, 720);
      fireEvent.loadedMetadata(other);
      await waitFor(() => expect(screen.getByRole("button", { name: "Export" })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: "Export" }));
      const { plan } = await exportCall(backend);
      const entries = (plan as { clips: Record<string, unknown>[] }).clips;
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({ source: OWN, startMs: 1000, endMs: 5000 });
      expect(entries[1]).toEqual({ gapMs: 1500 });
      expect(entries[2]).toMatchObject({ source: OTHER, startMs: 0, endMs: 6000 });
    });

    it("plays a gap as a black box on the frame clock, then the next clip", async () => {
      const clips: Value[] = [
        { id: "a", source: OWN, startMs: 8000, endMs: 12_000 },
        { id: "g", gapMs: 1000 },
        { id: "b", source: OWN, startMs: 0, endMs: 2000 },
      ];
      mockBackend({ version: 3, clips });
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      render(<RecordingEditor />);
      const video = await loadJoined(3);
      const runFrames = () => act(() => frames.splice(0).forEach((frame) => frame(now)));
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.play(video);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 12 });
      Object.defineProperty(video, "paused", { configurable: true, value: true });
      runFrames();
      // Into the gap: the video waits, hidden and paused, and the playhead runs on.
      expect(screen.getByTestId("recording-fit")).toHaveAttribute("data-gap", "true");
      expect(pause).toHaveBeenCalled();
      fireEvent.pause(video);
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:04.0 / 0:07.0");
      now = 500;
      runFrames();
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:04.5 / 0:07.0");
      expect(play).toHaveBeenCalledTimes(1);
      now = 1100;
      runFrames();
      // On to the next clip, playing its recording from its start.
      expect(screen.getByTestId("recording-fit")).not.toHaveAttribute("data-gap");
      expect(video.currentTime).toBe(0);
      expect(play).toHaveBeenCalledTimes(2);
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

  describe("Suggest edits", () => {
    const PAUSE = { startMs: 3000, endMs: 6000 };
    /** The opened recording's 1–5 s, then the other recording's 0–6 s. */
    const JOINED_TWO = {
      version: 2,
      clips: [
        { id: "a", source: OWN, startMs: 1000, endMs: 5000 },
        { id: "b", source: OTHER, startMs: 0, endMs: 6000 },
      ],
    };

    it("proposes a cut at a pause with its reason, range and length", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      const list = await screen.findByRole("list", { name: "Proposed cuts" });
      expect(list).toHaveTextContent("Quiet pause with the pointer still");
      expect(list).toHaveTextContent("0:03.2–0:05.7");
      expect(list).toHaveTextContent("0:02.5");
      expect(screen.getByText(/Microphone recorded on its own/)).toBeInTheDocument();
      expect(screen.getByRole("slider", { name: "Threshold" })).toBeEnabled();
      expect(backend.calls.find((call) => call.cmd === "recording_pauses")?.payload).toEqual({ fileName: OWN, noiseDb: -40 });
    });

    it("previews the chosen cuts without saving, and stops the preview", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Preview" }));
      expect(screen.getByText("2 clips, 0:09.5")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Stop preview" }));
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Preview" }));
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      expect(saved(backend)).toEqual([]);
    });

    it("applies the chosen cuts in one undo step, and reopens them", async () => {
      heard = { sound: "microphone", pauses: [PAUSE, { startMs: 8000, endMs: 10_000 }], canClean: true, pointer: null };
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      const { unmount } = render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      const boxes = await screen.findAllByRole("checkbox");
      expect(boxes).toHaveLength(2);
      await userEvent.click(boxes[1]);
      await userEvent.click(screen.getByRole("button", { name: "Apply 1 cut (0:02.5)" }));
      await waitFor(() => expect(saved(backend)).toHaveLength(1));
      const edits = lastSaved(backend) as { version: number; clips: { startMs: number; endMs: number }[] };
      expect(edits.version).toBe(2);
      expect(edits.clips.map((clip) => [clip.startMs, clip.endMs])).toEqual([
        [0, 3250],
        [5750, 12_000],
      ]);
      expect(screen.getByText("2 clips, 0:09.5")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
      unmount();

      mockBackend(edits as unknown as Value, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      const reopened = await previewVideo(OWN);
      setVideoMetadata(reopened, 12, 1920, 1080);
      fireEvent.loadedMetadata(reopened);
      await screen.findByText("2 clips, 0:09.5");
    });

    it("plays the original and cleaned sound around a cut", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audition");
      vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Cleaned" }));
      await waitFor(() => expect(backend.calls.filter((call) => call.cmd === "recording_audition")).toHaveLength(1));
      expect(backend.calls.find((call) => call.cmd === "recording_audition")?.payload).toEqual({ fileName: OWN, startMs: 1250, endMs: 7750, cleaned: true });
      expect(await screen.findByLabelText("Cleaned audio")).toHaveAttribute("src", "blob:audition");
      await userEvent.click(screen.getByRole("button", { name: "Original" }));
      expect(await screen.findByLabelText("Original audio")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Stop" }));
      expect(screen.queryByLabelText("Original audio")).not.toBeInTheDocument();
    });

    it("offers only the original for mixed sound", async () => {
      heard = { sound: "mixed", pauses: [PAUSE], canClean: false, pointer: null };
      mockBackend(null, null, ["mixed"]);
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      expect(await screen.findByRole("button", { name: "Cleaned" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Original" })).toBeEnabled();
      expect(screen.getByText(/only the original can be played/)).toBeInTheDocument();
    });

    it("follows the pointer in a silent demonstration", async () => {
      // The pointer as recorded comes with the pauses, not the smoothed path the zooms follow.
      const points: [number, number][] = Array.from({ length: 720 }, (_, index) => (index >= 120 && index < 420 ? [0.5, 0.5] : [(index % 2) * 0.5, 0.2]));
      heard = { sound: "silent", pauses: [], canClean: false, pointer: { fps: 60, points } };
      mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      const list = await screen.findByRole("list", { name: "Proposed cuts" });
      expect(list).toHaveTextContent("Pointer idle");
      expect(screen.getByText("This recording has no sound.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Original" })).not.toBeInTheDocument();
      // Its cuts come from the pointer, which no threshold changes.
      expect(screen.getByRole("slider", { name: "Threshold" })).toBeDisabled();
      expect(screen.getByRole("slider", { name: "Minimum cut" })).toBeEnabled();
    });

    it("keeps a cut's range as it is while its preview plays", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      const range = await screen.findByRole("button", { name: "Listen around 0:03.2–0:05.7" });
      expect(range).toHaveTextContent(/^0:03\.2–0:05\.7$/);
      await userEvent.click(screen.getByRole("button", { name: "Preview" }));
      expect(screen.getByText("2 clips, 0:09.5")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Listen around 0:03.2–0:05.7" })).toHaveTextContent(/^0:03\.2–0:05\.7$/);
      expect(screen.getByRole("group", { name: "Audio audition" })).toHaveTextContent(/^Listen around 0:03\.2–0:05\.7/);
    });

    it("saves nothing a preview shows when another edit is tried during it", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Preview" }));
      expect(screen.getByText("2 clips, 0:09.5")).toBeInTheDocument();
      // The playhead is inside the first previewed clip, where S would split it.
      fireEvent.keyDown(document.body, { key: "s" });
      expect(saved(backend)).toEqual([]);
      expect(screen.getByText("Stop the preview or apply the suggested cuts before editing.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Stop preview" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Stop preview" }));
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      expect(saved(backend)).toEqual([]);
    });

    it("ends a preview with Esc from anywhere in the window, even after Play", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockReturnValue(undefined);
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Preview" }));
      expect(screen.getByText("2 clips, 0:09.5")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop preview" })).not.toBeInTheDocument();
      expect(screen.getByRole("list", { name: "Proposed cuts" })).toBeInTheDocument();
      expect(saved(backend)).toEqual([]);
    });

    it("ends a preview on Undo, keeping no unapproved cut", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Remove background noise" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1, removeNoise: true }));
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Preview" }));
      await userEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(lastSaved(backend)).toEqual({ version: 1 }));
      expect(saved(backend).some((edits) => "clips" in (edits as object))).toBe(false);
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop preview" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
      expect(screen.queryByText(/Previewing/)).not.toBeInTheDocument();
    });

    it("says when no pauses long enough to cut were found", async () => {
      heard = { sound: "microphone", pauses: [], canClean: true, pointer: null };
      mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      expect(await screen.findByText("No pauses long enough to cut were found.")).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Proposed cuts" })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("lets go of an audition when another cut is chosen, even one still being prepared", async () => {
      heard = { sound: "microphone", pauses: [PAUSE, { startMs: 8000, endMs: 10_000 }], canClean: true, pointer: null };
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audition");
      vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Original" }));
      expect(await screen.findByLabelText("Original audio")).toBeInTheDocument();
      // Choosing the second cut stops the first one's sound.
      await userEvent.click(screen.getByRole("button", { name: "Listen around 0:08.2–0:09.7" }));
      expect(screen.queryByLabelText("Original audio")).not.toBeInTheDocument();
      expect(backend.calls.filter((call) => call.cmd === "recording_audition")).toHaveLength(1);

      // A sound still being prepared for the first cut never plays for the second.
      let release: (bytes: ArrayBuffer) => void = () => undefined;
      auditioned = () => new Promise<ArrayBuffer>((resolve) => (release = resolve));
      await userEvent.click(screen.getByRole("button", { name: "Listen around 0:03.2–0:05.7" }));
      await userEvent.click(screen.getByRole("button", { name: "Original" }));
      await screen.findByText("Preparing…");
      await userEvent.click(screen.getByRole("button", { name: "Listen around 0:08.2–0:09.7" }));
      expect(screen.queryByText("Preparing…")).not.toBeInTheDocument();
      await act(async () => release(new ArrayBuffer(4)));
      expect(screen.queryByLabelText("Original audio")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Original" })).toBeEnabled();
    });

    it("says when no pauses were found, or why it could not listen", async () => {
      heard = "ffmpeg is not ready yet";
      mockBackend(null, null, ["microphone"]);
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("ffmpeg is not ready yet");
    });

    /** The thresholds `recording_pauses` was asked to listen at, in order. */
    const thresholds = (backend: Backend) => backend.calls.filter((call) => call.cmd === "recording_pauses").map((call) => (call.payload as { noiseDb: number }).noiseDb);

    it("starts the tuning from the usual values and recomputes the cuts at once, without listening again", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await screen.findByRole("button", { name: "Listen around 0:03.2–0:05.7" });
      expect(screen.getByRole("slider", { name: "Threshold" })).toHaveValue("-40");
      expect(screen.getByRole("slider", { name: "Minimum cut" })).toHaveValue("1200");
      expect(screen.getByRole("slider", { name: "Keep padding" })).toHaveValue("250");
      expect(screen.getByText("0.25 s")).toBeInTheDocument();

      fireEvent.change(screen.getByRole("slider", { name: "Keep padding" }), { target: { value: "500" } });
      expect(screen.getByRole("button", { name: "Listen around 0:03.5–0:05.5" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Apply 1 cut (0:02.0)" })).toBeInTheDocument();
      // The cut is now 2 s long, shorter than the Minimum cut.
      fireEvent.change(screen.getByRole("slider", { name: "Minimum cut" }), { target: { value: "2500" } });
      expect(screen.getByText("No pauses long enough to cut were found.")).toBeInTheDocument();
      expect(screen.getByText("2.5 s")).toBeInTheDocument();
      expect(thresholds(backend)).toEqual([-40]);
    });

    it("starts each opening of the panel from the usual tuning", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      fireEvent.change(await screen.findByRole("slider", { name: "Keep padding" }), { target: { value: "0" } });
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      expect(await screen.findByRole("slider", { name: "Keep padding" })).toHaveValue("250");
      expect(await screen.findByRole("button", { name: "Listen around 0:03.2–0:05.7" })).toBeInTheDocument();
    });

    it("listens again at a new Threshold once let go, and drops a late answer for one let go of", async () => {
      const answers: Record<number, (pauses: RecordingPauses) => void> = {};
      heard = (noiseDb) =>
        noiseDb === -40 ? { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null } : new Promise<RecordingPauses>((resolve) => (answers[noiseDb] = resolve));
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await screen.findByRole("button", { name: "Listen around 0:03.2–0:05.7" });
      const threshold = screen.getByRole("slider", { name: "Threshold" });

      // Not on every step while it moves: only once it is let go.
      fireEvent.change(threshold, { target: { value: "-50" } });
      expect(screen.getByText("-50 dB")).toBeInTheDocument();
      expect(thresholds(backend)).toEqual([-40]);
      fireEvent.pointerUp(threshold);
      await waitFor(() => expect(thresholds(backend)).toEqual([-40, -50]));
      expect(screen.getByText("Listening for pauses…")).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Proposed cuts" })).not.toBeInTheDocument();

      // Moved on before -50 dB was heard: its answer comes back too late to count.
      fireEvent.change(threshold, { target: { value: "-30" } });
      fireEvent.keyUp(threshold, { key: "ArrowRight" });
      await waitFor(() => expect(thresholds(backend)).toEqual([-40, -50, -30]));
      await act(async () => answers[-50]({ sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null }));
      expect(screen.getByText("Listening for pauses…")).toBeInTheDocument();
      await act(async () => answers[-30]({ sound: "microphone", pauses: [{ startMs: 8000, endMs: 10_000 }], canClean: true, pointer: null }));
      expect(screen.getByRole("button", { name: "Listen around 0:08.2–0:09.7" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Listen around 0:03.2–0:05.7" })).not.toBeInTheDocument();
      expect(screen.queryByText("Listening for pauses…")).not.toBeInTheDocument();

      // Back to a threshold already heard: no need to listen again. The dropped one is listened to afresh.
      fireEvent.change(threshold, { target: { value: "-40" } });
      fireEvent.pointerUp(threshold);
      expect(await screen.findByRole("button", { name: "Listen around 0:03.2–0:05.7" })).toBeInTheDocument();
      fireEvent.change(threshold, { target: { value: "-50" } });
      fireEvent.pointerUp(threshold);
      await waitFor(() => expect(thresholds(backend)).toEqual([-40, -50, -30, -50]));
    });

    it("previews one cut alone, from 2 s before it to 2 s after, then stops", async () => {
      heard = { sound: "microphone", pauses: [PAUSE, { startMs: 8000, endMs: 10_000 }], canClean: true, pointer: null };
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      const video = await loadVideo();
      const runFrames = () => act(() => frames.splice(0).forEach((frame) => frame(0)));
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Preview 0:03.2–0:05.7" }));

      // Only this cut, not the other ticked one: 12 s less its 2.5 s, from 2 s before it.
      expect(screen.getByText("2 clips, 0:09.5")).toBeInTheDocument();
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:01.2 / 0:09.5");
      expect(video.currentTime).toBe(1.25);
      expect(play).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stop preview of 0:03.2–0:05.7" })).toBeInTheDocument();
      expect(screen.getByText("Previewing one cut.")).toBeInTheDocument();

      fireEvent.play(video);
      // Through the cut: the pause is skipped.
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 3.25 });
      runFrames();
      expect(video.currentTime).toBe(5.75);
      // 2 s after the cut, the preview ends on its own.
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 7.8 });
      runFrames();
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:05.3 / 0:09.5");
      runFrames();
      expect(pause).toHaveBeenCalled();
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      // Where it stopped, 2 s after the cut, in the recording as saved.
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:07.7 / 0:12.0");
      expect(screen.getByRole("button", { name: "Preview 0:03.2–0:05.7" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop preview" })).not.toBeInTheDocument();
      expect(saved(backend)).toEqual([]);
    });

    it("stops a cut's own preview from its row, and playback with it", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      const video = await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Preview 0:03.2–0:05.7" }));
      expect(screen.getByText("2 clips, 0:09.5")).toBeInTheDocument();
      fireEvent.play(video);
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
      pause.mockClear();
      await userEvent.click(screen.getByRole("button", { name: "Stop preview of 0:03.2–0:05.7" }));
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Preview 0:03.2–0:05.7" })).toBeInTheDocument();
      // The sequence as saved does not play on.
      expect(pause).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });

    it("stops playback when the preview of all the chosen cuts stops", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      const video = await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Preview" }));
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.play(video);
      pause.mockClear();
      await userEvent.click(screen.getByRole("button", { name: "Stop preview" }));
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      expect(pause).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });

    it("hatches the proposals on the clip track, ticked or not, and finds a row from its stretch", async () => {
      heard = { sound: "microphone", pauses: [PAUSE, { startMs: 8000, endMs: 10_000 }], canClean: true, pointer: null };
      mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      expect(screen.queryByRole("listbox", { name: "Clips" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      const first = await screen.findByRole("button", { name: "Proposed cut 0:03.2–0:05.7" });
      expect(first).toHaveAttribute("data-chosen", "true");
      expect(first).toHaveAttribute("data-focus", "true");
      // Lined up with the recording's own timeline.
      expect(first.style.left).toBe(`${(3250 / 12_000) * 100}%`);
      expect(first.style.width).toBe(`${(2500 / 12_000) * 100}%`);
      expect(screen.getByRole("listbox", { name: "Clips" })).toBeInTheDocument();

      const list = screen.getByRole("list", { name: "Proposed cuts" });
      await userEvent.click(within(list).getAllByRole("checkbox")[1]);
      const second = screen.getByRole("button", { name: "Proposed cut 0:08.2–0:09.7, not ticked" });
      expect(second).toHaveAttribute("data-chosen", "false");
      await userEvent.click(second);
      expect(within(list).getAllByRole("listitem")[1]).toHaveAttribute("data-focus", "true");
      expect(screen.getByRole("group", { name: "Audio audition" })).toHaveTextContent(/^Listen around 0:08\.2–0:09\.7/);
      expect(second).toHaveAttribute("data-focus", "true");
      expect(first).not.toHaveAttribute("data-focus");

      // Not over a preview, which already leaves the cuts out, nor once the panel closes.
      await userEvent.click(screen.getByRole("button", { name: "Preview" }));
      expect(screen.queryByRole("button", { name: /^Proposed cut/ })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Stop preview" }));
      expect(screen.getByRole("button", { name: "Proposed cut 0:03.2–0:05.7" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("button", { name: /^Proposed cut/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("listbox", { name: "Clips" })).not.toBeInTheDocument();
    });

    it("ends a cut's own preview when the sequence runs out before 2 s after the cut", async () => {
      // 950 ms of the recording are left after this cut.
      heard = { sound: "microphone", pauses: [{ startMs: 8000, endMs: 11_300 }], canClean: true, pointer: null };
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      const video = await loadVideo();
      const runFrames = () => act(() => frames.splice(0).forEach((frame) => frame(0)));
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Preview 0:08.2–0:11.0" }));
      expect(screen.getByText("2 clips, 0:09.2")).toBeInTheDocument();
      fireEvent.play(video);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 8.3 });
      runFrames();
      expect(video.currentTime).toBe(11.05);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 12 });
      runFrames();
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop preview" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
    });

    it("shows a lone clip under the hatches without edges to trim or a body to drag", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      const backend = mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      await loadVideo();
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await screen.findByRole("button", { name: "Proposed cut 0:03.2–0:05.7" });
      const track = screen.getByRole("listbox", { name: "Clips" });
      expect(track.querySelector(".clip-edge")).toBeNull();
      const clip = within(track).getByRole("option");
      fireEvent.pointerDown(clip, { clientX: 10 });
      fireEvent.pointerMove(clip, { clientX: 40 });
      fireEvent.pointerUp(clip, { clientX: 40 });
      expect(screen.getByRole("button", { name: "Proposed cut 0:03.2–0:05.7" })).toBeInTheDocument();
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      expect(saved(backend)).toEqual([]);
      // Trimming stays on the timeline's handles.
      expect(screen.getByRole("slider", { name: "Trim end" })).toBeVisible();
    });

    it("previews an edge cut of a lone clip, kept with no padding, in the recording's own time", async () => {
      heard = { sound: "microphone", pauses: [{ startMs: 0, endMs: 2000 }], canClean: true, pointer: null };
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      mockBackend(null, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      const video = await loadVideo();
      const runFrames = () => act(() => frames.splice(0).forEach((frame) => frame(0)));
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      fireEvent.change(await screen.findByRole("slider", { name: "Keep padding" }), { target: { value: "0" } });
      await userEvent.click(screen.getByRole("button", { name: "Preview 0:00.0–0:02.0" }));
      // One clip is left, which plays in the recording's own time.
      expect(screen.getByText("Clip 0:10.0")).toBeInTheDocument();
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:02.0 / 0:12.0");
      expect(video.currentTime).toBe(2);
      expect(play).toHaveBeenCalled();
      fireEvent.play(video);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 4.1 });
      runFrames();
      runFrames();
      expect(screen.getByText("Clip 0:12.0")).toBeInTheDocument();
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:04.0 / 0:12.0");
    });

    it("ends a cut's own preview on the clip it was proposed on, even a duplicated one", async () => {
      heard = { sound: "microphone", pauses: [{ startMs: 2000, endMs: 4000 }], canClean: true, pointer: null };
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      const clips = [
        { id: "a", source: OWN, startMs: 0, endMs: 6000 },
        { id: "b", source: OWN, startMs: 0, endMs: 6000 },
      ];
      mockBackend({ version: 2, clips });
      render(<RecordingEditor />);
      const video = await previewVideo(OWN);
      setVideoMetadata(video, 12, 1920, 1080);
      fireEvent.loadedMetadata(video);
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
      const runFrames = () => act(() => frames.splice(0).forEach((frame) => frame(0)));
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await screen.findByRole("list", { name: "Proposed cuts" });
      const previews = screen.getAllByRole("button", { name: /^Preview .*0:02\.2–0:03\.7$/ });
      expect(previews).toHaveLength(2);
      await userEvent.click(previews[1]);
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:06.2 / 0:10.5");
      fireEvent.play(video);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 2.3 });
      runFrames();
      expect(video.currentTime).toBe(3.75);
      Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 5.8 });
      runFrames();
      runFrames();
      // 2 s after the cut on the second copy, not the first.
      expect(screen.getByLabelText("Time")).toHaveTextContent("0:11.7 / 0:12.0");
      expect(screen.queryByRole("button", { name: "Stop preview" })).not.toBeInTheDocument();
    });

    it("does not set another recording playing when a preview stops", async () => {
      heard = { sound: "microphone", pauses: [PAUSE], canClean: true, pointer: null };
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      mockBackend(JOINED_TWO, null, ["microphone"], { separateMicrophone: true });
      render(<RecordingEditor />);
      const first = await previewVideo(OWN);
      setVideoMetadata(first, 12, 1920, 1080);
      fireEvent.loadedMetadata(first);
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
      const second = await previewVideo(OTHER);
      await userEvent.click(screen.getByRole("button", { name: "Suggest edits" }));
      await userEvent.click(await screen.findByRole("button", { name: "Preview" }));
      // The preview is 2.25 s of the first recording, then 6 s of the second, over 100 px.
      expect(screen.getByLabelText("Time")).toHaveTextContent("/ 0:08.2");
      const track = screen.getByTestId("timeline-track");
      placeAt(track, 100, 26);
      fireEvent.pointerDown(track, { clientX: 37 });
      fireEvent.pointerUp(track, { clientX: 37 });
      setVideoMetadata(second, 6, 720, 720);
      fireEvent.canPlay(second);
      await userEvent.click(screen.getByRole("button", { name: "Play" }));
      fireEvent.play(second);
      const played = play.mock.calls.length;
      // Stopping puts the playhead back in the first recording, which then loads.
      await userEvent.click(screen.getByRole("button", { name: "Stop preview" }));
      fireEvent.canPlay(first);
      expect(play.mock.calls.length).toBe(played);
      expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    });
  });

  describe("waveform lanes", () => {
    const lanes = () => screen.queryAllByRole("group", { name: / waveform$/ }).map((lane) => lane.getAttribute("aria-label"));
    const lane = (name: string) => screen.getByRole("group", { name: `${name} waveform` });
    const waveformCalls = (backend: Backend) => backend.calls.filter((call) => call.cmd === "recording_waveform").map((call) => call.payload);
    /** Gives the timeline a 100 px track in view and reports it to the lanes. */
    function layOutTimeline() {
      const scroller = screen.getByTestId("timeline-scroll");
      Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 124 });
      Object.defineProperty(scroller, "scrollLeft", { configurable: true, writable: true, value: 0 });
      fireEvent.scroll(scroller);
    }

    it("draws a lane for each source kept apart, from the opened recording's own sound", async () => {
      stubCanvas([]);
      const backend = mockBackend(null, null, ["microphone", "system"]);
      render(<RecordingEditor />);
      await loadVideo();
      layOutTimeline();
      expect(lanes()).toEqual(["Microphone waveform", "System sound waveform"]);
      await waitFor(() => expect(lane("System sound")).toHaveAttribute("data-state", "ready"));
      expect(lane("Microphone")).toHaveAttribute("data-state", "ready");
      expect(waveformCalls(backend)).toEqual(
        expect.arrayContaining([
          { fileName: OWN, audio: 0 },
          { fileName: OWN, audio: 1 },
        ]),
      );
      expect(waveformCalls(backend)).toHaveLength(2);
      // 12 s across 100 px: a bar every 2 px.
      expect(lane("Microphone").querySelector("canvas")).toHaveAttribute("data-bars", "50");
    });

    it("names mixed sound as the status bar does, with why", async () => {
      mockBackend(null, null, ["mixed"]);
      render(<RecordingEditor />);
      await loadVideo();
      expect(lanes()).toEqual(["Mixed sound waveform"]);
      expect(within(lane("Mixed sound")).getByText("Mixed sound")).toHaveAttribute(
        "title",
        "This recording's microphone and system sound are mixed into one track, so they can only be edited together.",
      );
    });

    it("draws nothing for a silent recording", async () => {
      const backend = mockBackend();
      render(<RecordingEditor />);
      await loadVideo();
      expect(lanes()).toEqual([]);
      expect(screen.queryByRole("separator", { name: "Waveform height" })).not.toBeInTheDocument();
      expect(waveformCalls(backend)).toEqual([]);
    });

    it("draws each clip of a joined sequence from its own recording, and leaves the gap empty", async () => {
      stubCanvas([]);
      sourceAudio = { [OTHER]: ["mixed"] };
      const backend = mockBackend(
        {
          version: 3,
          clips: [
            { id: "a", source: OWN, startMs: 1000, endMs: 5000 },
            { id: "g", gapMs: 1500 },
            { id: "b", source: OTHER, startMs: 0, endMs: 6000 },
          ],
        },
        null,
        ["microphone"],
      );
      render(<RecordingEditor />);
      await previewVideo(OWN);
      await waitFor(() => expect(lanes()).toEqual(["Microphone waveform", "Mixed sound waveform"]));
      layOutTimeline();
      await waitFor(() => expect(lane("Mixed sound")).toHaveAttribute("data-state", "ready"));
      await waitFor(() => expect(lane("Microphone")).toHaveAttribute("data-state", "ready"));
      expect(waveformCalls(backend)).toEqual(
        expect.arrayContaining([
          { fileName: OWN, audio: 0 },
          { fileName: OTHER, audio: 0 },
        ]),
      );
      // 11.5 s across 100 px. The microphone is the first 4 s only (to
      // 34.8 px); the mixed sound starts after the 1.5 s gap, at 47.8 px.
      expect(lane("Microphone").querySelector("canvas")).toHaveAttribute("data-bars", "18");
      expect(lane("Mixed sound").querySelector("canvas")).toHaveAttribute("data-bars", "27");
    });

    it("shows a placeholder until the peaks arrive", async () => {
      let release: (peaks: ArrayBuffer) => void = () => undefined;
      waveform = () => new Promise((resolve) => (release = resolve));
      mockBackend(null, null, ["microphone"]);
      render(<RecordingEditor />);
      await loadVideo();
      await waitFor(() => expect(lane("Microphone")).toHaveAttribute("data-state", "loading"));
      expect(within(lane("Microphone")).getByText("Reading sound…")).toBeInTheDocument();
      await act(async () => release(PEAKS()));
      await waitFor(() => expect(lane("Microphone")).toHaveAttribute("data-state", "ready"));
      expect(within(lane("Microphone")).queryByText("Reading sound…")).not.toBeInTheDocument();
    });

    it("says the waveform is unavailable when it cannot be read, with why", async () => {
      waveform = () => Promise.reject("ffmpeg could not read the sound");
      mockBackend(null, null, ["microphone"]);
      render(<RecordingEditor />);
      await loadVideo();
      expect(await within(lane("Microphone")).findByText("Waveform unavailable")).toHaveAttribute("title", "ffmpeg could not read the sound");
      expect(lane("Microphone")).toHaveAttribute("data-state", "failed");
    });

    it("changes every lane's height by dragging or with the arrow keys", async () => {
      mockBackend(null, null, ["microphone", "system"]);
      render(<RecordingEditor />);
      await loadVideo();
      const separator = screen.getByRole("separator", { name: "Waveform height" });
      const heights = () => [lane("Microphone").style.height, lane("System sound").style.height];
      expect(separator).toHaveAttribute("aria-valuenow", "40");
      expect(heights()).toEqual(["40px", "40px"]);
      fireEvent.keyDown(separator, { key: "ArrowDown" });
      expect(heights()).toEqual(["48px", "48px"]);
      for (let i = 0; i < 5; i++) fireEvent.keyDown(separator, { key: "ArrowUp" });
      expect(separator).toHaveAttribute("aria-valuenow", "24");
      fireEvent.keyDown(separator, { key: "End" });
      expect(separator).toHaveAttribute("aria-valuenow", "120");
      fireEvent.pointerDown(separator, { clientY: 200, pointerId: 1 });
      fireEvent.pointerMove(separator, { clientY: 170, pointerId: 1 });
      fireEvent.pointerUp(separator, { clientY: 170, pointerId: 1 });
      expect(heights()).toEqual(["90px", "90px"]);
      // Moving after letting go changes nothing.
      fireEvent.pointerMove(separator, { clientY: 100, pointerId: 1 });
      expect(separator).toHaveAttribute("aria-valuenow", "90");
    });
  });
});
