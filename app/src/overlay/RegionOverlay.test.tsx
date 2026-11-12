import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it } from "vitest";
import RegionOverlay from "./RegionOverlay";
import type { OverlayInfo } from "./api";

interface Call {
  cmd: string;
  payload?: InvokeArgs;
}

function mockOverlay(info: Partial<OverlayInfo> = {}): Call[] {
  const calls: Call[] = [];
  mockIPC((cmd, payload) => {
    calls.push({ cmd, payload });
    switch (cmd) {
      case "overlay_info":
        return {
          mode: "region",
          // Twice the viewport: a 2x monitor.
          monitorWidth: window.innerWidth * 2,
          monitorHeight: window.innerHeight * 2,
          windows: [
            { id: 7, title: "Editor", appName: "code", x: 200, y: 200, width: 400, height: 300 },
          ],
          ...info,
        };
      case "overlay_image":
        return new ArrayBuffer(8);
      case "overlay_finish":
      case "overlay_cancel":
        return null;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return calls;
}

const last = (calls: Call[]) => calls.at(-1);

/** Waits until overlay_info has loaded. */
async function ready() {
  const overlay = screen.getByTestId("overlay");
  await waitFor(() => expect(overlay).toHaveAttribute("data-ready", "true"));
  return overlay;
}

describe("RegionOverlay", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  it("captures the dragged region in CSS pixels with the viewport width", async () => {
    const calls = mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseDown(overlay, { button: 0, clientX: 300, clientY: 250 });
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });
    expect(screen.getByTestId("overlay-selection")).toHaveTextContent("200 × 200");
    fireEvent.mouseUp(overlay, { button: 0, clientX: 100, clientY: 50 });

    await waitFor(() =>
      expect(last(calls)).toEqual({
        cmd: "overlay_finish",
        payload: {
          selection: {
            kind: "region",
            rect: { x: 100, y: 50, width: 200, height: 200 },
            viewportWidth: 1000,
          },
        },
      }),
    );
  });

  it("highlights the window under the cursor and captures it on click", async () => {
    const calls = mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    // The window is at 100,100 to 300,250 in CSS pixels on this 2x monitor.
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 150 });
    await waitFor(() =>
      expect(screen.getByTestId("overlay-selection")).toHaveTextContent("Editor"),
    );
    fireEvent.mouseDown(overlay, { button: 0, clientX: 150, clientY: 150 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 151, clientY: 150 });

    await waitFor(() =>
      expect(last(calls)).toEqual({
        cmd: "overlay_finish",
        payload: { selection: { kind: "window", id: 7 } },
      }),
    );
  });

  it("does nothing on a click outside every window", async () => {
    const calls = mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseDown(overlay, { button: 0, clientX: 900, clientY: 700 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 900, clientY: 700 });

    expect(calls.map((c) => c.cmd)).not.toContain("overlay_finish");
  });

  it("only picks windows in window mode", async () => {
    const calls = mockOverlay({ mode: "window" });
    render(<RegionOverlay />);
    const overlay = await ready();
    expect(screen.getByRole("status")).toHaveTextContent("Click a window");

    fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 400 });
    expect(calls.map((c) => c.cmd)).not.toContain("overlay_finish");

    fireEvent.mouseDown(overlay, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 200, clientY: 200 });
    await waitFor(() =>
      expect(last(calls)).toEqual({
        cmd: "overlay_finish",
        payload: { selection: { kind: "window", id: 7 } },
      }),
    );
  });

  it("cancels on Escape", async () => {
    const calls = mockOverlay();
    render(<RegionOverlay />);
    await ready();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(last(calls)?.cmd).toBe("overlay_cancel"));
  });

  it("cancels on right-click", async () => {
    const calls = mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.contextMenu(overlay);

    await waitFor(() => expect(last(calls)?.cmd).toBe("overlay_cancel"));
  });
});
