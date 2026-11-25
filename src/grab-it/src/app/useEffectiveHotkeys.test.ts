import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveHotkeys, onEffectiveHotkeys } from "./api";
import { useEffectiveHotkeys } from "./useEffectiveHotkeys";

vi.mock("./api", () => ({
  effectiveHotkeys: vi.fn(),
  onEffectiveHotkeys: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(effectiveHotkeys).mockReset();
  vi.mocked(onEffectiveHotkeys).mockReset();
});

describe("useEffectiveHotkeys", () => {
  it("swallows a rejected unlisten when it unmounts before the subscription resolves", async () => {
    let resolveSubscription: (stop: () => void) => void = () => {};
    vi.mocked(onEffectiveHotkeys).mockReturnValue(
      new Promise((resolve) => {
        resolveSubscription = resolve;
      }),
    );
    vi.mocked(effectiveHotkeys).mockResolvedValue({});
    // A plain function, not vi.fn: a mock watches the promise it returns, which
    // would hide the unhandled rejection this test is about.
    let stopped = 0;
    const stop = () => {
      stopped += 1;
      return Promise.reject(new TypeError("unregisterListener is not a function"));
    };
    const { unmount } = renderHook(() => useEffectiveHotkeys());
    unmount();
    resolveSubscription(stop as unknown as () => void);
    await waitFor(() => expect(stopped).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("swallows a throwing unlisten on unmount after it subscribed", async () => {
    const stop = vi.fn(() => {
      throw new TypeError("unregisterListener is not a function");
    });
    vi.mocked(onEffectiveHotkeys).mockResolvedValue(stop);
    vi.mocked(effectiveHotkeys).mockResolvedValue({ region: "Ctrl+Shift+R" });
    const { result, unmount } = renderHook(() => useEffectiveHotkeys());
    await waitFor(() => expect(result.current).toEqual({ region: "Ctrl+Shift+R" }));
    expect(() => unmount()).not.toThrow();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
