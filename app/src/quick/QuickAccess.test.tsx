import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import QuickAccess from "./QuickAccess";
import {
  codeFormats,
  describeCodes,
  describeText,
  dismissAfter,
  firstLink,
  formatBytes,
  formatElapsed,
  formatName,
  type QuickCode,
  type QuickItem,
} from "./api";
import { LIBRARY_CHANGED_EVENT, type ShotText } from "../library/api";

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
  /** What `library_text` answers; the capture is not in the library when unset. */
  text?: ShotText;
  /** Mock Tauri events, so tests can emit them. */
  events?: boolean;
}

/** The capture's id in the mocked library. */
const SHOT_ID = 42;

function mockBackend(item: QuickItem | null, options: Partial<Backend> = {}): Backend {
  const backend: Backend = { calls: [], ...options };
  mockIPC(
    (cmd, payload) => {
      backend.calls.push({ cmd, payload });
      switch (cmd) {
        case "quick_info":
          return item && { generation: 7, item };
        case "quick_thumbnail":
          return new ArrayBuffer(4);
        case "quick_action":
          if (backend.failAction) throw backend.failAction;
          return null;
        case "library_shot_id":
          return backend.text ? SHOT_ID : null;
        case "library_text":
          return backend.text;
        case "library_copy_text":
          return backend.text?.state === "read" ? backend.text.text : null;
        default:
          // Event plumbing (`plugin:event|listen`) and anything else.
          return null;
      }
    },
    { shouldMockEvents: backend.events },
  );
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

  it("offers Copy text once the capture's text has been read, and copies it", async () => {
    const backend = mockBackend(
      { ...CAPTURE, copied: false },
      { text: { state: "read", text: "Invoice 2026-03\nTotal due: $12" } },
    );
    render(<QuickAccess />);

    await userEvent.click(await screen.findByRole("button", { name: "Copy text" }));

    await waitFor(() => expect(backend.calls.filter((call) => call.cmd === "library_copy_text")).toHaveLength(1));
    expect(backend.calls.find((call) => call.cmd === "library_shot_id")?.payload).toEqual({ path: CAPTURE.path });
    expect(backend.calls.find((call) => call.cmd === "library_copy_text")?.payload).toEqual({ id: SHOT_ID });
    expect(await screen.findByRole("status")).toHaveTextContent("Copied 2 lines of text");
    // Copy text leaves the card up.
    expect(actions(backend)).toEqual([]);
  });

  it("says it is reading the text until OCR finishes", async () => {
    const backend = mockBackend(CAPTURE, { text: { state: "waiting" }, events: true });
    render(<QuickAccess />);

    expect(await screen.findByRole("button", { name: "Reading text…" })).toBeDisabled();
    // Let the event listeners finish registering.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    backend.text = { state: "read", text: "Hello" };
    await act(async () => {
      await emit(LIBRARY_CHANGED_EVENT);
    });

    expect(await screen.findByRole("button", { name: "Copy text" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Reading text…" })).not.toBeInTheDocument();
  });

  it.each<[string, ShotText | undefined]>([
    ["is not in the library", undefined],
    ["could not be read", { state: "failed" }],
    ["has no text", { state: "read", text: "  " }],
  ])("offers no Copy text when the capture %s", async (_, text) => {
    const backend = mockBackend(CAPTURE, { text });
    render(<QuickAccess />);
    await screen.findByRole("toolbar", { name: "Capture actions" });
    await waitFor(() => expect(backend.calls.some((call) => call.cmd === "library_shot_id")).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByRole("button", { name: "Copy text" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reading text…" })).not.toBeInTheDocument();
  });

  it("shows copied text with a count", async () => {
    mockBackend({ kind: "text", text: "Invoice 2026-03\nTotal due: $12" });
    render(<QuickAccess />);
    expect(await screen.findByText("Text copied")).toBeInTheDocument();
    expect(screen.getByText("2 lines, 30 characters")).toBeInTheDocument();
    expect(screen.getByText(/Invoice 2026-03/)).toBeInTheDocument();
  });

  it("says the AI is tidying the text, and stays until it is done", async () => {
    mockBackend({ kind: "text", text: "{a: l}", tidy: { state: "working", by: "Claude Code" } });
    render(<QuickAccess />);
    expect(await screen.findByText("Text copied")).toBeInTheDocument();
    expect(screen.getByTestId("quick-tidy")).toHaveTextContent("Claude Code is tidying it up…");
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("shows tidied JSON with both copies on offer", async () => {
    const backend = mockBackend({
      kind: "text",
      text: '{\n  "a": 1\n}',
      original: "{a: l}",
      tidy: { state: "done", by: "Claude Code", format: "json", language: null, changed: true, copied: true },
    });
    render(<QuickAccess />);
    expect(await screen.findByTestId("quick-tidy")).toHaveTextContent("Tidied by Claude Code · JSON");
    expect(screen.getByText("Text copied")).toBeInTheDocument();
    expect(screen.getByText(/"a": 1/)).toHaveClass("is-code");

    await userEvent.click(screen.getByRole("button", { name: "Copy as read" }));
    await waitFor(() => expect(actions(backend)).toEqual(["copyOriginal"]));
    expect(await screen.findByText("Copied as read")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(actions(backend)).toEqual(["copyOriginal", "copy"]));
  });

  it("leaves tidied text for Copy when something else was copied meanwhile", async () => {
    mockBackend({
      kind: "text",
      text: "def f():\n    return 1",
      original: "def f():\nreturn l",
      tidy: { state: "done", by: "Codex", format: "code", language: "python", changed: true, copied: false },
    });
    render(<QuickAccess />);
    expect(await screen.findByText("Text tidied")).toBeInTheDocument();
    expect(screen.queryByText("Text copied")).not.toBeInTheDocument();
    expect(screen.getByTestId("quick-tidy")).toHaveTextContent("Tidied by Codex · Python");
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("says when the AI found nothing to change or could not tidy", async () => {
    mockBackend({
      kind: "text",
      text: "Hello",
      tidy: { state: "done", by: "Claude Code", format: "plain", language: null, changed: false, copied: true },
    });
    const { unmount } = render(<QuickAccess />);
    expect(await screen.findByTestId("quick-tidy")).toHaveTextContent(/^Checked by Claude Code$/);
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    unmount();

    mockBackend({ kind: "text", text: "Hello", tidy: { state: "failed", by: "Claude Code", message: "not signed in" } });
    render(<QuickAccess />);
    const failed = await screen.findByTestId("quick-tidy");
    expect(failed).toHaveTextContent("Claude Code could not tidy it up");
    expect(failed).toHaveAttribute("title", "not signed in");
    expect(screen.getByText("Text copied")).toBeInTheDocument();
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
      await vi.advanceTimersByTimeAsync(8100);
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
      await vi.advanceTimersByTimeAsync(8100);
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
      format: "gif",
    });
    render(<QuickAccess />);
    expect(await screen.findByText("GIF saved")).toBeInTheDocument();
    expect(screen.getByText("0:06 · 704 KB")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(actions(backend)).toEqual(["reveal"]));
  });

  it("shows only the elapsed time while an MP4 records", async () => {
    mockBackend({ kind: "recording", startedAt: Date.now() - 75_000 });
    render(<QuickAccess />);
    expect(await screen.findByText("Recording")).toBeInTheDocument();
    expect(screen.getByText(/^1:1\d$/)).toBeInTheDocument();
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument();
  });

  it("says a video was saved, and offers its folder", async () => {
    const backend = mockBackend({
      kind: "recorded",
      path: "/shots/recordings/Grab-it 2026-03-07 09-05-01.mp4",
      fileName: "Grab-it 2026-03-07 09-05-01.mp4",
      durationMs: 70_000,
      bytes: 5_242_880,
      format: "mp4",
    });
    render(<QuickAccess />);
    expect(await screen.findByText("Video saved")).toBeInTheDocument();
    expect(screen.queryByText("GIF saved")).not.toBeInTheDocument();
    expect(screen.getByText("Grab-it 2026-03-07 09-05-01.mp4")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(actions(backend)).toEqual(["reveal"]));
  });

  it("says why an MP4 recording was saved as a GIF", async () => {
    mockBackend({
      kind: "recorded",
      path: "/shots/recordings/Grab-it 2026-03-07 09-05-01.gif",
      fileName: "Grab-it 2026-03-07 09-05-01.gif",
      durationMs: 4000,
      bytes: 300_000,
      format: "gif",
      fallback: "Saved as a GIF: ffmpeg, which MP4 needs, is still downloading.",
    });
    render(<QuickAccess />);
    expect(await screen.findByText("GIF saved")).toBeInTheDocument();
    expect(screen.getByText("Saved as a GIF: ffmpeg, which MP4 needs, is still downloading.")).toBeInTheDocument();
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

const LINK: QuickCode = { format: "QR code", value: "https://example.com/menu", isLink: true };
const BARCODE: QuickCode = { format: "Code 128", value: "GRAB-IT 0043", isLink: false };

describe("QuickAccess code card", () => {
  it("shows a code's value as copied, with only Copy when there is no text or link", async () => {
    mockBackend({ kind: "code", codes: [BARCODE], text: "" });
    render(<QuickAccess />);
    expect(await screen.findByText("Code 128 copied")).toBeInTheDocument();
    expect(screen.getByTestId("quick-codes")).toHaveTextContent("GRAB-IT 0043");
    const toolbar = screen.getByRole("toolbar", { name: "Code actions" });
    expect(Array.from(toolbar.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Copy"]);
    expect(screen.queryByRole("button", { name: "Copy text" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open link" })).not.toBeInTheDocument();
  });

  it("shows several codes one per line, with their formats", async () => {
    mockBackend({ kind: "code", codes: [LINK, BARCODE, { ...LINK, value: "second QR", isLink: false }], text: "" });
    render(<QuickAccess />);
    expect(await screen.findByText("3 codes copied")).toBeInTheDocument();
    expect(screen.getByText("QR code · Code 128")).toBeInTheDocument();
    expect(screen.getByTestId("quick-codes").textContent).toBe("https://example.com/menu\nGRAB-IT 0043\nsecond QR");
  });

  it("offers the text around a code, and a link to open, only when there are some", async () => {
    mockBackend({ kind: "code", codes: [LINK], text: "Scan for the menu" });
    render(<QuickAccess />);
    expect(await screen.findByText("QR code copied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy text" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open link" })).toHaveAttribute(
      "title",
      "Open https://example.com/menu in your browser",
    );
  });

  it("treats text that is only whitespace as none", async () => {
    mockBackend({ kind: "code", codes: [LINK], text: " \n" });
    render(<QuickAccess />);
    await screen.findByText("QR code copied");
    expect(screen.queryByRole("button", { name: "Copy text" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open link" })).toBeInTheDocument();
  });

  it("copies the values and the text on request, and keeps the card", async () => {
    const backend = mockBackend({ kind: "code", codes: [LINK], text: "Scan for the menu" });
    render(<QuickAccess />);
    await userEvent.click(await screen.findByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(actions(backend)).toEqual(["copyText"]));
    expect(await screen.findByText("Text copied")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(actions(backend)).toEqual(["copyText", "copy"]));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("opens the link only when Open link is clicked, once", async () => {
    const backend = mockBackend({ kind: "code", codes: [LINK], text: "" });
    render(<QuickAccess />);
    const open = await screen.findByRole("button", { name: "Open link" });
    expect(actions(backend)).toEqual([]);
    await userEvent.dblClick(open);
    await waitFor(() => expect(actionCalls(backend)).toEqual([{ action: "openLink", generation: 7 }]));
  });
});

describe("quick helpers", () => {
  it("stays for the chosen time, longer for errors, and without limit for work", () => {
    expect(dismissAfter(CAPTURE)).toBe(8000);
    expect(dismissAfter(CAPTURE, 3)).toBe(3000);
    expect(dismissAfter({ kind: "text", text: "x" }, 20)).toBe(20000);
    expect(dismissAfter({ kind: "working", message: "…" })).toBeNull();
    expect(dismissAfter({ kind: "text", text: "x", tidy: { state: "working", by: "Codex" } }, 20)).toBeNull();
    expect(
      dismissAfter({ kind: "text", text: "x", tidy: { state: "failed", by: "Codex", message: "x" } }, 20),
    ).toBe(20000);
    expect(dismissAfter({ kind: "error", message: "x" }, 3)).toBe(10000);
    // "Until I close it".
    expect(dismissAfter(CAPTURE, 0)).toBeNull();
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

  it("names what tidied text was laid out as", () => {
    expect(formatName("json", null)).toBe("JSON");
    expect(formatName("table", null)).toBe("Table");
    expect(formatName("code", "python")).toBe("Python");
    expect(formatName("code", "typescript")).toBe("TypeScript");
    expect(formatName("code", null)).toBe("Code");
    expect(formatName("plain", null)).toBeNull();
  });

  it("describes the codes found and picks the link to open", () => {
    expect(describeCodes([LINK])).toBe("QR code copied");
    expect(describeCodes([LINK, BARCODE])).toBe("2 codes copied");
    expect(codeFormats([LINK, BARCODE, LINK])).toBe("QR code · Code 128");
    expect(firstLink([BARCODE, LINK])).toBe("https://example.com/menu");
    expect(firstLink([BARCODE])).toBeNull();
    expect(dismissAfter({ kind: "code", codes: [LINK], text: "" }, 5)).toBe(5000);
  });

  it("counts lines and characters", () => {
    expect(describeText("one")).toBe("1 line, 3 characters");
    expect(describeText("a\n\nb")).toBe("2 lines, 4 characters");
    expect(describeText("x")).toBe("1 line, 1 character");
  });
});
