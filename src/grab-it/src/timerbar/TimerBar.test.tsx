import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import TimerBar from "./TimerBar";
import { endsFromHash, secondsLeft } from "./api";
import { routeFromHash } from "../routes";

function backend(fail = false) {
  const calls: { cmd: string; payload?: InvokeArgs }[] = [];
  mockIPC((cmd, payload) => {
    calls.push({ cmd, payload });
    if (cmd === "timer_bar_cancel" && fail) throw new Error("no countdown");
    return null;
  });
  return calls;
}

function openAt(ends: number) {
  window.location.hash = `#/timerbar?ends=${ends}`;
}

afterEach(() => {
  vi.useRealTimers();
  window.location.hash = "";
});

describe("secondsLeft", () => {
  it("rounds the seconds left up", () => {
    expect(secondsLeft(10_000, 0)).toBe(10);
    expect(secondsLeft(10_000, 1)).toBe(10);
    expect(secondsLeft(10_000, 1_000)).toBe(9);
    expect(secondsLeft(10_000, 9_001)).toBe(1);
  });

  it("never shows less than 1", () => {
    expect(secondsLeft(10_000, 10_000)).toBe(1);
    expect(secondsLeft(10_000, 12_000)).toBe(1);
    expect(secondsLeft(null, 0)).toBe(1);
  });

  it("reads the end time from the hash", () => {
    expect(endsFromHash("#/timerbar?ends=1700000010000")).toBe(1_700_000_010_000);
    expect(endsFromHash("#/timerbar")).toBeNull();
    expect(endsFromHash("#/timerbar?ends=soon")).toBeNull();
  });
});

describe("TimerBar", () => {
  it("counts down the seconds left", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1_000_000);
    backend();
    openAt(1_000_000 + 3_000);
    render(<TimerBar />);
    expect(screen.getByRole("timer", { name: "Seconds left" })).toHaveTextContent("3");
    expect(screen.getByText("Capturing…")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByRole("timer", { name: "Seconds left" })).toHaveTextContent("2");
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(screen.getByRole("timer", { name: "Seconds left" })).toHaveTextContent("1");
  });

  it("cancels the capture once", async () => {
    const calls = backend();
    openAt(Date.now() + 10_000);
    render(<TimerBar />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await userEvent.click(cancel);
    expect(cancel).toBeDisabled();
    await userEvent.click(cancel);
    expect(calls.filter((call) => call.cmd === "timer_bar_cancel")).toHaveLength(1);
  });

  it("can be pressed again when cancelling failed", async () => {
    backend(true);
    const error = console.error;
    console.error = () => {};
    try {
      openAt(Date.now() + 10_000);
      render(<TimerBar />);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled());
    } finally {
      console.error = error;
    }
  });

  it("is the timerbar route", () => {
    expect(routeFromHash("#/timerbar?ends=1700000010000")).toBe("timerbar");
  });
});
