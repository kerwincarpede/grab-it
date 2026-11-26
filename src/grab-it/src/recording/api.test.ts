import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { EXPORT_PLAN_HEADER, exportRecording, fetchRecording, playsFromBlob, type ExportPlan } from "./api";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => "/recordings/clip (edited).mp4"),
}));

/** A scheme that answers `bytes=<from>-` with at most `chunk` bytes of `file`, as video_response does. */
function scheme(file: Uint8Array, chunk: number) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range") ?? "";
    const from = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? Number.NaN);
    if (!(from < file.length)) return new Response(null, { status: 416 });
    const to = Math.min(file.length, from + chunk) - 1;
    return new Response(file.slice(from, to + 1), { status: 206, headers: { "Content-Range": `bytes ${from}-${to}/${file.length}` } });
  });
}

describe("fetchRecording", () => {
  it("fetches a long recording a range at a time until it is whole", async () => {
    const file = Uint8Array.from({ length: 10 }, (_, i) => i);
    const fetcher = scheme(file, 4);
    const blob = await fetchRecording("grab-it-video://localhost/clip.mp4", fetcher as unknown as typeof fetch);
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("Range"))).toEqual(["bytes=0-", "bytes=4-", "bytes=8-"]);
    expect(blob.type).toBe("video/mp4");
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(Array.from(file));
  });

  it("takes a whole file sent at once", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const blob = await fetchRecording("grab-it-video://localhost/clip.mp4", fetcher as unknown as typeof fetch);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails on a refusal or a range it did not ask for", async () => {
    const forbidden = vi.fn(async () => new Response("not a recording", { status: 403 }));
    await expect(fetchRecording("u", forbidden as unknown as typeof fetch)).rejects.toThrow("403");
    const skewed = vi.fn(async () => new Response(new Uint8Array([1]), { status: 206, headers: { "Content-Range": "bytes 5-5/10" } }));
    await expect(fetchRecording("u", skewed as unknown as typeof fetch)).rejects.toThrow("wrong pieces");
  });
});

describe("playsFromBlob", () => {
  it("is true in WebKitGTK only", () => {
    expect(playsFromBlob("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(true);
    expect(playsFromBlob("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe(false);
    expect(playsFromBlob("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Edg/130.0")).toBe(false);
  });
});

describe("exportRecording", () => {
  const plan: ExportPlan = {
    clips: [{ source: "clip.mp4", startMs: 0, endMs: 5000, sourceWidth: 1920, sourceHeight: 1080, x: 0, y: 0, width: 1920, height: 1080, zooms: [] }],
    width: 1920,
    height: 1080,
    x: 0,
    y: 0,
    videoWidth: 1920,
    videoHeight: 1080,
    backdropBytes: 0,
    removeNoise: false,
  };
  const sent = () => {
    const [, body, options] = vi.mocked(invoke).mock.calls[vi.mocked(invoke).mock.calls.length - 1] as [string, Uint8Array, { headers: Record<string, string> }];
    return { plan: JSON.parse(decodeURIComponent(options.headers[EXPORT_PLAN_HEADER] ?? "")) as ExportPlan, body: Array.from(body) };
  };

  it("sends the overlays' PNGs after the mask, each with its size in the body", async () => {
    await exportRecording(plan, { backdrop: new Uint8Array([1, 2]), mask: new Uint8Array([3]) }, [
      { startMs: 0, endMs: 1500, x: 10, y: 900, width: 400, height: 80, png: new Uint8Array([7, 7, 7]) },
      { startMs: 1500, endMs: 3000, x: 20, y: 900, width: 300, height: 80, png: new Uint8Array([8]) },
    ]);
    const { plan: header, body } = sent();
    expect(body).toEqual([1, 2, 3, 7, 7, 7, 8]);
    expect(header.backdropBytes).toBe(2);
    expect(header.overlays).toEqual([
      { startMs: 0, endMs: 1500, x: 10, y: 900, width: 400, height: 80, bytes: 3 },
      { startMs: 1500, endMs: 3000, x: 20, y: 900, width: 300, height: 80, bytes: 1 },
    ]);
  });

  it("sends overlays alone without a backdrop, and no overlays when there are none", async () => {
    await exportRecording(plan, null, [{ startMs: 0, endMs: 100, x: 0, y: 0, width: 2, height: 2, png: new Uint8Array([5, 6]) }]);
    expect(sent().body).toEqual([5, 6]);
    expect(sent().plan.backdropBytes).toBe(0);
    await exportRecording(plan, null);
    expect(sent().body).toEqual([]);
    expect(sent().plan).not.toHaveProperty("overlays");
  });
});
