import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuickAccess from "./QuickAccess";
import { describeText, dismissAfter, formatBytes, formatElapsed, type QuickItem } from "./api";

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
        return item && { generation: 7, item };
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

const actionCalls = (backend: Backend) =>
  backend.calls
    .filter((call) => call.cmd === "quick_action")
    .map((call) => call.payload as { action: string; generation: number });
const actions = (backend: Backend) => actionCalls(backend).map((call) => call.action);

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

  it("says which card an action was clicked on", async () => {
    const backend = mockBackend(CAPTURE);
    render(<QuickAccess />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(actionCalls(backend)).toEqual([{ action: "delete", generation: 7 }]));
  });

  it("runs Pin once however fast it is clicked", async () => {
    const backend = mockBackend(CAPTURE);
    render(<QuickAccess />);
    const toolbar = await screen.findByRole("toolbar", { name: "Capture actions" });
    const pin = Array.from(toolbar.querySelectorAll("button")).find((button) => button.textContent === "Pin");
    await userEvent.dblClick(pin as HTMLElement);
    await waitFor(() => expect(actions(backend)).toEqual(["pin"]));
  });

  it("lets Copy be repeated", async () => {
    const backend = mockBackend({ ...CAPTURE, copied: false });
    render(<QuickAccess />);
    const toolbar = await screen.findByRole("toolbar", { name: "Capture actions" });
    const copy = toolbar.querySelector("button") as HTMLElement;
    await userEvent.click(copy);
    await userEvent.click(copy);
    await waitFor(() => expect(actions(backend)).toEqual(["copy", "copy"]));
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

  it("clears itself once dismissed, ready to be reused", async () => {
    const backend = mockBackend({ kind: "colour", hex: "#EF4444", rgb: "rgb(239, 68, 68)" });
    render(<QuickAccess />);
    await screen.findByText("#EF4444");

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(screen.queryByText("#EF4444")).not.toBeInTheDocument());
    expect(actions(backend)).toEqual(["close"]);
  });

  it("shows a recording's clock and stops it", async () => {
    const backend = mockBackend({ kind: "recording", startedAt: Date.now() - 65_000, maxSeconds: 60 });
    render(<QuickAccess />);
    expect(await screen.findByText("Recording")).toBeInTheDocument();
    expect(screen.getByText(/^1:0\d of 1:00$/)).toBeInTheDocument();
    // Nothing dismisses a recording but Stop.
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    expect(backend.calls.map((call) => call.cmd)).toContain("record_stop");
  });

  it("shows a saved recording with its length and size", async () => {
    const backend = mockBackend({
      kind: "recorded",
      path: "/shots/recordings/Grab-it 2026-03-07 09-05-01.gif",
      fileName: "Grab-it 2026-03-07 09-05-01.gif",
      durationMs: 6100,
      bytes: 720_815,
    });
    render(<QuickAccess />);
    expect(await screen.findByText("GIF saved")).toBeInTheDocument();
    expect(screen.getByText("0:06 · 704 KB")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(actions(backend)).toEqual(["reveal"]));
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

  it("formats a clock and a file size", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(61_000)).toBe("1:01");
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(2_816_389)).toBe("2.7 MB");
  });

  it("counts lines and characters", () => {
    expect(describeText("one")).toBe("1 line, 3 characters");
    expect(describeText("a\n\nb")).toBe("2 lines, 4 characters");
    expect(describeText("x")).toBe("1 line, 1 character");
  });
});
