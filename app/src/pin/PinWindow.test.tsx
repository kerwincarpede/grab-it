import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import PinWindow from "./PinWindow";
import { clampOpacity, MIN_OPACITY, wheelFactor, wheelOpacity, ZOOM_STEP } from "./api";

interface Backend {
  calls: { cmd: string; payload?: InvokeArgs }[];
}

function mockBackend(editable = true): Backend {
  const backend: Backend = { calls: [] };
  mockIPC((cmd, payload) => {
    backend.calls.push({ cmd, payload });
    switch (cmd) {
      case "pin_info":
        return { width: 900, height: 520, editable };
      case "pin_image":
        return new ArrayBuffer(4);
      default:
        return null;
    }
  });
  return backend;
}

const commands = (backend: Backend) =>
  backend.calls.map((call) => call.cmd).filter((cmd) => cmd !== "pin_info" && cmd !== "pin_image");

describe("PinWindow", () => {
  it("offers Copy, Annotate, resizing and Close", async () => {
    mockBackend();
    render(<PinWindow />);
    expect(await screen.findByRole("button", { name: "Annotate" })).toBeInTheDocument();
    for (const name of ["Copy", "Smaller", "Larger", "Lock", "Close"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("hides Annotate for an image pinned from the editor", async () => {
    const backend = mockBackend(false);
    render(<PinWindow />);
    await waitFor(() => expect(backend.calls.map((call) => call.cmd)).toContain("pin_info"));
    await screen.findByRole("button", { name: "Copy" });
    expect(screen.queryByRole("button", { name: "Annotate" })).not.toBeInTheDocument();
  });

  it("copies and says so", async () => {
    const backend = mockBackend();
    render(<PinWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
    expect(commands(backend)).toEqual(["pin_copy"]);
  });

  it("resizes with the buttons, the keyboard and the wheel", async () => {
    const backend = mockBackend();
    render(<PinWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Larger" }));
    fireEvent.keyDown(window, { key: "-" });
    fireEvent.wheel(window, { deltaY: -120 });

    await waitFor(() => expect(commands(backend)).toHaveLength(3));
    const factors = backend.calls
      .filter((call) => call.cmd === "pin_zoom")
      .map((call) => (call.payload as { factor: number }).factor);
    expect(factors).toEqual([ZOOM_STEP, 1 / ZOOM_STEP, ZOOM_STEP]);
  });

  it("fades with the slider and Ctrl/⌘ + wheel, leaving plain wheel to resize", async () => {
    const backend = mockBackend();
    render(<PinWindow />);
    const slider = await screen.findByRole("slider", { name: "Opacity" });
    const pin = screen.getByTestId("pin");
    expect(slider).toHaveValue("100");
    expect(pin.style.getPropertyValue("--pin-opacity")).toBe("1");

    fireEvent.change(slider, { target: { value: "50" } });
    expect(slider).toHaveValue("50");
    expect(pin.style.getPropertyValue("--pin-opacity")).toBe("0.5");

    fireEvent.wheel(window, { deltaY: 120, ctrlKey: true });
    expect(slider).toHaveValue("40");
    fireEvent.wheel(window, { deltaY: -120, metaKey: true });
    fireEvent.wheel(window, { deltaY: -120, metaKey: true });
    expect(slider).toHaveValue("60");
    expect(pin.style.getPropertyValue("--pin-opacity")).toBe("0.6");
    // Fading never resizes.
    expect(commands(backend)).toEqual([]);

    // Never fainter than the minimum.
    for (let i = 0; i < 10; i++) fireEvent.wheel(window, { deltaY: 120, ctrlKey: true });
    expect(slider).toHaveValue(String(MIN_OPACITY * 100));

    fireEvent.wheel(window, { deltaY: -120 });
    await waitFor(() => expect(commands(backend)).toEqual(["pin_zoom"]));
  });

  it("locks the pin and says how to unlock it", async () => {
    const backend = mockBackend();
    render(<PinWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Lock" }));
    expect(await screen.findByRole("status")).toHaveTextContent("tray menu");
    expect(commands(backend)).toEqual(["pin_lock"]);
  });

  it("nudges with the arrow keys, 1px or 10px with Shift", async () => {
    const backend = mockBackend();
    render(<PinWindow />);
    await screen.findByRole("button", { name: "Lock" });

    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });

    await waitFor(() => expect(commands(backend)).toHaveLength(4));
    const moves = backend.calls.filter((call) => call.cmd === "pin_nudge").map((call) => call.payload);
    expect(moves).toEqual([
      { dx: 1, dy: 0 },
      { dx: 0, dy: -1 },
      { dx: -10, dy: 0 },
      { dx: 0, dy: 10 },
    ]);
  });

  it("leaves the arrow keys to the opacity slider while it has focus", async () => {
    const backend = mockBackend();
    render(<PinWindow />);
    const slider = await screen.findByRole("slider", { name: "Opacity" });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(commands(backend)).not.toContain("pin_nudge");
  });

  it("closes on Escape and on a double-click, once", async () => {
    const backend = mockBackend();
    render(<PinWindow />);
    await screen.findByRole("button", { name: "Close" });

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.doubleClick(screen.getByTestId("pin"));

    await waitFor(() => expect(commands(backend)).toEqual(["pin_close"]));
  });

  it("does not close when a toolbar button is double-clicked", async () => {
    const backend = mockBackend();
    render(<PinWindow />);
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Larger" }));
    expect(commands(backend)).not.toContain("pin_close");
  });
});

describe("wheelFactor", () => {
  it("grows on scroll up and shrinks on scroll down", () => {
    expect(wheelFactor(-100)).toBe(ZOOM_STEP);
    expect(wheelFactor(100)).toBe(1 / ZOOM_STEP);
    expect(wheelFactor(0)).toBeNull();
  });
});

describe("opacity", () => {
  it("steps by 10% and stays between the minimum and fully solid", () => {
    expect(wheelOpacity(1, 100)).toBe(0.9);
    expect(wheelOpacity(0.9, -100)).toBe(1);
    expect(wheelOpacity(1, -100)).toBe(1);
    expect(wheelOpacity(MIN_OPACITY, 100)).toBe(MIN_OPACITY);
    expect(wheelOpacity(0.5, 0)).toBe(0.5);
    expect(clampOpacity(0.33)).toBe(0.3);
    expect(clampOpacity(0)).toBe(MIN_OPACITY);
    expect(clampOpacity(Number.NaN)).toBe(1);
  });
});
