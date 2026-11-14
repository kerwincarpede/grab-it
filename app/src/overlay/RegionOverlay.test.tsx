import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RegionOverlay from "./RegionOverlay";
import { START_EVENT, type OverlayInfo } from "./api";

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
      case "overlay_ready":
      case "overlay_finish":
      case "overlay_cancel":
        return null;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  }, { shouldMockEvents: true });
  return calls;
}

const last = (calls: Call[]) => calls[calls.length - 1];

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
  it("draws guide lines through the cursor until a drag starts", async () => {
    mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseMove(overlay, { clientX: 640, clientY: 480 });
    expect(screen.getByTestId("overlay-guide-x")).toHaveStyle({
      transform: "translate3d(0, 480px, 0)",
    });
    expect(screen.getByTestId("overlay-guide-y")).toHaveStyle({
      transform: "translate3d(640px, 0, 0)",
    });

    fireEvent.mouseDown(overlay, { button: 0, clientX: 640, clientY: 480 });
    fireEvent.mouseMove(overlay, { clientX: 700, clientY: 560 });
    expect(screen.queryByTestId("overlay-guide-x")).not.toBeInTheDocument();
  });

  it("has no guide lines or loupe in window mode", async () => {
    mockOverlay({ mode: "window" });
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseMove(overlay, { clientX: 640, clientY: 480 });

    expect(screen.queryByTestId("overlay-guide-x")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overlay-loupe")).not.toBeInTheDocument();
  });

  it("keeps the loupe beside the cursor, flipping at the screen edge", async () => {
    mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 100 });
    expect(screen.getByTestId("overlay-loupe")).toHaveStyle({
      transform: "translate3d(120px, 120px, 0)",
    });

    fireEvent.mouseMove(overlay, { clientX: 990, clientY: 790 });
    expect(screen.getByTestId("overlay-loupe")).toHaveStyle({
      transform: "translate3d(850px, 604px, 0)",
    });
  });

  it("constrains the selection to a square while Shift is held", async () => {
    const calls = mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseDown(overlay, { button: 0, clientX: 500, clientY: 400 });
    fireEvent.mouseMove(overlay, { clientX: 620, clientY: 430, shiftKey: true });
    expect(screen.getByTestId("overlay-selection")).toHaveTextContent("120 × 120");
    fireEvent.mouseUp(overlay, { button: 0, clientX: 620, clientY: 430, shiftKey: true });

    await waitFor(() =>
      expect(last(calls).payload).toEqual({
        selection: {
          kind: "region",
          rect: { x: 500, y: 400, width: 120, height: 120 },
          viewportWidth: 1000,
        },
      }),
    );
  });

  it("snaps to a square as soon as Shift goes down", async () => {
    mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseDown(overlay, { button: 0, clientX: 500, clientY: 400 });
    fireEvent.mouseMove(overlay, { clientX: 620, clientY: 430 });
    expect(screen.getByTestId("overlay-selection")).toHaveTextContent("120 × 30");

    fireEvent.keyDown(window, { key: "Shift" });
    expect(screen.getByTestId("overlay-selection")).toHaveTextContent("120 × 120");
    fireEvent.keyUp(window, { key: "Shift" });
    expect(screen.getByTestId("overlay-selection")).toHaveTextContent("120 × 30");
  });

  it("moves the selection instead of resizing it while Space is held", async () => {
    const calls = mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 300, clientY: 200 });
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    fireEvent.mouseMove(overlay, { clientX: 350, clientY: 260 });
    expect(overlay).toHaveAttribute("data-moving", "true");
    expect(screen.getByTestId("overlay-selection")).toHaveTextContent("200 × 100");
    fireEvent.keyUp(window, { key: " ", code: "Space" });
    // Resizing resumes from the moved selection.
    fireEvent.mouseMove(overlay, { clientX: 360, clientY: 260 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 360, clientY: 260 });

    await waitFor(() =>
      expect(last(calls).payload).toEqual({
        selection: {
          kind: "region",
          rect: { x: 150, y: 160, width: 210, height: 100 },
          viewportWidth: 1000,
        },
      }),
    );
  });

  it("puts the size label below a selection that touches the top", async () => {
    mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseDown(overlay, { button: 0, clientX: 900, clientY: 0 });
    fireEvent.mouseMove(overlay, { clientX: 1000, clientY: 100 });

    const label = screen.getByText("100 × 100");
    expect(label).toHaveAttribute("data-side", "below");
    expect(label).toHaveAttribute("data-align", "end");
  });

  it("shows the key tips next to the hint", async () => {
    mockOverlay();
    render(<RegionOverlay />);
    await ready();

    const tips = screen.getByRole("list", { name: "Keyboard shortcuts" });
    expect(tips).toHaveTextContent("Esc Cancel");
    expect(tips).toHaveTextContent("Shift Square");
    expect(tips).toHaveTextContent("Space Move");
  });

  describe("revealing the window", () => {
    it("shows the window when the image cannot be loaded, so the error is seen", async () => {
      const calls: string[] = [];
      mockIPC((cmd) => {
        calls.push(cmd);
        if (cmd === "overlay_info") {
          return { mode: "region", monitorWidth: 1000, monitorHeight: 800, windows: [] };
        }
        if (cmd === "overlay_image") throw new Error("frozen image lost");
        return null;
      });
      render(<RegionOverlay />);

      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("frozen image lost"));
      await waitFor(() => expect(calls).toContain("overlay_ready"));
      expect(screen.getByTestId("overlay")).toHaveAttribute("data-shown", "true");
    });
  });

  it("shows a failed finish in the status element", async () => {
    mockIPC((cmd) => {
      if (cmd === "overlay_info") {
        return { mode: "region", monitorWidth: 1000, monitorHeight: 800, windows: [] };
      }
      if (cmd === "overlay_image") return new ArrayBuffer(8);
      throw new Error("capture failed");
    });
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseDown(overlay, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 90, clientY: 90 });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("capture failed"));
  });

  describe("text intent", () => {
    it("sends the dragged region", async () => {
      const calls = mockOverlay({ intent: "text" });
      render(<RegionOverlay />);
      const overlay = await ready();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Drag over the text to copy it. Esc cancels.",
      );

      fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 50 });
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 90 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 300, clientY: 90 });

      await waitFor(() =>
        expect(last(calls)).toEqual({
          cmd: "overlay_finish",
          payload: {
            selection: {
              kind: "region",
              rect: { x: 100, y: 50, width: 200, height: 40 },
              viewportWidth: 1000,
            },
          },
        }),
      );
    });

    it("ignores windows: no hover highlight and no click", async () => {
      const calls = mockOverlay({ intent: "text" });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.mouseMove(overlay, { clientX: 150, clientY: 150 });
      expect(screen.queryByTestId("overlay-selection")).not.toBeInTheDocument();
      fireEvent.mouseDown(overlay, { button: 0, clientX: 150, clientY: 150 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 150, clientY: 150 });

      expect(calls.map((c) => c.cmd)).not.toContain("overlay_finish");
    });
  });

  describe("colour intent", () => {
    it("sends the clicked point", async () => {
      const calls = mockOverlay({ intent: "color" });
      render(<RegionOverlay />);
      const overlay = await ready();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Click to copy the colour under the cursor. Esc cancels.",
      );

      fireEvent.mouseMove(overlay, { clientX: 150, clientY: 160 });
      fireEvent.mouseDown(overlay, { button: 0, clientX: 150, clientY: 160 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 150, clientY: 160 });

      await waitFor(() =>
        expect(last(calls)).toEqual({
          cmd: "overlay_finish",
          payload: { selection: { kind: "point", x: 150, y: 160, viewportWidth: 1000 } },
        }),
      );
    });

    it("shows only the loupe: no selection, window highlight or guide lines", async () => {
      const calls = mockOverlay({ intent: "color" });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.mouseDown(overlay, { button: 0, clientX: 150, clientY: 150 });
      fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });

      expect(screen.getByTestId("overlay-loupe")).toBeInTheDocument();
      expect(screen.getByTestId("overlay-position")).toHaveTextContent("400, 400");
      expect(screen.queryByTestId("overlay-selection")).not.toBeInTheDocument();
      expect(screen.queryByTestId("overlay-guide-x")).not.toBeInTheDocument();
      expect(screen.getByRole("list")).not.toHaveTextContent("Shift");

      fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 400 });
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "point", x: 400, y: 400, viewportWidth: 1000 },
        }),
      );
    });
  });

  describe("as a spare, loaded before any selection", () => {
    it("draws nothing until a selection starts on it, then loads it once", async () => {
      let selecting = false;
      const calls: string[] = [];
      mockIPC(
        (cmd) => {
          calls.push(cmd);
          if (cmd === "overlay_info") {
            return selecting
              ? { mode: "region", monitorWidth: 1000, monitorHeight: 800, windows: [] }
              : null;
          }
          if (cmd === "overlay_image") return new ArrayBuffer(8);
          return null;
        },
        { shouldMockEvents: true },
      );
      render(<RegionOverlay />);
      const overlay = screen.getByTestId("overlay");

      await waitFor(() => expect(calls).toContain("overlay_info"));
      expect(overlay).toHaveAttribute("data-ready", "false");
      expect(overlay).toHaveAttribute("data-shown", "false");
      expect(screen.getByRole("status")).toHaveAttribute("data-error", "false");
      expect(calls).not.toContain("overlay_image");

      selecting = true;
      await emit(START_EVENT);

      await waitFor(() => expect(overlay).toHaveAttribute("data-ready", "true"));
      await waitFor(() => expect(calls).toContain("overlay_image"));
      expect(calls.filter((cmd) => cmd === "overlay_image")).toHaveLength(1);
    });
  });

  describe("in a see-through window, on screen ahead of its image", () => {
    beforeEach(() => {
      window.location.hash = "#/overlay?instant";
    });

    afterEach(() => {
      window.location.hash = "";
    });

    it("dims as soon as the selection is known, without waiting for the image", async () => {
      // No object URLs in jsdom: the image never loads here.
      mockOverlay();
      render(<RegionOverlay />);
      const overlay = await ready();

      expect(overlay).toHaveAttribute("data-shown", "true");
    });

    it("stays undimmed while it is a spare", async () => {
      const calls: string[] = [];
      mockIPC(
        (cmd) => {
          calls.push(cmd);
          return null;
        },
        { shouldMockEvents: true },
      );
      render(<RegionOverlay />);

      await waitFor(() => expect(calls).toContain("overlay_info"));
      expect(screen.getByTestId("overlay")).toHaveAttribute("data-shown", "false");
      expect(calls).not.toContain("overlay_ready");
    });

    it("labels the selection in image pixels before the image arrives", async () => {
      mockOverlay({ imageWidth: 2000 });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.mouseDown(overlay, { button: 0, clientX: 300, clientY: 250 });
      fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });

      expect(screen.getByTestId("overlay-selection")).toHaveTextContent("400 × 400");
    });
  });

  describe("with the frozen image loaded", () => {
    /** Stands in for the canvas jsdom lacks; every pixel reads as #1A2B3C. */
    function mockCanvas() {
      const context = {
        imageSmoothingEnabled: true,
        fillStyle: "",
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([26, 43, 60, 255]) })),
      };
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
        context as unknown as CanvasRenderingContext2D,
      );
      return context;
    }

    afterEach(() => {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    });

    /** Renders the overlay with a 2000 px wide image: two image px per CSS px. */
    async function renderLoaded(info: Partial<OverlayInfo> = {}) {
      // jsdom has no object URLs, and without one the overlay shows no image.
      Object.assign(URL, { createObjectURL: () => "blob:frozen", revokeObjectURL: () => {} });
      mockOverlay(info);
      const { container } = render(<RegionOverlay />);
      const overlay = await ready();
      const image = await waitFor(() => {
        const found = container.querySelector("img");
        expect(found).not.toBeNull();
        return found as HTMLImageElement;
      });
      Object.defineProperty(image, "naturalWidth", { value: 2000 });
      Object.defineProperty(image, "naturalHeight", { value: 1600 });
      fireEvent.load(image);
      // Counted as painted once decoded, which is asynchronous.
      await waitFor(() => expect(overlay).toHaveAttribute("data-shown", "true"));
      return overlay;
    }

    it("stays hidden until the frozen image has loaded, then fades in", async () => {
      Object.assign(URL, { createObjectURL: () => "blob:frozen", revokeObjectURL: () => {} });
      const calls = mockOverlay();
      const { container } = render(<RegionOverlay />);
      const overlay = await ready();
      const image = await waitFor(() => {
        const img = container.querySelector("img");
        expect(img).not.toBeNull();
        return img as HTMLImageElement;
      });

      expect(calls.some((call) => call.cmd === "overlay_ready")).toBe(false);
      expect(overlay).toHaveAttribute("data-shown", "false");

      fireEvent.load(image);

      await waitFor(() => expect(overlay).toHaveAttribute("data-shown", "true"));
      expect(calls.filter((call) => call.cmd === "overlay_ready")).toHaveLength(1);
    });

    it("magnifies the pixels around the cursor and names the centre colour", async () => {
      const context = mockCanvas();
      const overlay = await renderLoaded({ intent: "color" });

      fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });

      expect(screen.getByTestId("overlay-colour")).toHaveTextContent("#1A2B3C");
      expect(screen.getByTestId("overlay-position")).toHaveTextContent("200, 100");
      expect(context.imageSmoothingEnabled).toBe(false);
      // 15 image pixels each way, centred on the pixel under the cursor.
      expect(context.drawImage).toHaveBeenLastCalledWith(
        expect.anything(),
        193,
        93,
        15,
        15,
        0,
        0,
        15,
        15,
      );
    });

    it("labels the selection in image pixels", async () => {
      mockCanvas();
      const overlay = await renderLoaded();

      fireEvent.mouseDown(overlay, { button: 0, clientX: 300, clientY: 250 });
      fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });

      expect(screen.getByTestId("overlay-selection")).toHaveTextContent("400 × 400");
    });
  });
});
