import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuickAccess from "./QuickAccess";
import { describeText, dismissAfter, type QuickItem } from "./api";

const CAPTURE: QuickItem = {
  kind: "capture",
  path: "/shots/originals/Grab-it 2026-03-07 09-05-01.png",
  fileName: "Grab-it 2026-03-07 09-05-01.png",
  width: 900,
  height: 520,
  copied: true,
};

interface Backend {
  calls: { cmd: string; payload?: InvokeArgs }[];
  failAction?: string;
}

function mockBackend(item: QuickItem | null, options: Partial<Backend> = {}): Backend {
  const backend: Backend = { calls: [], ...options };
  mockIPC((cmd, payload) => {
    backend.calls.push({ cmd, payload });
    switch (cmd) {
      case "quick_info":
        return item;
      case "quick_thumbnail":
        return new ArrayBuffer(4);
      case "quick_action":
        if (backend.failAction) throw backend.failAction;
        return null;
      default:
        // Event plumbing (`plugin:event|listen`) and anything else.
        return null;
    }
  });
  return backend;
}

const actions = (backend: Backend) =>
  backend.calls.filter((call) => call.cmd === "quick_action").map((call) => (call.payload as { action: string }).action);

afterEach(() => {
  vi.useRealTimers();
});

describe("QuickAccess", () => {
  it("shows a capture with its size, that it was copied, and its actions", async () => {
    mockBackend(CAPTURE);
    render(<QuickAccess />);

    expect(await screen.findByRole("button", { name: `Annotate ${CAPTURE.fileName}` })).toBeInTheDocument();
    expect(screen.getByText("900 × 520")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    const toolbar = screen.getByRole("toolbar", { name: "Capture actions" });
    expect(toolbar).toHaveTextContent("Copy");
    expect(toolbar).toHaveTextContent("Annotate");
    expect(toolbar).toHaveTextContent("Pin");
    expect(screen.getByRole("button", { name: "Show in folder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("does not claim a copy that did not happen", async () => {
    mockBackend({ ...CAPTURE, copied: false });
    render(<QuickAccess />);
    await screen.findByRole("toolbar", { name: "Capture actions" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each([
    ["Copy", "copy"],
    ["Annotate", "edit"],
    ["Pin", "pin"],
    ["Show in folder", "reveal"],
    ["Delete", "delete"],
    ["Dismiss", "close"],
  ])("%s runs the %s action", async (name, action) => {
    const backend = mockBackend({ ...CAPTURE, copied: false });
    render(<QuickAccess />);
    const toolbar = await screen.findByRole("toolbar", { name: "Capture actions" });
    // "Annotate" also names the preview; the toolbar's button is meant here.
    const button =
      name === "Dismiss"
        ? screen.getByRole("button", { name })
        : Array.from(toolbar.querySelectorAll("button")).find(
            (candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name,
          );
    expect(button).toBeDefined();

    await userEvent.click(button as HTMLElement);

    await waitFor(() => expect(actions(backend)).toEqual([action]));
  });

  it("confirms a copy made from the card", async () => {
    mockBackend({ ...CAPTURE, copied: false });
    render(<QuickAccess />);
    const toolbar = await screen.findByRole("toolbar", { name: "Capture actions" });
    await userEvent.click(toolbar.querySelector("button") as HTMLElement);
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
  });

  it("shows why an action failed and keeps the card", async () => {
    mockBackend(CAPTURE, { failAction: "could not copy to the clipboard: busy" });
    render(<QuickAccess />);
    const toolbar = await screen.findByRole("toolbar", { name: "Capture actions" });
    await userEvent.click(toolbar.querySelector("button") as HTMLElement);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not copy to the clipboard: busy");
  });

  it("shows copied text with a count", async () => {
    mockBackend({ kind: "text", text: "Invoice 2026-03\nTotal due: $12" });
    render(<QuickAccess />);
    expect(await screen.findByText("Text copied")).toBeInTheDocument();
    expect(screen.getByText("2 lines, 30 characters")).toBeInTheDocument();
    expect(screen.getByText(/Invoice 2026-03/)).toBeInTheDocument();
  });

  it("shows a picked colour", async () => {
    mockBackend({ kind: "colour", hex: "#EF4444", rgb: "rgb(239, 68, 68)" });
    render(<QuickAccess />);
    expect(await screen.findByText("#EF4444")).toBeInTheDocument();
    expect(screen.getByText("rgb(239, 68, 68)")).toBeInTheDocument();
  });

  it("shows a failure as an alert", async () => {
    mockBackend({ kind: "error", message: "could not capture the screen" });
    render(<QuickAccess />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not capture the screen");
  });

  it("dismisses itself after its time is up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = mockBackend({ kind: "colour", hex: "#EF4444", rgb: "rgb(239, 68, 68)" });
    render(<QuickAccess />);
    await screen.findByText("#EF4444");
    expect(actions(backend)).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });

    expect(actions(backend)).toEqual(["close"]);
  });

  it("stays while the pointer rests on it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = mockBackend({ kind: "colour", hex: "#EF4444", rgb: "rgb(239, 68, 68)" });
    render(<QuickAccess />);
    await screen.findByText("#EF4444");

    await userEvent.hover(screen.getByTestId("quick"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(actions(backend)).toEqual([]);

    await userEvent.unhover(screen.getByTestId("quick"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(actions(backend)).toEqual(["close"]);
  });

  it("waits for as long as work is under way", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = mockBackend({ kind: "working", message: "Reading text…" });
    render(<QuickAccess />);
    await screen.findByText("Reading text…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(actions(backend)).toEqual([]);
  });
});

describe("quick helpers", () => {
  it("gives captures longer than notices, and work no limit", () => {
    expect(dismissAfter(CAPTURE)).toBe(8000);
    expect(dismissAfter({ kind: "text", text: "x" })).toBe(5000);
    expect(dismissAfter({ kind: "working", message: "…" })).toBeNull();
    expect(dismissAfter({ kind: "error", message: "x" })).toBe(10000);
  });

  it("counts lines and characters", () => {
    expect(describeText("one")).toBe("1 line, 3 characters");
    expect(describeText("a\n\nb")).toBe("2 lines, 4 characters");
    expect(describeText("x")).toBe("1 line, 1 character");
  });
});
