import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TrackAudio from "./TrackAudio";

const api = vi.hoisted(() => ({ fromBlob: false, fetchRecording: vi.fn(async () => new Blob(["x"], { type: "video/mp4" })) }));
vi.mock("./api", () => ({
  playsFromBlob: () => api.fromBlob,
  fetchRecording: api.fetchRecording,
  videoSrc: (path: string) => `grab-it-video://localhost${path}`,
}));

const clip = (id: string, atMs: number) => ({ id, source: "a.mp4", startMs: 1000, endMs: 3000, atMs });

afterEach(() => {
  vi.restoreAllMocks();
  api.fromBlob = false;
  api.fetchRecording.mockClear();
});

describe("TrackAudio", () => {
  it("waits at a clip's first moment before its place, and seeks only past a small drift", () => {
    const placed = vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set");
    const { rerender } = render(<TrackAudio clips={[clip("s", 2000)]} pathOf={() => "/a.mp4"} currentMs={0} playing={false} />);
    expect(placed).toHaveBeenLastCalledWith(1);
    rerender(<TrackAudio clips={[clip("s", 2000)]} pathOf={() => "/a.mp4"} currentMs={2500} playing={false} />);
    expect(placed).toHaveBeenLastCalledWith(1.5);
  });

  it("fetches one blob per recording on Linux, however many clips play it", async () => {
    api.fromBlob = true;
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:a");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    const { container, unmount } = render(<TrackAudio clips={[clip("s", 0), clip("t", 5000)]} pathOf={() => "/a.mp4"} currentMs={0} playing={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.fetchRecording).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll("audio")].map((audio) => audio.getAttribute("src"))).toEqual(["blob:a", "blob:a"]);
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
