import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { describe, expect, it } from "vitest";
import { mockCommands } from "../test/mockCommands";
import ScrollBar from "./ScrollBar";
import { SCROLL_BAR_STATE_EVENT, type ScrollBarState } from "./api";
import { routeFromHash } from "../routes";

const STATE: ScrollBarState = {
  sessionId: 7,
  width: 1200,
  height: 4800,
  length: 4800,
  progress: 0.16,
  capped: false,
  autoScrolling: true,
  message: null,
  saving: false,
  preview: "data:image/png;base64,AAAA",
};

function backend(state: ScrollBarState | null = STATE, fail = false) {
  return mockCommands(
    {
      scroll_bar_state: () => state,
      scroll_done: () => {
        if (fail) throw new Error("not running");
      },
      scroll_cancel: () => undefined,
    },
    { shouldMockEvents: true },
  );
}

describe("ScrollBar", () => {
  it("has its own route", () => {
    expect(routeFromHash("#/scrollbar")).toBe("scrollbar");
  });

  it("shows the length, progress, preview and what is happening", async () => {
    backend();
    render(<ScrollBar />);
    expect(await screen.findByText("1200 × 4800")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "16");
    expect(screen.getByRole("img")).toHaveAttribute("src", STATE.preview);
    expect(screen.getByRole("status")).toHaveTextContent("Scrolling for you. Leave the mouse and trackpad alone.");
  });

  it("follows the states the capture sends, such as scrolling too fast", async () => {
    backend();
    render(<ScrollBar />);
    await screen.findByText("1200 × 4800");
    await act(() =>
      emit(SCROLL_BAR_STATE_EVENT, {
        ...STATE,
        height: 6000,
        autoScrolling: false,
        message: "Scrolled too fast. Scroll back a little.",
      }),
    );
    expect(await screen.findByText("1200 × 6000")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Scrolled too fast. Scroll back a little.");
  });

  it("marks the length limit", async () => {
    backend({ ...STATE, progress: 1, capped: true, message: "The image has reached its length limit. Choose Done to save it." });
    render(<ScrollBar />);
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("data-capped", "true"));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("saves once with Done and says it is saving", async () => {
    const calls = backend();
    render(<ScrollBar />);
    const done = await screen.findByRole("button", { name: "Done" });
    await waitFor(() => expect(done).toBeEnabled());
    await userEvent.click(done);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    expect(calls.filter((call) => call.cmd === "scroll_done").map((call) => call.payload)).toEqual([{ sessionId: 7 }]);
  });

  it("cancels the session it shows", async () => {
    const calls = backend();
    render(<ScrollBar />);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toBeEnabled());
    await userEvent.click(cancel);
    expect(calls.filter((call) => call.cmd === "scroll_cancel").map((call) => call.payload)).toEqual([{ sessionId: 7 }]);
  });

  it("can be pressed again when Done failed", async () => {
    backend(STATE, true);
    render(<ScrollBar />);
    const done = await screen.findByRole("button", { name: "Done" });
    await waitFor(() => expect(done).toBeEnabled());
    await userEvent.click(done);
    expect(await screen.findByText("not running")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  });
});
