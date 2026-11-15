import { describe, expect, it, vi } from "vitest";
import { fetchRecording, playsFromBlob } from "./api";

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
