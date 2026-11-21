import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { mockCommands, type CommandCall } from "../test/mockCommands";
import { describe, expect, it } from "vitest";
import RecordBar from "./RecordBar";
import { RECORD_BAR_EVENT, countdownLeft, formatClock, recordedMs, type BarStatus } from "./api";

const RECORDING: BarStatus = {
  phase: "recording",
  countdownEndsAt: null,
  startedAt: Date.now() - 65_000,
  pausedMs: 0,
  pausedAt: null,
  maxSeconds: null,
  format: "mp4",
  microphone: false,
  system: null,
  webcam: false,
};

interface Backend {
  calls: CommandCall[];
}

function mockBackend(status: BarStatus | null, options: { up?: boolean; level?: number } = {}): Backend {
  const calls = mockCommands(
    {
      record_bar_status: () => status,
      record_bar_fit: () => ({ up: options.up ?? false }),
      record_bar_level: () => options.level ?? 0,
    },
    { shouldMockEvents: true, otherwise: () => null },
  );
  return { calls };
}

const called = (backend: Backend, cmd: string) => backend.calls.filter((call) => call.cmd === cmd);
const lastFit = (backend: Backend) => {
  const fits = called(backend, "record_bar_fit");
  return fits[fits.length - 1]?.payload;
};

describe("the clock", () => {
  it("counts only the time it recorded, not paused", () => {
    const status = { ...RECORDING, startedAt: 1_000, pausedMs: 4_000, pausedAt: null };
    expect(recordedMs(status, 20_000)).toBe(15_000);
    expect(recordedMs({ ...status, pausedAt: 10_000 }, 20_000)).toBe(5_000);
    expect(recordedMs({ ...status, startedAt: null }, 20_000)).toBe(0);
  });

  it("reads as minutes and seconds, and hours once it runs that long", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_400)).toBe("1:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });

  it("counts down in whole seconds, never showing 0", () => {
    const status = { ...RECORDING, phase: "countdown" as const, countdownEndsAt: 10_000 };
    expect(countdownLeft(status, 7_100)).toBe(3);
    expect(countdownLeft(status, 9_990)).toBe(1);
    expect(countdownLeft(status, 12_000)).toBe(1);
  });
});

describe("RecordBar", () => {
  it("shows the time, the microphone, Pause and Stop while it records", async () => {
    mockBackend(RECORDING);
    render(<RecordBar />);
    expect(await screen.findByRole("timer")).toHaveTextContent(/^1:0\d$/);
    expect(screen.getByRole("button", { name: "Mute the microphone" })).toBeInTheDocument();
    expect(screen.getByTestId("recordbar-meter")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("labels Pause and Stop in words, with Stop as the red pill", async () => {
    mockBackend(RECORDING);
    render(<RecordBar />);
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(stop).toHaveClass("recordbar-stop");
    expect(stop).toHaveTextContent("Stop");
    expect(stop).toHaveAttribute("title", "Stop and save");
    expect(screen.getByRole("button", { name: "Pause" })).toHaveTextContent("Pause");
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("PAUSED")).not.toBeInTheDocument();
  });

  it("turns the dot amber and says PAUSED while paused, with Resume in place of Pause", async () => {
    const backend = mockBackend({ ...RECORDING, pausedAt: Date.now() });
    render(<RecordBar />);
    const resume = await screen.findByRole("button", { name: "Resume" });
    expect(resume).toHaveTextContent("Resume");
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.getByText("PAUSED")).toBeInTheDocument();
    const bar = screen.getByTestId("recordbar");
    expect(bar.querySelector(".recordbar-dot")).toHaveAttribute("data-paused", "true");
    expect(bar.querySelector(".recordbar-pill")).toHaveAttribute("data-paused", "true");
    // Stop still saves what was recorded before the pause.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await userEvent.click(resume);
    await waitFor(() => expect(called(backend, "record_pause")[0].payload).toEqual({ paused: false }));
  });

  it("stops and saves from the Stop pill", async () => {
    const backend = mockBackend(RECORDING);
    render(<RecordBar />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(called(backend, "record_stop")).toHaveLength(1));
    expect(called(backend, "record_pause")).toHaveLength(0);
  });

  it("shows a GIF's limit beside its time", async () => {
    mockBackend({ ...RECORDING, format: "gif", maxSeconds: 60, microphone: null });
    render(<RecordBar />);
    expect(await screen.findByRole("timer")).toHaveTextContent(/^1:0\d \/ 1:00$/);
    expect(screen.queryByRole("button", { name: /microphone/ })).not.toBeInTheDocument();
  });

  it("fits its window to the pill", async () => {
    const backend = mockBackend(RECORDING);
    render(<RecordBar />);
    await screen.findByRole("timer");
    await waitFor(() => expect(called(backend, "record_bar_fit").length).toBeGreaterThan(0));
    expect(lastFit(backend)).toMatchObject({ menu: null });
  });

  it("stops, pauses and mutes through the backend", async () => {
    const backend = mockBackend(RECORDING);
    render(<RecordBar />);
    await userEvent.click(await screen.findByRole("button", { name: "Mute the microphone" }));
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(called(backend, "record_stop")).toHaveLength(1));
    expect(called(backend, "record_mute")[0].payload).toEqual({ input: "microphone", muted: true });
    expect(called(backend, "record_pause")[0].payload).toEqual({ paused: true });
  });

  it("follows what the backend says, such as a pause", async () => {
    mockBackend(RECORDING);
    render(<RecordBar />);
    await screen.findByRole("button", { name: "Pause" });
    await act(() => emit(RECORD_BAR_EVENT, { ...RECORDING, pausedAt: Date.now(), microphone: true }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveAccessibleName("Paused");
    expect(screen.getByText("PAUSED")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn the microphone on" })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers the system sound on the pill when there is no microphone", async () => {
    const backend = mockBackend({ ...RECORDING, microphone: null, system: false });
    render(<RecordBar />);
    await userEvent.click(await screen.findByRole("button", { name: "Mute the system sound" }));
    await waitFor(() => expect(called(backend, "record_mute")[0].payload).toEqual({ input: "system", muted: true }));
  });

  it("opens a menu of the rest and fits the window to it", async () => {
    const backend = mockBackend({ ...RECORDING, system: false });
    render(<RecordBar />);
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    expect(screen.getByRole("menu", { name: "Recording options" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Microphone" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "System sound" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Webcam" })).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(lastFit(backend)).toMatchObject({ menu: expect.any(Number) }));

    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Webcam" }));
    await waitFor(() => expect(called(backend, "record_webcam")[0].payload).toEqual({ shown: true }));

    await userEvent.click(screen.getByRole("menuitem", { name: "Restart" }));
    await waitFor(() => expect(called(backend, "record_restart")).toHaveLength(1));
    // Choosing an action closes the menu.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("discards and moves itself back from the menu", async () => {
    const backend = mockBackend(RECORDING);
    render(<RecordBar />);
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Discard" }));
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Move back to the top" }));
    await waitFor(() => expect(called(backend, "record_bar_reset")).toHaveLength(1));
    expect(called(backend, "record_discard")).toHaveLength(1);
  });

  it("puts the menu above the pill when the backend opens it upwards", async () => {
    mockBackend(RECORDING, { up: true });
    render(<RecordBar />);
    await userEvent.click(await screen.findByRole("button", { name: "More" }));
    await waitFor(() => expect(screen.getByTestId("recordbar")).toHaveAttribute("data-up", "true"));
    const bar = screen.getByTestId("recordbar");
    expect(bar.firstElementChild).toContainElement(screen.getByRole("menu"));
  });

  it("counts down with a way to cancel", async () => {
    const backend = mockBackend({ ...RECORDING, phase: "countdown", startedAt: null, countdownEndsAt: Date.now() + 2_500 });
    render(<RecordBar />);
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel recording" })).toHaveTextContent("Cancel");
    await userEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    await waitFor(() => expect(called(backend, "record_stop")).toHaveLength(1));
  });

  it("says it is saving once stopped", async () => {
    mockBackend({ ...RECORDING, phase: "saving" });
    render(<RecordBar />);
    expect(await screen.findByRole("status")).toHaveTextContent("Saving…");
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("shows nothing when nothing is recording", async () => {
    const backend = mockBackend(null);
    render(<RecordBar />);
    await waitFor(() => expect(called(backend, "record_bar_status")).toHaveLength(1));
    expect(screen.queryByTestId("recordbar")).not.toBeInTheDocument();
  });

  it("lights the meter as loud as the microphone is", async () => {
    mockBackend(RECORDING, { level: 0.25 });
    render(<RecordBar />);
    const meter = await screen.findByTestId("recordbar-meter");
    await waitFor(() => expect(meter.querySelectorAll('[data-on="true"]')).toHaveLength(3));
  });
});
