import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import PinWindow from "./PinWindow";
import { wheelFactor, ZOOM_STEP } from "./api";

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
    for (const name of ["Copy", "Smaller", "Larger", "Close"]) {
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
