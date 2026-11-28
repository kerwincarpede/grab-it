import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RegionOverlay from "./RegionOverlay";
import { FOLD_MS } from "./ChooserToolbar";
import { CHOICE_EVENT, HOLD_EVENT, START_EVENT, type OverlayInfo } from "./api";
import type { Box } from "./geometry";
import {
  DEFAULT_AI_PREFERENCES,
  DEFAULT_APPEARANCE,
  DEFAULT_RECORDING,
  DEFAULT_RETENTION,
  type Camera,
  type RecordingSettings,
} from "../settings/api";
import type { Settings_Serialize } from "../app/bindings";
import { mockCommands, type CommandCall, type CommandHandlers } from "../test/mockCommands";
import { camera, fakeMedia, type FakeMedia } from "../webcam/testMedia";
import overlayStyles from "./overlay.css?inline";

type Call = CommandCall;

/** The cameras remembered with their names, as `known_cameras` reads them by default. */
const KNOWN_CAMERAS: Camera[] = [
  { id: "cam-front", name: "FaceTime HD Camera" },
  { id: "cam-usb", name: "Logitech C920" },
];

/**
 * A region overlay on a 1000 × 800 monitor with no windows, as `overlay_info`
 * sends it. The rest is what an overlay that is not All-in-one gets.
 */
function overlayInfo(info: Partial<OverlayInfo> = {}): OverlayInfo {
  return {
    mode: "region",
    intent: "capture",
    allInOne: false,
    choice: null,
    monitorWidth: 1000,
    monitorHeight: 800,
    // Not known: the frozen image's own size is used.
    imageWidth: 0,
    windows: [],
    topInset: null,
    lastRegion: null,
    pointerHere: true,
    barCentre: null,
    monitorName: "",
    scrollByHand: false,
    heldElsewhere: false,
    toolbarTick: false,
    copyToClipboard: true,
    ...info,
  };
}

/** Settings as `get_settings` sends them, with `recording` as given. */
function settings(recording: RecordingSettings): Settings_Serialize {
  return {
    saveFolder: "/home/me/Pictures/Grab-it",
    saveLayout: { byMonth: false, includeAppName: false },
    hotkeys: { allInOne: "", region: "", window: "", screen: "", text: "", colour: "", library: "", steps: "", scroll: "" },
    editor: {},
    showInDock: true,
    appearance: DEFAULT_APPEARANCE,
    recording,
    retention: DEFAULT_RETENTION,
    permissions: { asked: true, resume: false },
    agentAccess: false,
    updateChannel: "stable",
    afterCapture: "quickAccess",
    copyToClipboard: true,
    regionToolbar: false,
    toolbarTick: false,
    copySound: true,
    copySoundVolume: 50,
    ai: DEFAULT_AI_PREFERENCES,
  };
}

function mockOverlay(
  info: Partial<OverlayInfo> = {},
  recording: Partial<RecordingSettings> = {},
  cameras: Camera[] = KNOWN_CAMERAS,
  extra: CommandHandlers = {},
): Call[] {
  return mockCommands(
    {
      overlay_show_toolbar: () => null,
      // No level by default, so the polling stays out of the calls tests read.
      setup_level_start: () => {
        throw new Error("no microphone in tests");
      },
      setup_level_stop: () => undefined,
      setup_level: () => 0.5,
      recording_microphones: () => [{ id: "usb", name: "USB Microphone", isDefault: false }],
      ...extra,
      overlay_info: () =>
        overlayInfo({
          // Twice the viewport: a 2x monitor.
          monitorWidth: window.innerWidth * 2,
          monitorHeight: window.innerHeight * 2,
          windows: [{ id: 7, title: "Editor", appName: "code", x: 200, y: 200, width: 400, height: 300 }],
          ...info,
        }),
      overlay_image: () => new ArrayBuffer(8),
      // The recording options beside a recording's area.
      get_settings: () => settings({ ...DEFAULT_RECORDING, audio: "microphone", ...recording }),
      // The shortcuts the desktop registered, as the tray and hub show them.
      effective_hotkeys: () => ({ allInOne: "Ctrl+Alt+PrintScreen", region: "Ctrl+Shift+2", screen: "Ctrl+Shift+3" }),
      recording_system_audio: () => true,
      known_cameras: () => cameras,
      remember_cameras: () => null,
      // The overlay always sends every recording setting, so they read back as sent.
      set_recording: ({ recording: sent }) => settings(sent as RecordingSettings),
      overlay_ready: () => null,
      record_bar_remember: () => null,
      overlay_finish: () => null,
      overlay_choose: () => null,
      overlay_hold: () => null,
      overlay_cancel: () => undefined,
      overlay_scroll_docs: () => undefined,
      remember_scroll_by_hand: () => null,
    },
    { shouldMockEvents: true },
  );
}

const last = (calls: Call[]) => calls[calls.length - 1];

/** Opens Recording options inside `setup`, if it is not open yet. */
function openOptions(setup: HTMLElement) {
  const toggle = within(setup).getByRole("button", { name: "Recording options" });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
}

/** One of the options in Recording options' popover, opened for it. */
function optionButton(setup: HTMLElement, name: string) {
  openOptions(setup);
  return within(setup).getByRole("button", { name });
}

/** The transforms that place the pieces matching `selector` inside `root`. */
const pieces = (root: HTMLElement, selector: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].map((piece) => piece.style.transform);

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

  it("keeps the hint below the menu bar or notch", async () => {
    // 40 of the viewport's 800 px are menu bar.
    mockOverlay({ topInset: 0.05 });
    render(<RegionOverlay />);
    await ready();
    const hint = screen.getByRole("status").closest(".overlay-hint") as HTMLElement;
    expect(hint.style.top).toBe("52px");
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
          choice: null,
        },
      }),
    );
  });

  it("follows a drag by moving pieces, with nothing resized or cut out", async () => {
    mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseDown(overlay, { button: 0, clientX: 500, clientY: 400 });
    fireEvent.mouseMove(overlay, { clientX: 700, clientY: 500 });
    const dim = screen.getByTestId("overlay-dim");
    expect(pieces(dim, ".overlay-dim-piece")).toEqual([
      "translate(0px, 0px) scale(1000, 400)",
      "translate(0px, 500px) scale(1000, 300)",
      "translate(0px, 400px) scale(500, 100)",
      "translate(700px, 400px) scale(300, 100)",
    ]);
    // A dragged region has square corners.
    expect(dim.querySelector(".overlay-dim-corner")).not.toBeInTheDocument();

    const frame = screen.getByTestId("overlay-selection");
    expect(frame).toHaveClass("overlay-frame");
    expect(frame.style.width).toBe("");
    expect(pieces(frame, ".overlay-frame-edge")).toEqual([
      "translate(499px, 399px) scale(202, 1)",
      "translate(499px, 500px) scale(202, 1)",
      "translate(499px, 400px) scale(1, 100)",
      "translate(700px, 400px) scale(1, 100)",
    ]);
    expect(pieces(frame, ".overlay-frame-tick")).toEqual([
      "translate(497px, 397px)",
      "translate(691px, 397px)",
      "translate(497px, 491px)",
      "translate(691px, 491px)",
    ]);
    expect(screen.getByTestId("overlay-size")).toHaveTextContent("200 × 100");
    expect(screen.getByTestId("overlay-size").style.transform).toBe(
      "translate(500px, 392px) translate(0, -100%)",
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
    expect(screen.getByTestId("overlay-selection")).toHaveClass("overlay-window");
    // Around it the frozen screen is blurred and tinted, with the window cut out.
    const blur = screen.getByTestId("overlay-blur");
    expect(blur).toHaveClass("overlay-backdrop");
    expect(blur.style.clipPath).toContain("M110 100H290");
    // The tint leaves the window clear too: four pieces around it, and one
    // rounding off each corner.
    const dim = screen.getByTestId("overlay-dim");
    expect(pieces(dim, ".overlay-dim-piece")).toEqual([
      "translate(0px, 0px) scale(1000, 100)",
      "translate(0px, 250px) scale(1000, 550)",
      "translate(0px, 100px) scale(100, 150)",
      "translate(300px, 100px) scale(700, 150)",
    ]);
    expect(pieces(dim, ".overlay-dim-corner")).toEqual([
      "translate(100px, 100px)",
      "translate(290px, 100px)",
      "translate(100px, 240px)",
      "translate(290px, 240px)",
    ]);
    fireEvent.mouseDown(overlay, { button: 0, clientX: 150, clientY: 150 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 151, clientY: 150 });

    await waitFor(() =>
      expect(last(calls)).toEqual({
        cmd: "overlay_finish",
        payload: { selection: { kind: "window", id: 7 }, choice: null },
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
        payload: { selection: { kind: "window", id: 7 }, choice: null },
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

  it("clears the guide lines and loupe when the pointer leaves for another display", async () => {
    mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseMove(overlay, { clientX: 640, clientY: 480 });
    expect(screen.getByTestId("overlay-loupe")).toBeInTheDocument();

    fireEvent.mouseLeave(overlay);
    expect(screen.queryByTestId("overlay-guide-x")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overlay-loupe")).not.toBeInTheDocument();

    fireEvent.mouseMove(overlay, { clientX: 600, clientY: 400 });
    expect(screen.getByTestId("overlay-loupe")).toBeInTheDocument();
  });

  it("clears the guide lines, loupe and window highlight when another overlay takes the focus", async () => {
    mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 150 });
    await waitFor(() =>
      expect(screen.getByTestId("overlay-selection")).toHaveTextContent("Editor"),
    );

    fireEvent.blur(window);
    expect(screen.queryByTestId("overlay-guide-x")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overlay-loupe")).not.toBeInTheDocument();
    expect(screen.queryByTestId("overlay-selection")).not.toBeInTheDocument();
  });

  it("keeps a drag going when the pointer leaves the display", async () => {
    const calls = mockOverlay();
    render(<RegionOverlay />);
    const overlay = await ready();

    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 300, clientY: 200 });
    fireEvent.mouseLeave(overlay);
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 300 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 300 });

    await waitFor(() =>
      expect(last(calls)).toEqual({
        cmd: "overlay_finish",
        payload: {
          selection: {
            kind: "region",
            rect: { x: 100, y: 100, width: 300, height: 200 },
            viewportWidth: 1000,
          },
          choice: null,
        },
      }),
    );
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
        choice: null,
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
        choice: null,
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
    // Below the selection, hanging from its right edge by its own width.
    expect(label.style.transform).toBe("translate(1000px, 108px) translate(-100%, 0)");
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
      const calls = mockCommands(
        {
          overlay_info: () => overlayInfo(),
          overlay_image: () => {
            throw new Error("frozen image lost");
          },
        },
        { otherwise: () => null },
      );
      render(<RegionOverlay />);

      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("frozen image lost"));
      await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("overlay_ready"));
      expect(screen.getByTestId("overlay")).toHaveAttribute("data-shown", "true");
    });
  });

  it("shows a failed finish in the status element", async () => {
    mockCommands(
      {
        overlay_info: () => overlayInfo(),
        overlay_image: () => new ArrayBuffer(8),
      },
      {
        otherwise: () => {
          throw new Error("capture failed");
        },
      },
    );
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
            choice: null,
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
          payload: { selection: { kind: "point", x: 150, y: 160, viewportWidth: 1000 }, choice: null },
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
          choice: null,
        }),
      );
    });
  });

  describe("all-in-one", () => {
    it("has no toolbar when opened for one mode", async () => {
      mockOverlay();
      render(<RegionOverlay />);
      await ready();
      expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
      fireEvent.keyDown(window, { key: "2", code: "Digit2" });
      expect(screen.getByRole("status")).toHaveTextContent("Drag to capture a region");
    });

    it("shows one toolbar: five modes, Capture's targets 1–3, Timer 8, a dimmed main button and Cancel", async () => {
      mockOverlay({ allInOne: true, topInset: 0.05 });
      render(<RegionOverlay />);
      await ready();

      const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });
      const names = (group: string) =>
        within(within(toolbar).getByRole("group", { name: group }))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label") ?? button.textContent);
      expect(names("Modes")).toEqual(["Capture", "Record", "Text", "Colour", "Scroll"]);
      expect(names("What to capture")).toEqual(["Region", "Window", "Screen"]);
      expect(names("Actions")).toEqual(["Timer off", "Capture↵", "Cancel"]);
      // Keys 1 to 8 as before the modes were grouped.
      expect(
        within(toolbar)
          .getAllByRole("button")
          .slice(0, 9)
          .map((button) => button.getAttribute("aria-keyshortcuts")),
      ).toEqual(["1", "6", "4", "5", "7", "1", "2", "3", "8"]);
      expect(within(toolbar).getByRole("button", { name: "Region" })).toHaveAttribute("aria-pressed", "true");
      expect(within(toolbar).getByRole("button", { name: "Window" })).toHaveAttribute("aria-pressed", "false");
      expect(within(toolbar).getByRole("button", { name: "Timer off" })).toHaveAttribute("aria-pressed", "false");
      // Dimmed, not disabled, so its tooltip still says what to do first.
      const main = within(toolbar).getByTestId("overlay-confirm");
      expect(main).toBeEnabled();
      expect(main).toHaveAttribute("aria-disabled", "true");
      expect(main).toHaveAccessibleDescription(/Drag an area or click a window first\./);
      // Below the menu bar, with no hint line under it.
      expect(toolbar.style.top).toBe("52px");
      expect(toolbar).toHaveAttribute("data-edge", "top");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
    });

    it("explains every item in a tooltip, with its key and global shortcut", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();
      const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });

      const region = within(toolbar).getByRole("button", { name: "Region" });
      await waitFor(() => expect(region).toHaveAccessibleDescription(/Ctrl\+Shift\+2 from anywhere/));
      expect(region).toHaveAccessibleDescription(/^Region\s*1/);
      expect(region).toHaveAccessibleDescription(/Drag an area, or click a window\./);
      // An unset global shortcut is left out.
      expect(within(toolbar).getByRole("button", { name: "Window" })).not.toHaveAccessibleDescription(/from anywhere/);
      expect(within(toolbar).getByRole("button", { name: "Record" })).toHaveAccessibleDescription(/^Record\s*6/);
      expect(within(toolbar).getByRole("button", { name: "Timer off" })).toHaveAccessibleDescription(/^Timer\s*8/);
      expect(within(toolbar).getByRole("button", { name: "Cancel" })).toHaveAccessibleDescription(/^Cancel\s*Esc/);
      // Every item has one.
      for (const button of within(toolbar).getAllByRole("button")) {
        expect(button.getAttribute("aria-describedby")).toBeTruthy();
        expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")).toHaveAttribute("role", "tooltip");
      }
    });

    it("captures a dragged region with what the toolbar chose", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.mouseDown(overlay, { button: 0, clientX: 300, clientY: 250 });
      fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 100, clientY: 50 });
      // Held for adjusting until Enter.
      expect(calls.map((c) => c.cmd)).not.toContain("overlay_finish");
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });

      await waitFor(() =>
        expect(last(calls)).toEqual({
          cmd: "overlay_finish",
          payload: {
            selection: {
              kind: "region",
              rect: { x: 100, y: 50, width: 200, height: 200 },
              viewportWidth: 1000,
            },
            choice: { intent: "capture", mode: "region", delaySeconds: 0 },
          },
        }),
      );
    });

    it("switches to Window in place, without freezing the screen again", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.click(screen.getByRole("button", { name: "Window" }));
      expect(overlay).toHaveAttribute("data-mode", "window");
      expect(screen.getByRole("button", { name: "Window" })).toHaveAttribute("aria-pressed", "true");

      // A drag no longer selects a region.
      fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 20 });
      fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 400 });
      expect(calls.map((c) => c.cmd)).not.toContain("overlay_finish");

      fireEvent.mouseMove(overlay, { clientX: 150, clientY: 150 });
      fireEvent.mouseDown(overlay, { button: 0, clientX: 150, clientY: 150 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 150, clientY: 150 });
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "window", id: 7 },
          choice: { intent: "capture", mode: "window", delaySeconds: 0 },
        }),
      );
      expect(calls.filter((c) => c.cmd === "overlay_info")).toHaveLength(1);
      expect(calls.filter((c) => c.cmd === "overlay_image")).toHaveLength(1);
    });

    it("picks modes with the number keys", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.keyDown(window, { key: "4", code: "Digit4" });
      expect(overlay).toHaveAttribute("data-intent", "text");
      fireEvent.keyDown(window, { key: "6", code: "Numpad6" });
      expect(overlay).toHaveAttribute("data-intent", "record");
      // With a modifier the key is someone else's.
      fireEvent.keyDown(window, { key: "1", code: "Digit1", ctrlKey: true });
      expect(overlay).toHaveAttribute("data-intent", "record");

      fireEvent.keyDown(window, { key: "5", code: "Digit5" });
      expect(overlay).toHaveAttribute("data-intent", "color");
      // Colours are judged undimmed, as with the colour hotkey.
      expect(screen.queryByTestId("overlay-dim")).not.toBeInTheDocument();
      fireEvent.mouseDown(overlay, { button: 0, clientX: 150, clientY: 160 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 150, clientY: 160 });
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "point", x: 150, y: 160, viewportWidth: 1000 },
          choice: { intent: "color", mode: "region", delaySeconds: 0 },
        }),
      );
    });

    it("sends a text drag as text", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.click(screen.getByRole("button", { name: "Text" }));
      fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 50 });
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 90 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 300, clientY: 90 });
      fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: {
            kind: "region",
            rect: { x: 100, y: 50, width: 200, height: 40 },
            viewportWidth: 1000,
          },
          choice: { intent: "text", mode: "region", delaySeconds: 0 },
        }),
      );
    });

    it("captures every monitor as soon as Screen is picked", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();

      fireEvent.mouseDown(screen.getByRole("button", { name: "Screen" }), { button: 0 });
      fireEvent.mouseUp(screen.getByRole("button", { name: "Screen" }), { button: 0 });
      fireEvent.click(screen.getByRole("button", { name: "Screen" }));
      await waitFor(() =>
        expect(last(calls)).toEqual({
          cmd: "overlay_finish",
          payload: {
            selection: { kind: "screen" },
            choice: { intent: "capture", mode: "screen", delaySeconds: 0 },
          },
        }),
      );
      // Only once: the click on the toolbar was not also a selection.
      expect(calls.filter((c) => c.cmd === "overlay_finish")).toHaveLength(1);
    });

    it("captures the screen on key 3", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();

      fireEvent.keyDown(window, { key: "3", code: "Digit3" });
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "screen" },
          choice: { intent: "capture", mode: "screen", delaySeconds: 0 },
        }),
      );
    });

    it("steps the Timer through off, 3, 5 and 10 s and sends it with the capture", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();

      const timer = screen.getByTestId("overlay-timer");
      expect(timer).toHaveAccessibleName("Timer off");
      fireEvent.click(timer);
      expect(timer).toHaveAccessibleName("Timer 3 s");
      expect(timer).toHaveTextContent("3 s");
      // A set Timer is the grey pill, and the main button says when it captures.
      expect(timer).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("overlay-confirm")).toHaveAccessibleName("Capture in 3 s");
      fireEvent.keyDown(window, { key: "8", code: "Digit8" });
      expect(timer).toHaveAccessibleName("Timer 5 s");
      fireEvent.click(timer);
      expect(timer).toHaveAccessibleName("Timer 10 s");
      fireEvent.click(timer);
      expect(timer).toHaveAccessibleName("Timer off");
      expect(screen.getByTestId("overlay-confirm")).toHaveAccessibleName("Capture");
      fireEvent.click(timer);
      fireEvent.click(timer);

      fireEvent.click(screen.getByRole("button", { name: "Screen" }));
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "screen" },
          choice: { intent: "capture", mode: "screen", delaySeconds: 5 },
        }),
      );
    });

    it("names the main button for each mode, and hides the Timer where it does nothing", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.click(screen.getByTestId("overlay-timer"));
      const main = () => screen.queryByTestId("overlay-confirm");
      for (const [key, label] of [
        ["4", "Copy text"],
        ["5", "Copy colour"],
        ["7", "Start scrolling"],
      ]) {
        fireEvent.keyDown(window, { key, code: `Digit${key}` });
        expect(main()).toHaveAccessibleName(label);
        expect(screen.queryByTestId("overlay-timer")).not.toBeInTheDocument();
      }
      // Record's main button is a red Record; its countdown is in Recording options, still on 8.
      fireEvent.keyDown(window, { key: "6", code: "Digit6" });
      expect(main()).toHaveAccessibleName("Record");
      expect(main()).toHaveAttribute("data-tone", "record");
      expect(screen.queryByTestId("overlay-timer")).not.toBeInTheDocument();
      const options = await screen.findByTestId("overlay-record-options");
      expect(options).not.toHaveTextContent("s");
      fireEvent.keyDown(window, { key: "8", code: "Digit8" });
      await waitFor(() =>
        expect(last(calls.filter((c) => c.cmd === "set_recording"))?.payload).toMatchObject({
          recording: { countdown: 3 },
        }),
      );
      await waitFor(() => expect(screen.getByTestId("overlay-record-options")).toHaveTextContent("3 s"));

      fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 50 });
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 90 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 300, clientY: 90 });
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(last(calls).payload).toMatchObject({
          choice: { intent: "record", mode: "region", delaySeconds: 0 },
        }),
      );

      // Record again goes back to screenshots, with the Timer as it was.
      fireEvent.keyDown(window, { key: "6", code: "Digit6" });
      expect(overlay).toHaveAttribute("data-intent", "capture");
      expect(screen.getByTestId("overlay-timer")).toHaveAccessibleName("Timer 3 s");
      expect(main()).toHaveAccessibleName("Capture in 3 s");
    });

    it("shares a new mode or Timer with the other monitors' overlays", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();

      fireEvent.keyDown(window, { key: "4", code: "Digit4" });
      expect(last(calls)).toEqual({
        cmd: "overlay_choose",
        payload: { choice: { intent: "text", mode: "region", delaySeconds: 0, scrollByHand: false } },
      });
      // Text has no targets: 2 goes back to Capture on Window.
      fireEvent.keyDown(window, { key: "2", code: "Digit2" });
      fireEvent.click(screen.getByTestId("overlay-timer"));
      expect(last(calls)).toEqual({
        cmd: "overlay_choose",
        payload: { choice: { intent: "capture", mode: "window", delaySeconds: 3, scrollByHand: false } },
      });
    });

    it("follows a choice made on another monitor and finishes with it", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      // Sent until the page is listening, which it starts once loaded.
      await waitFor(async () => {
        await emit(CHOICE_EVENT, { intent: "text", mode: "region", delaySeconds: 5 });
        expect(overlay).toHaveAttribute("data-intent", "text");
      });
      expect(screen.getByRole("button", { name: "Text" })).toHaveAttribute("aria-pressed", "true");
      // Text has no targets.
      expect(screen.queryByRole("button", { name: "Region" })).not.toBeInTheDocument();
      // Not shared back: only the page that changed it tells the others.
      expect(calls.map((c) => c.cmd)).not.toContain("overlay_choose");

      fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 50 });
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 90 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 300, clientY: 90 });
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(last(calls).payload).toMatchObject({
          choice: { intent: "text", mode: "region", delaySeconds: 0 },
        }),
      );

      // The Timer it set applies once back on a screenshot mode.
      await emit(CHOICE_EVENT, { intent: "capture", mode: "window", delaySeconds: 5 });
      await waitFor(() => expect(overlay).toHaveAttribute("data-mode", "window"));
      expect(screen.getByTestId("overlay-timer")).toHaveAccessibleName("Timer 5 s");
    });

    it("starts on the choice another monitor made before this page loaded", async () => {
      const calls = mockOverlay({
        allInOne: true,
        choice: { intent: "capture", mode: "window", delaySeconds: 5 },
      });
      render(<RegionOverlay />);
      const overlay = await ready();

      expect(overlay).toHaveAttribute("data-mode", "window");
      expect(screen.getByRole("button", { name: "Window" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("overlay-timer")).toHaveAccessibleName("Timer 5 s");
      expect(calls.map((c) => c.cmd)).not.toContain("overlay_choose");

      fireEvent.mouseMove(overlay, { clientX: 150, clientY: 150 });
      fireEvent.mouseDown(overlay, { button: 0, clientX: 150, clientY: 150 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 150, clientY: 150 });
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "window", id: 7 },
          choice: { intent: "capture", mode: "window", delaySeconds: 5 },
        }),
      );
    });

    it("ignores a shared choice in an overlay opened for one mode", async () => {
      mockOverlay({ choice: { intent: "text", mode: "region", delaySeconds: 0 } });
      render(<RegionOverlay />);
      const overlay = await ready();
      expect(overlay).toHaveAttribute("data-intent", "capture");
    });

    it("hides the toolbar while a region is dragged under it", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      const toolbar = screen.getByRole("toolbar");
      expect(toolbar).toHaveAttribute("data-hidden", "false");
      fireEvent.mouseDown(overlay, { button: 0, clientX: 300, clientY: 250 });
      fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });
      expect(toolbar).toHaveAttribute("data-hidden", "true");
    });

    it("captures the window under the pointer on Enter in Window", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.keyDown(window, { key: "2", code: "Digit2" });
      const main = screen.getByTestId("overlay-confirm");
      expect(main).toHaveAttribute("aria-disabled", "true");
      expect(main).toHaveAccessibleDescription(/Point at a window first\./);
      // Nothing under the pointer: Enter does nothing.
      fireEvent.mouseMove(overlay, { clientX: 900, clientY: 700 });
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      expect(calls.map((c) => c.cmd)).not.toContain("overlay_finish");

      fireEvent.mouseMove(overlay, { clientX: 150, clientY: 150 });
      expect(main).not.toHaveAttribute("aria-disabled");
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "window", id: 7 },
          choice: { intent: "capture", mode: "window", delaySeconds: 0 },
        }),
      );
    });

    it("copies the pixel under the pointer on Enter in Colour, showing its value in the toolbar", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.keyDown(window, { key: "5", code: "Digit5" });
      expect(screen.getByTestId("overlay-toolbar-middle")).toContainElement(screen.getByTestId("overlay-toolbar-colour"));
      fireEvent.mouseMove(overlay, { clientX: 240, clientY: 120 });
      // jsdom has no canvas to read, so the colour reads as unknown.
      expect(screen.getByTestId("overlay-toolbar-colour")).toHaveTextContent("—");
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "point", x: 240, y: 120, viewportWidth: 1000 },
          choice: { intent: "color", mode: "region", delaySeconds: 0 },
        }),
      );
    });

    it("clicks the main button for the window or pixel pointed at, not the one under the toolbar", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.keyDown(window, { key: "5", code: "Digit5" });
      fireEvent.mouseMove(overlay, { clientX: 240, clientY: 120 });
      const main = screen.getByTestId("overlay-confirm");
      // On its way to the button the pointer crosses the toolbar.
      fireEvent.mouseMove(main, { clientX: 520, clientY: 30 });
      expect(main).not.toHaveAttribute("aria-disabled");
      fireEvent.click(main);
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "point", x: 240, y: 120, viewportWidth: 1000 },
          choice: { intent: "color", mode: "region", delaySeconds: 0 },
        }),
      );
    });

    it("captures the window pointed at from the main button in Window", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.keyDown(window, { key: "2", code: "Digit2" });
      fireEvent.mouseMove(overlay, { clientX: 150, clientY: 150 });
      const main = screen.getByTestId("overlay-confirm");
      fireEvent.mouseMove(main, { clientX: 520, clientY: 30 });
      expect(main).not.toHaveAttribute("aria-disabled");
      fireEvent.click(main);
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: { kind: "window", id: 7 },
          choice: { intent: "capture", mode: "window", delaySeconds: 0 },
        }),
      );
    });

    describe("from the main button after a path across the screen", () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(0);
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      /** Rests at `from`, then crosses bare desktop to the main button without stopping. */
      function travel(overlay: HTMLElement, main: HTMLElement, from: [number, number]) {
        fireEvent.mouseMove(overlay, { clientX: from[0], clientY: from[1] });
        vi.advanceTimersByTime(300);
        for (const [x, y] of [
          [700, 500],
          [750, 300],
          [800, 120],
          [820, 60],
        ]) {
          fireEvent.mouseMove(overlay, { clientX: x, clientY: y });
          vi.advanceTimersByTime(16);
        }
        fireEvent.mouseMove(main, { clientX: 840, clientY: 30 });
        vi.advanceTimersByTime(16);
        fireEvent.mouseMove(main, { clientX: 842, clientY: 31 });
      }

      it("copies the pixel the pointer rested on in Colour", async () => {
        const calls = mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();

        fireEvent.keyDown(window, { key: "5", code: "Digit5" });
        const main = screen.getByTestId("overlay-confirm");
        travel(overlay, main, [240, 520]);
        // The loupe and crosshair go while the pointer is over the toolbar.
        expect(screen.queryByTestId("overlay-loupe")).not.toBeInTheDocument();
        expect(screen.queryByTestId("overlay-guide-x")).not.toBeInTheDocument();
        fireEvent.click(main);
        await waitFor(() =>
          expect(last(calls).payload).toEqual({
            selection: { kind: "point", x: 240, y: 520, viewportWidth: 1000 },
            choice: { intent: "color", mode: "region", delaySeconds: 0 },
          }),
        );
      });

      it("captures the window the pointer rested on in Window", async () => {
        const calls = mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();

        fireEvent.keyDown(window, { key: "2", code: "Digit2" });
        const main = screen.getByTestId("overlay-confirm");
        travel(overlay, main, [150, 150]);
        // The rested window stays highlighted, though the path crossed bare desktop.
        expect(screen.getByTestId("overlay-selection")).toHaveTextContent("Editor");
        expect(main).not.toHaveAttribute("aria-disabled");
        fireEvent.click(main);
        await waitFor(() =>
          expect(last(calls).payload).toEqual({
            selection: { kind: "window", id: 7 },
            choice: { intent: "capture", mode: "window", delaySeconds: 0 },
          }),
        );
      });
    });

    it("moves between a group's buttons with the arrow keys, and leaves the toolbar on the first Esc", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();
      const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });

      const region = within(toolbar).getByRole("button", { name: "Region" });
      region.focus();
      fireEvent.keyDown(region, { key: "ArrowRight" });
      expect(within(toolbar).getByRole("button", { name: "Window" })).toHaveFocus();
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowRight" });
      // Round the end of the group, never into the next one.
      expect(region).toHaveFocus();
      fireEvent.keyDown(region, { key: "ArrowLeft" });
      expect(within(toolbar).getByRole("button", { name: "Screen" })).toHaveFocus();

      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
      expect(toolbar).not.toContainElement(document.activeElement as HTMLElement);
      expect(calls.map((c) => c.cmd)).not.toContain("overlay_cancel");
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(last(calls).cmd).toBe("overlay_cancel"));
    });

    it("reaches the toolbar with Tab", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();
      const user = userEvent.setup();
      await user.tab();
      expect(
        within(screen.getByRole("group", { name: "Modes" })).getByRole("button", { name: "Capture" }),
      ).toHaveFocus();
    });

    describe("on narrower displays", () => {
      function dragOver(overlay: HTMLElement, from: [number, number], to: [number, number]) {
        fireEvent.mouseDown(overlay, { button: 0, clientX: from[0], clientY: from[1] });
        fireEvent.mouseMove(overlay, { clientX: to[0], clientY: to[1] });
        fireEvent.mouseUp(overlay, { button: 0, clientX: to[0], clientY: to[1] });
      }

      const widths = (toolbar: HTMLElement) =>
        within(within(toolbar).getByRole("group", { name: "Modes" }))
          .getAllByRole("button")
          .map((button) => button.textContent);

      it("labels only the picked mode at any width, and keeps the ratios in the chip under the region", async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });
        expect(toolbar).toHaveAttribute("data-layout", "folded");
        expect(widths(toolbar)).toEqual(["Capture", "", "", "", ""]);

        dragOver(overlay, [300, 300], [500, 400]);
        expect(within(toolbar).queryByRole("button", { name: "Aspect ratio" })).not.toBeInTheDocument();
        expect(within(screen.getByTestId("overlay-size-panel")).getByRole("button", { name: "Aspect ratio" })).toHaveTextContent("Free");
      });

      it("is as wide as its content up to 16 px from each edge, with every mode's icon", async () => {
        // jsdom lays nothing out, but it does cascade the overlay's styles.
        const style = document.createElement("style");
        // Vitest leaves stylesheets out, so the test reads it as text. The
        // page has no Node types, so these are named here.
        const fs = await vi.importActual<{ readFileSync: (path: string, encoding: "utf8") => string }>("node:fs");
        const here = (import.meta as ImportMeta & { dirname: string }).dirname;
        style.textContent = fs.readFileSync(`${here}/overlay.css`, "utf8");
        document.head.append(style);
        try {
          mockOverlay({ allInOne: true });
          render(<RegionOverlay />);
          await ready();
          const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });
          expect(toolbar).toHaveAttribute("data-layout", "stacked");
          // Centred between both sides: left: 50% would leave it half the screen.
          const placed = getComputedStyle(toolbar);
          expect({
            left: placed.left,
            right: placed.right,
            width: placed.width,
            maxWidth: placed.maxWidth,
            marginLeft: placed.marginLeft,
            marginRight: placed.marginRight,
            transform: placed.transform,
          }).toEqual({
            left: "0px",
            right: "0px",
            width: "max-content",
            maxWidth: "calc(100% - 32px)",
            marginLeft: "auto",
            marginRight: "auto",
            transform: "none",
          });
          for (const mode of toolbar.querySelectorAll(".overlay-mode")) {
            const icon = mode.querySelector(":scope > svg");
            expect(icon).not.toBeNull();
            expect(icon).toHaveStyle({ width: "16px", height: "16px" });
          }
        } finally {
          style.remove();
        }
      });

      it("moves to the bottom edge when a held selection is under it", async () => {
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });

        dragOver(overlay, [300, 300], [500, 400]);
        expect(toolbar).toHaveAttribute("data-edge", "top");
        dragOver(overlay, [300, 20], [500, 200]);
        expect(toolbar).toHaveAttribute("data-edge", "bottom");
        expect(toolbar.style.bottom).toBe("12px");
        expect(toolbar.style.top).toBe("");
      });
    });
  });

  describe("all-in-one's adjustable selection", () => {
    /** Drags from `from` to `to` and lets go. */
    function dragOver(overlay: HTMLElement, from: [number, number], to: [number, number]) {
      fireEvent.mouseDown(overlay, { button: 0, clientX: from[0], clientY: from[1] });
      fireEvent.mouseMove(overlay, { clientX: to[0], clientY: to[1] });
      fireEvent.mouseUp(overlay, { button: 0, clientX: to[0], clientY: to[1] });
    }

    /** The size chip's width and height, as it reads them out. */
    const sizeOf = () => {
      const match = /(\d+) × (\d+) px/.exec(screen.getByTestId("overlay-size").textContent ?? "");
      return match ? [match[1], match[2]] : [];
    };

    const finishes = (calls: Call[]) => calls.filter((c) => c.cmd === "overlay_finish");

    it("keeps a released drag with eight handles and its size, and captures it on Enter", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();

      dragOver(overlay, [300, 250], [100, 50]);
      expect(finishes(calls)).toHaveLength(0);
      expect(overlay).toHaveAttribute("data-selected", "true");
      expect(overlay).toHaveAttribute("data-dragging", "false");
      const frame = screen.getByTestId("overlay-selection");
      expect(frame.querySelectorAll(".overlay-handle")).toHaveLength(8);
      expect(screen.getByTestId("overlay-handle-se").style.transform).toBe(
        "translate(300px, 250px) translate(-50%, -50%)",
      );
      expect(sizeOf()).toEqual(["200", "200"]);
      // The size is in a chip under the selection, not in the toolbar, and the main button is ready.
      const toolbar = screen.getByRole("toolbar");
      expect(within(toolbar).queryByTestId("overlay-size-width")).not.toBeInTheDocument();
      expect(screen.getByTestId("overlay-size-panel")).toBeInTheDocument();
      expect(within(toolbar).getByTestId("overlay-confirm")).not.toHaveAttribute("aria-disabled");
      // The toolbar is back once the drag is over.
      expect(toolbar).toHaveAttribute("data-hidden", "false");

      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: {
            kind: "region",
            rect: { x: 100, y: 50, width: 200, height: 200 },
            viewportWidth: 1000,
          },
          choice: { intent: "capture", mode: "region", delaySeconds: 0 },
        }),
      );
    });

    it("resizes by a handle, moves from inside, and captures with the button", async () => {
      const calls = mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();
      dragOver(overlay, [100, 100], [300, 200]);

      fireEvent.mouseDown(screen.getByTestId("overlay-handle-se"), {
        button: 0,
        clientX: 300,
        clientY: 200,
      });
      fireEvent.mouseMove(overlay, { clientX: 400, clientY: 260 });
      // Following the pointer like a drag: the deeper tint, no glide.
      expect(overlay).toHaveAttribute("data-dragging", "true");
      fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 260 });
      expect(sizeOf()).toEqual(["300", "160"]);

      // The left edge only moves the left edge.
      fireEvent.mouseDown(screen.getByTestId("overlay-handle-w"), {
        button: 0,
        clientX: 100,
        clientY: 180,
      });
      fireEvent.mouseMove(overlay, { clientX: 120, clientY: 500 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 120, clientY: 500 });
      expect(sizeOf()).toEqual(["280", "160"]);

      // From inside, the selection moves and keeps its size.
      fireEvent.mouseMove(overlay, { clientX: 200, clientY: 150 });
      expect(overlay).toHaveAttribute("data-over", "selection");
      dragOver(overlay, [200, 150], [230, 170]);
      expect(sizeOf()).toEqual(["280", "160"]);
      expect(finishes(calls)).toHaveLength(0);

      fireEvent.click(screen.getByTestId("overlay-confirm"));
      await waitFor(() =>
        expect(last(calls).payload).toMatchObject({
          selection: { kind: "region", rect: { x: 150, y: 120, width: 280, height: 160 } },
        }),
      );
    });

    it("locks a ratio for the selection and for the next drag", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();
      dragOver(overlay, [100, 100], [420, 200]);

      // The ratio is a menu in the chip under the selection.
      const ratio = () => screen.getByRole("button", { name: "Aspect ratio" });
      const pick = (name: string) => {
        fireEvent.click(ratio());
        fireEvent.click(screen.getByRole("menuitemradio", { name }));
      };
      fireEvent.click(ratio());
      expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Free", "16:9", "4:3", "1:1"]);
      expect(screen.getByRole("menuitemradio", { name: "Free" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByRole("menuitemradio", { name: "16:9" }));
      expect(ratio()).toHaveTextContent("16:9");
      expect(sizeOf()).toEqual(["320", "180"]);

      // A handle keeps the shape.
      fireEvent.mouseDown(screen.getByTestId("overlay-handle-se"), {
        button: 0,
        clientX: 420,
        clientY: 240,
      });
      fireEvent.mouseMove(overlay, { clientX: 580, clientY: 250 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 580, clientY: 250 });
      expect(sizeOf()).toEqual(["480", "270"]);

      // A new drag outside replaces it, in the same shape.
      dragOver(overlay, [700, 500], [860, 510]);
      expect(sizeOf()).toEqual(["160", "90"]);

      pick("1:1");
      expect(sizeOf()).toEqual(["160", "160"]);

    });

    it("starts from the last region, in image pixels, and captures it on Enter", async () => {
      const calls = mockOverlay({
        allInOne: true,
        imageWidth: 2000,
        lastRegion: { x: 200, y: 100, width: 1280, height: 720 },
      });
      render(<RegionOverlay />);
      const overlay = await ready();

      expect(overlay).toHaveAttribute("data-selected", "true");
      expect(sizeOf()).toEqual(["1280", "720"]);
      expect(screen.getAllByTestId(/^overlay-handle-/)).toHaveLength(8);

      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(finishes(calls)).toHaveLength(1));
      const sent = last(calls).payload as unknown as { selection: { rect: Box }; choice: unknown };
      expect(sent.selection.rect.x).toBeCloseTo(100, 2);
      expect(sent.selection.rect.y).toBeCloseTo(50, 2);
      expect(sent.selection.rect.width).toBeCloseTo(640, 2);
      expect(sent.selection.rect.height).toBeCloseTo(360, 2);
      expect(sent.choice).toEqual({ intent: "capture", mode: "region", delaySeconds: 0 });
    });

    it("replaces the last region with a drag elsewhere", async () => {
      mockOverlay({
        allInOne: true,
        imageWidth: 2000,
        lastRegion: { x: 200, y: 100, width: 400, height: 200 },
      });
      render(<RegionOverlay />);
      const overlay = await ready();

      dragOver(overlay, [800, 600], [900, 650]);
      expect(sizeOf()).toEqual(["200", "100"]);
      expect(screen.getAllByTestId("overlay-selection")).toHaveLength(1);
    });

    it("lets the selection go on a click away, so a window can be picked", async () => {
      const calls = mockOverlay({
        allInOne: true,
        lastRegion: { x: 600, y: 500, width: 200, height: 150 },
      });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.mouseMove(overlay, { clientX: 150, clientY: 150 });
      // The held selection is what is highlighted, not the window under the cursor.
      expect(screen.getAllByTestId("overlay-selection")).toHaveLength(1);
      expect(screen.getByTestId("overlay-selection")).toHaveClass("overlay-frame");

      fireEvent.mouseDown(overlay, { button: 0, clientX: 150, clientY: 150 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 150, clientY: 150 });
      expect(finishes(calls)).toHaveLength(0);
      expect(overlay).toHaveAttribute("data-selected", "false");
      expect(screen.queryByTestId("overlay-size-width")).not.toBeInTheDocument();
      // Enter has nothing to capture now.
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      expect(finishes(calls)).toHaveLength(0);

      fireEvent.mouseMove(overlay, { clientX: 151, clientY: 150 });
      fireEvent.mouseDown(overlay, { button: 0, clientX: 151, clientY: 150 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 151, clientY: 150 });
      await waitFor(() =>
        expect(last(calls).payload).toMatchObject({ selection: { kind: "window", id: 7 } }),
      );
    });

    it("hides the selection in Window mode and keeps it for the next region", async () => {
      mockOverlay({ allInOne: true, lastRegion: { x: 600, y: 500, width: 200, height: 150 } });
      render(<RegionOverlay />);
      const overlay = await ready();

      fireEvent.keyDown(window, { key: "2", code: "Digit2" });
      expect(overlay).toHaveAttribute("data-selected", "false");
      expect(screen.queryByTestId("overlay-size-width")).not.toBeInTheDocument();
      fireEvent.keyDown(window, { key: "4", code: "Digit4" });
      expect(overlay).toHaveAttribute("data-selected", "true");
      expect(screen.getByRole("button", { name: "Copy text" })).toBeInTheDocument();
    });

    it("is not offered by an overlay opened for one mode", async () => {
      const calls = mockOverlay({ lastRegion: { x: 600, y: 500, width: 200, height: 150 } });
      render(<RegionOverlay />);
      const overlay = await ready();

      expect(overlay).toHaveAttribute("data-selected", "false");
      expect(screen.queryByTestId("overlay-size-panel")).not.toBeInTheDocument();
      dragOver(overlay, [300, 250], [100, 50]);
      await waitFor(() =>
        expect(last(calls).payload).toEqual({
          selection: {
            kind: "region",
            rect: { x: 100, y: 50, width: 200, height: 200 },
            viewportWidth: 1000,
          },
          choice: null,
        }),
      );
      expect(screen.queryAllByTestId(/^overlay-handle-/)).toHaveLength(0);
    });
  });

  describe("as a spare, loaded before any selection", () => {
    it("draws nothing until a selection starts on it, then loads it once", async () => {
      let selecting = false;
      const calls = mockCommands(
        {
          overlay_info: () => (selecting ? overlayInfo() : null),
          overlay_image: () => new ArrayBuffer(8),
        },
        { shouldMockEvents: true, otherwise: () => null },
      );
      render(<RegionOverlay />);
      const overlay = screen.getByTestId("overlay");

      await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("overlay_info"));
      expect(overlay).toHaveAttribute("data-ready", "false");
      expect(overlay).toHaveAttribute("data-shown", "false");
      expect(screen.getByRole("status")).toHaveAttribute("data-error", "false");
      expect(calls.map((c) => c.cmd)).not.toContain("overlay_image");

      selecting = true;
      await emit(START_EVENT);

      await waitFor(() => expect(overlay).toHaveAttribute("data-ready", "true"));
      await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("overlay_image"));
      expect(calls.filter((c) => c.cmd === "overlay_image")).toHaveLength(1);
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
      const calls = mockCommands(
        {
          // A spare: no selection yet.
          overlay_info: () => null,
        },
        { shouldMockEvents: true, otherwise: () => null },
      );
      render(<RegionOverlay />);

      await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("overlay_info"));
      expect(screen.getByTestId("overlay")).toHaveAttribute("data-shown", "false");
      expect(calls.map((c) => c.cmd)).not.toContain("overlay_ready");
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

    it.each([
      { name: "Region", allInOne: false },
      { name: "Capture & record", allInOne: true },
    ])("dims the whole 125% Windows display in $name before its image loads", async ({ allInOne }) => {
      window.location.hash = "#/overlay?windows";
      try {
        // The spare page starts with the unscaled viewport before reveal.
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
        Object.defineProperty(window, "innerHeight", { configurable: true, value: 1080 });
        // No object URLs in jsdom: the image never loads here.
        const calls = mockOverlay({
          allInOne, pointerHere: false, monitorWidth: 1920, monitorHeight: 1080, imageWidth: 1920,
        });
        render(
          <>
            <style>{overlayStyles}</style>
            <RegionOverlay />
          </>,
        );
        const overlay = await ready();
        await waitFor(() => expect(calls.some((call) => call.cmd === "overlay_ready")).toBe(true));
        expect(overlay).toHaveAttribute("data-shown", "false");

        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1536 });
        Object.defineProperty(window, "innerHeight", { configurable: true, value: 864 });
        await emit("overlay-revealed");
        await waitFor(() => expect(overlay).toHaveAttribute("data-shown", "true"));
        const idleDim = screen.getByTestId("overlay-dim");
        const tint = getComputedStyle(idleDim);
        expect(tint.position).toBe("absolute");
        expect(tint.inset).toBe("0px");
        expect(tint.background).toBe("var(--overlay-dim)");
        expect(tint.clipPath).toBe("none");
        expect(idleDim).toBeEmptyDOMElement();

        // Drag near the lower-right edge on the secondary display.
        fireEvent.mouseDown(overlay, { button: 0, clientX: 1432, clientY: 792 });
        fireEvent.mouseMove(overlay, { clientX: 1528, clientY: 856 });
        const dragDim = screen.getByTestId("overlay-dim");
        expect(getComputedStyle(dragDim).background).toBe("var(--overlay-dim)");
        expect(dragDim).toBeEmptyDOMElement();
        expect(dragDim.style.clipPath).toMatch(/M0 0H1536V864H0Z M1432 792H1528.*V856/);
        expect(screen.getByTestId("overlay-size")).toHaveTextContent("120 × 80");

        fireEvent.mouseUp(overlay, { button: 0, clientX: 1528, clientY: 856 });
        if (allInOne) fireEvent.keyDown(window, { key: "Enter" });
        await waitFor(() =>
          expect(calls.find((call) => call.cmd === "overlay_finish")?.payload).toMatchObject({
            selection: {
              kind: "region",
              rect: { x: 1432, y: 792, width: 96, height: 64 },
              viewportWidth: 1536,
            },
          }),
        );
      } finally {
        window.location.hash = "";
      }
    });

    it("shows no loupe on Windows until its image has arrived", async () => {
      window.location.hash = "#/overlay?windows";
      try {
        Object.assign(URL, { createObjectURL: () => "blob:frozen", revokeObjectURL: () => {} });
        mockOverlay();
        const { container } = render(<RegionOverlay />);
        const overlay = await ready();
        await emit("overlay-revealed");
        await waitFor(() => expect(overlay).toHaveAttribute("data-shown", "true"));

        fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });
        expect(screen.queryByTestId("overlay-loupe")).toBeNull();

        const image = await waitFor(() => {
          const img = container.querySelector("img");
          expect(img).not.toBeNull();
          return img as HTMLImageElement;
        });
        fireEvent.load(image);
        await waitFor(() => expect(screen.getByTestId("overlay-loupe")).toBeInTheDocument());
      } finally {
        window.location.hash = "";
      }
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

  describe("a recording's area", () => {
    // Node's own object URLs refuse jsdom's Blob, and the error would replace the hint.
    beforeEach(() => {
      Object.assign(URL, { createObjectURL: () => "blob:frozen", revokeObjectURL: () => {} });
    });
    afterEach(() => {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    });

    function dragOver(overlay: HTMLElement, from: [number, number], to: [number, number]) {
      fireEvent.mouseDown(overlay, { button: 0, clientX: from[0], clientY: from[1] });
      fireEvent.mouseMove(overlay, { clientX: to[0], clientY: to[1] });
      fireEvent.mouseUp(overlay, { button: 0, clientX: to[0], clientY: to[1] });
    }

    function click(overlay: HTMLElement, x: number, y: number) {
      fireEvent.mouseMove(overlay, { clientX: x, clientY: y });
      fireEvent.mouseDown(overlay, { button: 0, clientX: x, clientY: y });
      fireEvent.mouseUp(overlay, { button: 0, clientX: x, clientY: y });
    }

    const finishes = (calls: Call[]) => calls.filter((c) => c.cmd === "overlay_finish");
    const saved = (calls: Call[]) => {
      const sets = calls.filter((c) => c.cmd === "set_recording");
      return (sets[sets.length - 1]?.payload as { recording: Record<string, unknown> } | undefined)?.recording;
    };
    const setupBar = () => screen.findByRole("toolbar", { name: "Record" });
    const sourceButton = (name: string) =>
      within(screen.getByRole("group", { name: "What to record" })).getByRole("button", { name });

    it("shows the setup toolbar at once, with Record dimmed until something is picked", async () => {
      const calls = mockOverlay({ intent: "record", barCentre: { x: 500, y: 60 } });
      render(<RegionOverlay />);
      const overlay = await ready();

      const bar = await setupBar();
      expect(bar.style.transform).toBe("translate3d(500px, 60px, 0) translate(-50%, -50%)");
      await screen.findByRole("group", { name: "Recording options" });
      expect(sourceButton("Region")).toHaveAttribute("aria-pressed", "true");
      // Dimmed, not disabled, so its tooltip still says what to do first.
      const record = within(bar).getByTestId("overlay-record");
      expect(record).toHaveAttribute("aria-disabled", "true");
      expect(record).toHaveAccessibleDescription(/Drag an area or click a window first\./);
      // Tooltips take the place of the hint line.
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();

      // Enter and a click on Record do nothing with nothing picked.
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      fireEvent.click(record);
      expect(finishes(calls)).toHaveLength(0);

      dragOver(overlay, [100, 50], [300, 250]);
      expect(record).not.toHaveAttribute("aria-disabled");
      expect(record).toHaveAccessibleDescription(/Starts recording\./);
      expect(overlay).toHaveAttribute("data-selected", "true");
    });

    it("explains every item of the setup toolbar in a tooltip", async () => {
      mockOverlay({ intent: "record" });
      render(<RegionOverlay />);
      await ready();
      const bar = await setupBar();
      const setup = await screen.findByRole("group", { name: "Recording options" });

      expect(sourceButton("Region")).toHaveAccessibleDescription(/^Region\s*1\s*Drag an area to record, or click a window\./);
      expect(sourceButton("Window")).toHaveAccessibleDescription(/^Window\s*2/);
      expect(sourceButton("Screen")).toHaveAccessibleDescription(/^Screen\s*3\s*Records the whole display\./);
      expect(optionButton(setup, "Format")).toHaveAccessibleDescription(/silent GIF/);
      expect(optionButton(setup, "Show clicks")).toHaveAccessibleDescription(/^Show clicks · off/);
      expect(within(bar).getByRole("button", { name: "Cancel" })).toHaveAccessibleDescription(/^Cancel\s*Esc/);
      for (const button of within(bar).getAllByRole("button")) {
        expect(button).not.toHaveAttribute("title");
        expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")).toHaveAttribute("role", "tooltip");
      }
    });

    it("holds a dragged region with its size chip until Enter starts it", async () => {
      const calls = mockOverlay({ intent: "record" });
      render(<RegionOverlay />);
      const overlay = await ready();
      await screen.findByRole("group", { name: "Recording options" });

      dragOver(overlay, [100, 50], [300, 250]);
      expect(finishes(calls)).toHaveLength(0);
      expect(overlay).toHaveAttribute("data-selected", "true");
      // The size and ratios stay beside it, without a button of their own.
      const chip = screen.getByTestId("overlay-size-panel");
      expect(within(chip).getByTestId("overlay-size-width")).toHaveValue("200");
      expect(within(chip).getByRole("group", { name: "Aspect ratio" })).toBeInTheDocument();
      expect(within(chip).queryByTestId("overlay-confirm")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("overlay-handle-nw")).toHaveLength(1);

      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(finishes(calls)).toHaveLength(1));
      expect(finishes(calls)[0].payload).toEqual({
        selection: { kind: "region", rect: { x: 100, y: 50, width: 200, height: 200 }, viewportWidth: 1000 },
        choice: null,
      });
    });

    it("ends a handle grab released over the size chip", async () => {
      mockOverlay({ intent: "record" });
      render(<RegionOverlay />);
      const overlay = await ready();
      await screen.findByRole("group", { name: "Recording options" });

      dragOver(overlay, [100, 50], [300, 250]);
      const chip = screen.getByTestId("overlay-size-panel");
      fireEvent.mouseDown(screen.getByTestId("overlay-handle-se"), { button: 0, clientX: 300, clientY: 250 });
      fireEvent.mouseMove(overlay, { clientX: 400, clientY: 300 });
      fireEvent.mouseUp(chip, { button: 0, clientX: 400, clientY: 300 });
      expect(overlay).toHaveAttribute("data-dragging", "false");
      // With the button up, the pointer no longer resizes it.
      fireEvent.mouseMove(overlay, { clientX: 600, clientY: 600 });
      expect(screen.getByTestId("overlay-size-width")).toHaveValue("300");
      expect(screen.getByTestId("overlay-size-height")).toHaveValue("250");
    });

    it("still holds a clicked window's area in Region", async () => {
      const calls = mockOverlay({ intent: "record" });
      render(<RegionOverlay />);
      const overlay = await ready();
      await screen.findByRole("group", { name: "Recording options" });

      click(overlay, 150, 150);
      expect(finishes(calls)).toHaveLength(0);
      expect(overlay).toHaveAttribute("data-selected", "true");
      fireEvent.click(screen.getByTestId("overlay-record"));
      await waitFor(() => expect(finishes(calls)).toHaveLength(1));
      const { rect } = (finishes(calls)[0].payload as { selection: { rect: Box } }).selection;
      expect(rect.x).toBeCloseTo(100, 2);
      expect(rect.y).toBeCloseTo(100, 2);
      expect(rect.width).toBeCloseTo(200, 2);
      expect(rect.height).toBeCloseTo(150, 2);
    });

    it("records a picked window's area in Window, named beside its outline", async () => {
      const calls = mockOverlay({ intent: "record" });
      render(<RegionOverlay />);
      const overlay = await ready();
      await screen.findByRole("group", { name: "Recording options" });

      fireEvent.keyDown(window, { key: "2", code: "Digit2" });
      await waitFor(() => expect(overlay).toHaveAttribute("data-source", "window"));
      await waitFor(() => expect(saved(calls)).toMatchObject({ source: "window" }));
      expect(screen.getByTestId("overlay-record")).toHaveAccessibleDescription(/Click a window first\./);
      // A drag selects nothing here.
      dragOver(overlay, [700, 600], [900, 700]);
      expect(overlay).toHaveAttribute("data-selected", "false");
      expect(screen.getByTestId("overlay-record")).toHaveAttribute("aria-disabled", "true");

      click(overlay, 150, 150);
      expect(overlay).toHaveAttribute("data-selected", "true");
      expect(screen.getByTestId("overlay-name-tag")).toHaveTextContent("Editor · 200 × 150");
      // No handles or size chip: the window's area is recorded as it is.
      expect(screen.queryByTestId("overlay-handle-nw")).not.toBeInTheDocument();
      expect(screen.queryByTestId("overlay-size-panel")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("overlay-record"));
      await waitFor(() => expect(finishes(calls)).toHaveLength(1));
      const { selection } = finishes(calls)[0].payload as { selection: { kind: string; rect: Box; windowId?: number } };
      expect(selection.kind).toBe("region");
      expect(selection.windowId).toBe(7);
      expect(selection.rect.x).toBeCloseTo(100, 2);
      expect(selection.rect.width).toBeCloseTo(200, 2);
    });

    it("records the whole display in Screen, picked where the pointer is", async () => {
      const calls = mockOverlay({ intent: "record", pointerHere: true, monitorName: "DELL U2720Q" });
      render(<RegionOverlay />);
      const overlay = await ready();
      await screen.findByRole("group", { name: "Recording options" });

      fireEvent.keyDown(window, { key: "3", code: "Numpad3" });
      await waitFor(() => expect(overlay).toHaveAttribute("data-source", "screen"));
      expect(screen.getByTestId("overlay-screen")).toBeInTheDocument();
      expect(screen.getByTestId("overlay-name-tag")).toHaveTextContent("DELL U2720Q · 1000 × 800");
      expect(screen.getByTestId("overlay-record")).not.toHaveAttribute("aria-disabled");

      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(finishes(calls)).toHaveLength(1));
      expect(finishes(calls)[0].payload).toEqual({
        selection: { kind: "region", rect: { x: 0, y: 0, width: 1000, height: 800 }, viewportWidth: 1000 },
        choice: null,
      });
    });

    it("opens on the source used last, and a display away from the pointer waits for a click", async () => {
      mockOverlay({ intent: "record", pointerHere: false }, { source: "screen" });
      render(<RegionOverlay />);
      const overlay = await ready();

      await waitFor(() => expect(overlay).toHaveAttribute("data-source", "screen"));
      // Not under the pointer: no toolbar and nothing picked until clicked,
      // so the hint line says what to do.
      expect(screen.queryByRole("toolbar", { name: "Record" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("overlay-screen")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Click this display to record it");
      click(overlay, 500, 400);
      expect(screen.getByTestId("overlay-screen")).toBeInTheDocument();
      expect(await setupBar()).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(sourceButton("Screen")).toHaveAttribute("aria-pressed", "true");
    });

    it("remembers where its grip left it", async () => {
      const calls = mockOverlay({ intent: "record", barCentre: { x: 500, y: 60 } });
      render(<RegionOverlay />);
      const overlay = await ready();
      const bar = await setupBar();

      fireEvent.mouseDown(screen.getByTestId("overlay-setup-grip"), { button: 0, clientX: 300, clientY: 60 });
      fireEvent.mouseMove(overlay, { clientX: 320, clientY: 560 });
      expect(bar.style.transform).toBe("translate3d(520px, 560px, 0) translate(-50%, -50%)");
      expect(overlay).toHaveAttribute("data-selected", "false");
      fireEvent.mouseUp(overlay, { button: 0, clientX: 320, clientY: 560 });
      await waitFor(() =>
        expect(calls.find((c) => c.cmd === "record_bar_remember")?.payload).toEqual({ centre: { x: 520, y: 560 } }),
      );
      // In the lower half its tooltips open above it.
      expect(bar).toHaveAttribute("data-up", "true");
    });

    it("cancels from its close button", async () => {
      const calls = mockOverlay({ intent: "record" });
      render(<RegionOverlay />);
      await ready();
      fireEvent.click(within(await setupBar()).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(last(calls).cmd).toBe("overlay_cancel"));
    });

    describe("in Capture & record", () => {
      const chooser = () => screen.getByRole("toolbar", { name: "Capture & record" });
      // The Tools group's Record, not the main button of the same name.
      const tools = () => within(within(chooser()).getByRole("group", { name: "Modes" }));
      const target = (name: string) =>
        within(within(chooser()).getByRole("group", { name: "What to record" })).getByRole("button", { name });

      it("shows Record in the same toolbar, with no second toolbar or hint line", async () => {
        mockOverlay({ allInOne: true, topInset: 0.05 });
        render(<RegionOverlay />);
        const overlay = await ready();

        fireEvent.keyDown(window, { key: "6", code: "Digit6" });
        expect(overlay).toHaveAttribute("data-intent", "record");
        const options = await within(chooser()).findByRole("group", { name: "Recording options" });
        expect(within(chooser()).getByTestId("overlay-toolbar-middle")).toContainElement(options);
        expect(screen.queryByRole("toolbar", { name: "Record" })).not.toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.queryByRole("list", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();

        // Region, Window and Screen pick what to record; Record stays on.
        expect(target("Region")).toHaveAttribute("aria-pressed", "true");
        expect(target("Screen")).toHaveAttribute("aria-pressed", "false");
        expect(target("Region")).toHaveAccessibleDescription(/^Region\s*1\s*Drag an area to record/);
        // A screenshot's global shortcut is not a recording's.
        expect(target("Region")).not.toHaveAccessibleDescription(/from anywhere/);
        const record = tools().getByRole("button", { name: "Record" });
        expect(record).toHaveAttribute("aria-pressed", "true");
        expect(record).toHaveAccessibleDescription(/Press 6 again for screenshots\./);

        // A red Record, dimmed until something is picked.
        const main = within(chooser()).getByTestId("overlay-confirm");
        expect(main).toHaveAccessibleName("Record");
        expect(main).toHaveAttribute("data-tone", "record");
        expect(main).toHaveAttribute("aria-disabled", "true");
        expect(main).toHaveAccessibleDescription(/Drag an area or click a window first\./);
        // The countdown is in Recording options now, not a button of its own.
        expect(within(chooser()).queryByTestId("overlay-countdown")).not.toBeInTheDocument();
      });

      it("picks what to record with keys 1 to 3 and the target buttons", async () => {
        const calls = mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        fireEvent.keyDown(window, { key: "6", code: "Digit6" });
        await within(chooser()).findByRole("group", { name: "Recording options" });

        fireEvent.keyDown(window, { key: "2", code: "Digit2" });
        await waitFor(() => expect(overlay).toHaveAttribute("data-source", "window"));
        await waitFor(() => expect(saved(calls)).toMatchObject({ source: "window" }));
        expect(overlay).toHaveAttribute("data-intent", "record");
        expect(target("Window")).toHaveAttribute("aria-pressed", "true");
        expect(within(chooser()).getByTestId("overlay-confirm")).toHaveAccessibleDescription(/Click a window first\./);

        fireEvent.click(target("Screen"));
        await waitFor(() => expect(overlay).toHaveAttribute("data-source", "screen"));
        expect(overlay).toHaveAttribute("data-intent", "record");
        // Screen records the display rather than capturing every monitor.
        expect(finishes(calls)).toHaveLength(0);
        expect(screen.getByTestId("overlay-screen")).toBeInTheDocument();

        fireEvent.click(target("Region"));
        await waitFor(() => expect(overlay).toHaveAttribute("data-source", "region"));
        expect(overlay).toHaveAttribute("data-intent", "record");
      });

      it("records a clicked window from the toolbar's Record", async () => {
        const calls = mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        fireEvent.keyDown(window, { key: "6", code: "Digit6" });
        await within(chooser()).findByRole("group", { name: "Recording options" });
        fireEvent.keyDown(window, { key: "2", code: "Digit2" });
        await waitFor(() => expect(overlay).toHaveAttribute("data-source", "window"));

        click(overlay, 150, 150);
        expect(screen.getByTestId("overlay-name-tag")).toHaveTextContent("Editor · 200 × 150");
        const main = within(chooser()).getByTestId("overlay-confirm");
        expect(main).not.toHaveAttribute("aria-disabled");
        fireEvent.click(main);
        await waitFor(() => expect(finishes(calls)).toHaveLength(1));
        const payload = finishes(calls)[0].payload as { selection: { kind: string; rect: Box; windowId?: number }; choice: unknown };
        expect(payload.selection.kind).toBe("region");
        expect(payload.selection.windowId).toBe(7);
        expect(payload.selection.rect.width).toBeCloseTo(200, 2);
        expect(payload.choice).toEqual({ intent: "record", mode: "region", delaySeconds: 0 });
      });

      it("keeps a recording's region with its size chip beside it", async () => {
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        fireEvent.keyDown(window, { key: "6", code: "Digit6" });
        await within(chooser()).findByRole("group", { name: "Recording options" });

        dragOver(overlay, [300, 300], [500, 400]);
        // The same read-only chip as Capture's, under the bottom-left corner.
        expect(screen.getByTestId("overlay-size-panel")).toHaveClass("overlay-size-chip");
        expect(screen.getByTestId("overlay-size")).toHaveTextContent("200 × 100 px");
        expect(screen.queryByRole("textbox", { name: "Width" })).not.toBeInTheDocument();
      });

      it("shrinks the microphone and webcam to icons when the toolbar runs short of room", async () => {
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        await ready();
        fireEvent.keyDown(window, { key: "6", code: "Digit6" });
        const options = await within(chooser()).findByRole("group", { name: "Recording options" });

        const mic = within(options).getByRole("button", { name: "Microphone" });
        const webcam = within(options).getByRole("button", { name: "Camera" });
        // Short of room, the options take a second row and the chips their icons.
        expect(chooser()).toHaveAttribute("data-layout", "stacked");
        expect(mic).toHaveAttribute("data-icon-only", "true");
        expect(mic).not.toHaveTextContent("Default microphone");
        // Their tooltips still name the choice.
        expect(mic).toHaveAccessibleDescription(/Default microphone\./);
        expect(webcam).toHaveAttribute("data-icon-only", "true");
        expect(webcam).toHaveAccessibleDescription(/No webcam\./);
      });

      it("shows the microphone and camera as icons even on a wide display", async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        await ready();
        fireEvent.keyDown(window, { key: "6", code: "Digit6" });
        const options = await within(chooser()).findByRole("group", { name: "Recording options" });
        expect(chooser()).toHaveAttribute("data-layout", "wide");
        expect(within(options).getByRole("button", { name: "Microphone" })).toHaveAccessibleDescription(/Default microphone\./);
        expect(within(options).getByRole("button", { name: "Camera" })).toHaveAccessibleDescription(/No webcam\./);
        expect(within(options).getByRole("button", { name: "Camera" })).not.toHaveTextContent("No webcam");
      });

      it("goes back to screenshots with Record again or another tool", async () => {
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();

        fireEvent.keyDown(window, { key: "6", code: "Digit6" });
        await within(chooser()).findByRole("group", { name: "Recording options" });
        fireEvent.click(tools().getByRole("button", { name: "Record" }));
        expect(overlay).toHaveAttribute("data-intent", "capture");
        expect(within(chooser()).getByRole("group", { name: "What to capture" })).toBeInTheDocument();
        expect(within(chooser()).queryByRole("group", { name: "Recording options" })).not.toBeInTheDocument();

        fireEvent.keyDown(window, { key: "6", code: "Digit6" });
        fireEvent.keyDown(window, { key: "4", code: "Digit4" });
        expect(overlay).toHaveAttribute("data-intent", "text");
      });
    });

    it("saves each option as it is chosen", async () => {
      const calls = mockOverlay({ intent: "record" });
      render(<RegionOverlay />);
      await ready();
      const setup = await screen.findByRole("group", { name: "Recording options" });

      fireEvent.click(within(setup).getByRole("button", { name: "Microphone" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "USB Microphone" }));
      await waitFor(() => expect(saved(calls)).toMatchObject({ audio: "microphone", microphone: "usb" }));
      fireEvent.click(within(setup).getByRole("button", { name: "Microphone" }));
      const selectedMic = screen.getByRole("menuitemradio", { name: "USB Microphone", checked: true });
      expect(selectedMic.querySelector(".overlay-chip-mark svg")).toBeInTheDocument();
      expect(screen.getByRole("menu", { name: "Microphone" }).querySelectorAll(".overlay-chip-mark svg")).toHaveLength(1);
      fireEvent.click(within(setup).getByRole("button", { name: "Microphone" }));

      const system = optionButton(setup, "System sound");
      expect(system).toHaveAccessibleDescription(/^System sound · off/);
      fireEvent.click(system);
      await waitFor(() => expect(saved(calls)).toMatchObject({ audio: "both" }));

      fireEvent.click(within(await setupBar()).getByRole("button", { name: "No countdown" }));
      await waitFor(() => expect(saved(calls)).toMatchObject({ countdown: 3 }));

      fireEvent.click(optionButton(setup, "Format"));
      fireEvent.click(screen.getByRole("menuitemradio", { name: /GIF/ }));
      await waitFor(() => expect(saved(calls)).toMatchObject({ format: "gif" }));
      // A GIF is silent.
      expect(within(setup).getByRole("button", { name: "Microphone" })).toBeDisabled();
      expect(finishes(calls)).toHaveLength(0);
    });

    it("saves Remove background noise, beside System sound", async () => {
      const calls = mockOverlay({ intent: "record" });
      render(<RegionOverlay />);
      await ready();
      const setup = await screen.findByRole("group", { name: "Recording options" });
      openOptions(setup);
      const toggles = within(setup)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"));
      expect(toggles.indexOf("Remove background noise")).toBe(toggles.indexOf("System sound") + 1);

      const noise = optionButton(setup, "Remove background noise");
      expect(noise).toBeEnabled();
      expect(noise).toHaveAttribute("aria-pressed", "false");
      expect(noise).toHaveAccessibleDescription(/^Remove background noise · off\s*Cleans fan hum/);
      fireEvent.click(noise);
      await waitFor(() => expect(saved(calls)).toMatchObject({ audio: "microphone", removeNoise: true }));
      await waitFor(() => expect(noise).toHaveAttribute("aria-pressed", "true"));
      fireEvent.click(noise);
      await waitFor(() => expect(saved(calls)).toMatchObject({ removeNoise: false }));
    });

    it.each([
      { name: "a GIF", recording: { format: "gif", removeNoise: true }, why: /A GIF is silent\./ },
      { name: "no microphone", recording: { audio: "none", removeNoise: true }, why: /Turn on a microphone first\./ },
    ] as const)("disables Remove background noise for $name", async ({ recording, why }) => {
      mockOverlay({ intent: "record" }, recording);
      render(<RegionOverlay />);
      await ready();
      const setup = await screen.findByRole("group", { name: "Recording options" });
      const noise = optionButton(setup, "Remove background noise");
      expect(noise).toBeDisabled();
      expect(noise).toHaveAttribute("aria-pressed", "false");
      expect(noise).toHaveAccessibleDescription(why);
    });

    describe("the Camera chip", () => {
      let media: FakeMedia | null = null;

      afterEach(() => {
        media?.restore();
        media = null;
      });

      const cameraChip = (setup: HTMLElement) => within(setup).getByRole("button", { name: "Camera" });
      const choices = () => screen.getAllByRole("menuitemradio").map((item) => item.textContent);

      it("lists the remembered cameras without turning a camera on", async () => {
        media = fakeMedia({ devices: [camera("", "")] });
        mockOverlay({ intent: "record" });
        render(<RegionOverlay />);
        await ready();
        const setup = await screen.findByRole("group", { name: "Recording options" });
        expect(within(setup).queryByRole("button", { name: "Webcam" })).not.toBeInTheDocument();
        const chip = cameraChip(setup);
        expect(chip).toHaveAccessibleDescription(/No webcam\./);

        fireEvent.click(chip);
        const list = screen.getByRole("menu", { name: "Camera" });
        await waitFor(() => expect(choices()).toEqual(["Default", "FaceTime HD Camera", "Logitech C920", "Off"]));
        expect(screen.getByRole("menuitemradio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
        // A CAMERA heading, as the microphone's menu has.
        expect(within(list).getByText("Camera")).toHaveClass("overlay-chip-heading");
        expect(within(list).getAllByRole("separator")).toHaveLength(2);
        expect(within(list).getByRole("menuitem", { name: "Refresh camera list" })).toBeInTheDocument();
        expect(media.requests).toEqual([]);
      });

      it("turns the webcam on with the camera picked, and off with No webcam", async () => {
        const calls = mockOverlay({ intent: "record" });
        render(<RegionOverlay />);
        await ready();
        const setup = await screen.findByRole("group", { name: "Recording options" });

        fireEvent.click(cameraChip(setup));
        fireEvent.click(await screen.findByRole("menuitemradio", { name: "Logitech C920" }));
        await waitFor(() => expect(saved(calls)).toMatchObject({ showWebcam: true, camera: "cam-usb" }));
        expect(screen.queryByRole("menu", { name: "Camera" })).not.toBeInTheDocument();
        await waitFor(() => expect(cameraChip(setup)).toHaveAccessibleDescription(/Logitech C920\./));

        fireEvent.click(cameraChip(setup));
        expect(screen.getByRole("menuitemradio", { name: "Logitech C920" })).toHaveAttribute("aria-checked", "true");
        fireEvent.click(screen.getByRole("menuitemradio", { name: "Default" }));
        await waitFor(() => expect(saved(calls)).toMatchObject({ showWebcam: true, camera: null }));
        await waitFor(() => expect(cameraChip(setup)).toHaveAccessibleDescription(/Default camera\./));

        fireEvent.click(cameraChip(setup));
        fireEvent.click(screen.getByRole("menuitemradio", { name: "Off" }));
        await waitFor(() => expect(saved(calls)).toMatchObject({ showWebcam: false }));
        await waitFor(() => expect(cameraChip(setup)).toHaveAccessibleDescription(/No webcam\./));
        expect(finishes(calls)).toHaveLength(0);
      });

      it("names a saved camera that is no longer listed", async () => {
        mockOverlay({ intent: "record" }, { showWebcam: true, camera: "cam-gone" });
        render(<RegionOverlay />);
        await ready();
        const setup = await screen.findByRole("group", { name: "Recording options" });
        await waitFor(() => expect(cameraChip(setup)).toHaveAccessibleDescription(/Saved camera\./));
      });

      it("refreshes the list in place, remembering the cameras named", async () => {
        media = fakeMedia({
          devices: [camera("", ""), camera("", "")],
          devicesAfterOpen: [camera("cam-usb", "Logitech C920"), camera("cam-new", "Elgato Facecam")],
        });
        const calls = mockOverlay({ intent: "record" }, {}, []);
        render(<RegionOverlay />);
        await ready();
        const setup = await screen.findByRole("group", { name: "Recording options" });

        fireEvent.click(cameraChip(setup));
        const list = screen.getByRole("menu", { name: "Camera" });
        await waitFor(() => expect(calls.some((c) => c.cmd === "known_cameras")).toBe(true));
        expect(choices()).toEqual(["Default", "Off"]);
        expect(within(list).queryByText("Cameras")).not.toBeInTheDocument();

        fireEvent.click(within(list).getByRole("menuitem", { name: "Refresh camera list" }));
        // The list stays open and takes the cameras' names.
        expect(await screen.findByRole("menuitemradio", { name: "Elgato Facecam" })).toBeInTheDocument();
        expect(screen.getByRole("menu", { name: "Camera" })).toBeInTheDocument();
        expect(choices()).toEqual(["Default", "Logitech C920", "Elgato Facecam", "Off"]);
        await waitFor(() =>
          expect(calls.find((c) => c.cmd === "remember_cameras")?.payload).toEqual({
            cameras: [
              { id: "cam-usb", name: "Logitech C920" },
              { id: "cam-new", name: "Elgato Facecam" },
            ],
          }),
        );
        // The camera opened to read the names is closed straight away.
        expect(media.requests).toHaveLength(1);
        expect(media.stopped).toBe(1);
        await waitFor(() => expect(within(list).getByRole("menuitem", { name: "Refresh camera list" })).toBeEnabled());
      });

      it("keeps the remembered cameras when Refresh cannot read their names", async () => {
        media = fakeMedia({ devices: [camera("cam-front", "")], fail: { name: "NotAllowedError" } });
        const calls = mockOverlay({ intent: "record" });
        render(<RegionOverlay />);
        await ready();
        const setup = await screen.findByRole("group", { name: "Recording options" });

        fireEvent.click(cameraChip(setup));
        const refresh = screen.getByRole("menuitem", { name: "Refresh camera list" });
        fireEvent.click(refresh);
        await waitFor(() => expect(media?.requests).toHaveLength(1));
        await waitFor(() => expect(refresh).toBeEnabled());
        expect(calls.some((c) => c.cmd === "remember_cameras")).toBe(false);
        expect(choices()).toEqual(["Default", "FaceTime HD Camera", "Logitech C920", "Off"]);
      });
    });
  });
});


describe("scrolling capture", () => {
  it("selects Scroll with key 7 and starts the held region", async () => {
    const calls = mockOverlay({ allInOne: true });
    render(<RegionOverlay />);
    await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    const overlay = screen.getByTestId("overlay");
    expect(overlay).toHaveAttribute("data-intent", "scroll");
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 400 });
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      cmd: "overlay_finish", payload: expect.objectContaining({ choice: { intent: "scroll", mode: "region", delaySeconds: 0, scrollByHand: false } }),
    })));
  });

  it("shares who scrolls with the other monitors and follows theirs", async () => {
    const calls = mockOverlay({ allInOne: true });
    render(<RegionOverlay />);
    const overlay = await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    fireEvent.click(screen.getByRole("radio", { name: "Me" }));
    expect(calls).toContainEqual({
      cmd: "overlay_choose",
      payload: { choice: { intent: "scroll", mode: "region", delaySeconds: 0, scrollByHand: true } },
    });
    // Another monitor's guide switches back to Grab-it scrolling.
    await waitFor(async () => {
      await emit(CHOICE_EVENT, { intent: "scroll", mode: "region", delaySeconds: 0, scrollByHand: false });
      expect(screen.getByRole("radio", { name: "Grab-it" })).toBeChecked();
    });
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 400 });
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      cmd: "overlay_finish", payload: expect.objectContaining({ choice: { intent: "scroll", mode: "region", delaySeconds: 0, scrollByHand: false } }),
    })));
  });

  it("sends scrolling by hand while Accessibility is off, and follows a later grant", async () => {
    let allowed = false;
    const calls = mockOverlay({ allInOne: true }, {}, KNOWN_CAMERAS, { accessibility_status: () => allowed });
    render(<RegionOverlay />);
    const overlay = await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    expect(await screen.findByRole("button", { name: "Open Settings" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Me" })).toBeChecked();
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 400 });
    // Allowed in System Settings: the page checks again as it gets the focus back.
    allowed = true;
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open Settings" })).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Grab-it" })).toBeChecked();
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      cmd: "overlay_finish", payload: expect.objectContaining({ choice: { intent: "scroll", mode: "region", delaySeconds: 0, scrollByHand: false } }),
    })));
  });

  it("guides the setup and sends who scrolls", async () => {
    const calls = mockOverlay({ allInOne: true });
    render(<RegionOverlay />);
    await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    const guide = screen.getByRole("complementary", { name: "Scrolling capture" });
    expect(guide).toHaveTextContent("Click a window or drag over an area");
    expect(guide).toHaveTextContent(/Hands off the mouse and trackpad/);
    fireEvent.click(screen.getByRole("radio", { name: "Me" }));
    const overlay = screen.getByTestId("overlay");
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 400 });
    // The guide steps aside while dragging, so it is a new panel now.
    const held = screen.getByRole("complementary", { name: "Scrolling capture" });
    expect(within(held).getAllByRole("listitem").find((item) => item.getAttribute("aria-current") === "step")).toHaveTextContent(
      "Trim the edges",
    );
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      cmd: "overlay_finish", payload: expect.objectContaining({ choice: { intent: "scroll", mode: "region", delaySeconds: 0, scrollByHand: true } }),
    })));
  });

  it("remembers the card picked, and starts with the one picked last time", async () => {
    const calls = mockOverlay({ allInOne: true, scrollByHand: true });
    render(<RegionOverlay />);
    await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    expect(screen.getByRole("radio", { name: "Me" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Grab-it" }));
    expect(calls).toContainEqual({ cmd: "remember_scroll_by_hand", payload: { byHand: false } });
    expect(screen.getByRole("radio", { name: "Grab-it" })).toBeChecked();
  });

  it("does not remember the fallback to Me while Accessibility is off", async () => {
    const calls = mockOverlay({ allInOne: true }, {}, KNOWN_CAMERAS, { accessibility_status: () => false });
    render(<RegionOverlay />);
    await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    expect(await screen.findByRole("button", { name: "Open Settings" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Me" })).toBeChecked();
    expect(calls.map(({ cmd }) => cmd)).not.toContain("remember_scroll_by_hand");
  });

  it("marks where the image starts, and which way Grab-it scrolls", async () => {
    mockOverlay({ allInOne: true });
    render(<RegionOverlay />);
    const overlay = await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    expect(screen.queryByTestId("scroll-start-label")).not.toBeInTheDocument();
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 400 });
    const start = screen.getByTestId("scroll-start-label");
    expect(start).toHaveTextContent("Image starts here");
    // On the held area's top edge.
    expect(start.style.transform).toContain("100px, 0)");
    expect(screen.getByTestId("scroll-direction")).toHaveTextContent("Grab-it scrolls down to the end");
    // Scrolling by hand, there is no arrow.
    fireEvent.click(screen.getByRole("radio", { name: "Me" }));
    expect(screen.queryByTestId("scroll-direction")).not.toBeInTheDocument();
    expect(screen.getByTestId("scroll-start-label")).toBeInTheDocument();
  });

  it("moves Image starts here below the toolbar when the area's top is under it", async () => {
    mockOverlay({ allInOne: true });
    render(<RegionOverlay />);
    const overlay = await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    // A tall window at the top: the toolbar stays at the top, over its edge.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 10 });
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 790 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 790 });
    expect(screen.getByTestId("overlay-toolbar")).toHaveAttribute("data-edge", "top");
    const start = screen.getByTestId("scroll-start-label");
    expect(start).toHaveAttribute("data-inside", "true");
    const y = Number(/translate3d\([^,]+, ([\d.]+)px/.exec(start.style.transform)?.[1]);
    // Below the toolbar's room (58 px) and its label's half height.
    expect(y).toBeGreaterThanOrEqual(58 + 12);
  });

  it("keeps the guide's title in the panel's colour under a light appearance", async () => {
    mockOverlay({ allInOne: true });
    render(
      <>
        <style>{`h2 { color: #16181c; } ${overlayStyles}`}</style>
        <RegionOverlay />
      </>,
    );
    await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    const title = screen.getByRole("heading", { name: "Scrolling capture" });
    expect(getComputedStyle(title).color).not.toBe("rgb(22, 24, 28)");
    expect(getComputedStyle(title).color).toBe(getComputedStyle(title.closest("aside") as HTMLElement).color);
  });

  it("starts the held area from the guide's Start scrolling", async () => {
    const calls = mockOverlay({ allInOne: true });
    render(<RegionOverlay />);
    const overlay = await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 400, clientY: 400 });
    const guide = screen.getByRole("complementary", { name: "Scrolling capture" });
    fireEvent.click(within(guide).getByRole("button", { name: /Start scrolling/ }));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      cmd: "overlay_finish", payload: expect.objectContaining({ choice: { intent: "scroll", mode: "region", delaySeconds: 0, scrollByHand: false } }),
    })));
  });

  /** Scroll's guide, or null where it is not shown. */
  const guide = () => screen.queryByRole("complementary", { name: "Scrolling capture" });

  it("shows the guide only on the display the pointer is on", async () => {
    mockOverlay({ allInOne: true, choice: { intent: "scroll", mode: "region", delaySeconds: 0 }, pointerHere: false });
    render(<RegionOverlay />);
    const overlay = await ready();
    expect(overlay).toHaveAttribute("data-intent", "scroll");
    expect(guide()).not.toBeInTheDocument();
    // The pointer comes over to this display, and leaves again.
    fireEvent.mouseMove(overlay, { clientX: 500, clientY: 300 });
    expect(guide()).toBeInTheDocument();
    fireEvent.mouseLeave(overlay);
    expect(guide()).not.toBeInTheDocument();
    // It may come back over the toolbar.
    fireEvent.mouseMove(screen.getByTestId("overlay-toolbar"), { clientX: 500, clientY: 20 });
    expect(guide()).toBeInTheDocument();
    // Only macOS moves the focus with the pointer: elsewhere an overlay
    // takes it as it is shown, wherever the pointer is.
    fireEvent.blur(window);
    expect(guide()).toBeInTheDocument();
    fireEvent.mouseLeave(overlay);
    fireEvent.focus(window);
    expect(guide()).not.toBeInTheDocument();
  });

  it("shows the guide where the focus arrives on macOS, which moves it with the pointer", async () => {
    window.location.hash = "#/overlay?instant";
    try {
      mockOverlay({ allInOne: true, choice: { intent: "scroll", mode: "region", delaySeconds: 0 }, pointerHere: false });
      render(<RegionOverlay />);
      await ready();
      expect(guide()).not.toBeInTheDocument();
      fireEvent.focus(window);
      expect(guide()).toBeInTheDocument();
      // Another display's overlay took the focus as the pointer moved onto it.
      fireEvent.blur(window);
      expect(guide()).not.toBeInTheDocument();
    } finally {
      window.location.hash = "";
    }
  });

  it("keeps the guide with the area held last, on whichever display it is", async () => {
    // What the backend answers when this display asks after a hold anywhere.
    let elsewhere = false;
    const calls = mockOverlay(
      { allInOne: true, choice: { intent: "scroll", mode: "region", delaySeconds: 0 } },
      {},
      KNOWN_CAMERAS,
      { overlay_held_elsewhere: () => elsewhere },
    );
    const held = async (value: boolean) => {
      elsewhere = value;
      await emit(HOLD_EVENT);
    };
    render(<RegionOverlay />);
    const overlay = await ready();
    expect(guide()).toBeInTheDocument();
    // An area was held on another display: its guide shows there instead.
    await waitFor(async () => {
      await held(true);
      expect(guide()).not.toBeInTheDocument();
    });
    // Holding one here takes it back, and tells the other displays.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 250, clientY: 250 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 250, clientY: 250 });
    await waitFor(() => expect(calls).toContainEqual({ cmd: "overlay_hold", payload: { held: true } }));
    await held(false);
    await waitFor(() => expect(guide()).toBeInTheDocument());
    // Another display holds an area after this one: a new area here takes the guide back.
    await held(true);
    await waitFor(() => expect(guide()).not.toBeInTheDocument());
    fireEvent.mouseDown(overlay, { button: 0, clientX: 600, clientY: 100 });
    fireEvent.mouseMove(overlay, { clientX: 700, clientY: 250 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 700, clientY: 250 });
    const holds = () => calls.filter(({ cmd }) => cmd === "overlay_hold").map(({ payload }) => payload);
    await waitFor(() => expect(holds()).toEqual([{ held: true }, { held: true }]));
    // A click inside it, or on a handle of an area held to a ratio, that
    // moves nothing reports nothing new.
    fireEvent.click(screen.getByRole("button", { name: "Aspect ratio" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "16:9" }));
    await waitFor(() => expect(holds()).toHaveLength(3));
    fireEvent.mouseDown(overlay, { button: 0, clientX: 650, clientY: 200 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 650, clientY: 200 });
    const handle = overlay.querySelector<HTMLElement>('[data-handle="se"]');
    expect(handle).not.toBeNull();
    fireEvent.mouseDown(handle as HTMLElement, { button: 0, clientX: 700, clientY: 250 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 700, clientY: 250 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(holds()).toHaveLength(3);
    // Letting it go tells them too.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 900, clientY: 100 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 900, clientY: 100 });
    await waitFor(() => expect(calls).toContainEqual({ cmd: "overlay_hold", payload: { held: false } }));
  });

  it("starts with the area held elsewhere when the page opens late", async () => {
    mockOverlay({ allInOne: true, choice: { intent: "scroll", mode: "region", delaySeconds: 0 }, heldElsewhere: true });
    render(<RegionOverlay />);
    const overlay = await ready();
    fireEvent.mouseMove(overlay, { clientX: 500, clientY: 300 });
    expect(guide()).not.toBeInTheDocument();
  });

  it("keeps the guide in place while the area is adjusted, and moves it once if the area ends up under it", async () => {
    mockOverlay({ allInOne: true, choice: { intent: "scroll", mode: "region", delaySeconds: 0 } });
    render(<RegionOverlay />);
    const overlay = await ready();
    expect(guide()).toHaveAttribute("data-edge", "bottom");
    // An area clear of the guide leaves it where it is.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 20, clientY: 120 });
    fireEvent.mouseMove(overlay, { clientX: 200, clientY: 740 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 200, clientY: 740 });
    expect(guide()).toHaveAttribute("data-edge", "bottom");
    // A wide area low down would lie under it: it goes to the top, once.
    fireEvent.mouseDown(overlay, { button: 0, clientX: 600, clientY: 30 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 600, clientY: 30 });
    fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 520 });
    fireEvent.mouseMove(overlay, { clientX: 900, clientY: 740 });
    fireEvent.mouseUp(overlay, { button: 0, clientX: 900, clientY: 740 });
    expect(guide()).toHaveAttribute("data-edge", "top");
    // Moving the area up under it: the guide stays put while it moves...
    fireEvent.mouseDown(overlay, { button: 0, clientX: 500, clientY: 600 });
    fireEvent.mouseMove(overlay, { clientX: 500, clientY: 200 });
    expect(guide()).toHaveAttribute("data-edge", "top");
    // ...and settles once it is let go.
    fireEvent.mouseUp(overlay, { button: 0, clientX: 500, clientY: 200 });
    expect(guide()).toHaveAttribute("data-edge", "bottom");
  });

  it("opens the docs page from the guide, which closes the overlay", async () => {
    const calls = mockOverlay({ allInOne: true });
    render(<RegionOverlay />);
    await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    fireEvent.click(screen.getByRole("link", { name: "How scrolling capture works" }));
    await waitFor(() => expect(calls.map(({ cmd }) => cmd)).toContain("overlay_scroll_docs"));
    expect(calls.map(({ cmd }) => cmd)).not.toContain("overlay_finish");
  });

  describe("the adaptive toolbar", () => {
    const toolbar = () => screen.getByRole("toolbar", { name: "Capture & record" });
    const group = (name: string) => within(within(toolbar()).getByRole("group", { name }));

    it("labels only the active mode, and shows targets for Capture and Record alone", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();
      const modes = group("Modes");
      expect(modes.getByRole("button", { name: "Capture" })).toHaveAttribute("aria-pressed", "true");
      expect(modes.getByRole("button", { name: "Capture" })).toHaveTextContent("Capture");
      expect(modes.getByRole("button", { name: "Text" })).not.toHaveTextContent("Text");
      expect(group("What to capture").getByRole("button", { name: "Region" })).toHaveAttribute("aria-pressed", "true");
      expect(toolbar()).toHaveAttribute("data-mode", "capture");

      fireEvent.click(modes.getByRole("button", { name: "Text" }));
      expect(toolbar()).toHaveAttribute("data-mode", "text");
      expect(modes.getByRole("button", { name: "Text" })).toHaveTextContent("Text");
      expect(modes.getByRole("button", { name: "Capture" })).not.toHaveTextContent("Capture");
      expect(within(toolbar()).queryByRole("group", { name: "What to capture" })).not.toBeInTheDocument();
      expect(screen.getByTestId("overlay-confirm")).toHaveTextContent("Copy text");

      // 2 picks Window, back in Capture.
      fireEvent.keyDown(window, { key: "2", code: "Digit2" });
      expect(toolbar()).toHaveAttribute("data-mode", "capture");
      expect(group("What to capture").getByRole("button", { name: "Window" })).toHaveAttribute("aria-pressed", "true");

      fireEvent.keyDown(window, { key: "6", code: "Digit6" });
      expect(toolbar()).toHaveAttribute("data-mode", "record");
      expect(within(toolbar()).getByRole("group", { name: "What to record" })).toBeInTheDocument();
    });

    it("slides one highlight to the picked mode and target", async () => {
      // jsdom lays nothing out: each button is 40 px wide, each anchor 50 px on from the last.
      const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.matches("button") ? 40 : 0;
      });
      const left = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
        const parent = this.parentElement;
        return parent ? [...parent.children].filter((child) => child.matches(".overlay-tip-anchor")).indexOf(this) * 50 : 0;
      });
      try {
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        await ready();
        const pills = () => within(toolbar()).getAllByTestId("overlay-slide");
        expect(pills()[0].style).toMatchObject({ opacity: "1", width: "40px", transform: "translateX(0px)" });
        expect(pills()[1].style).toMatchObject({ opacity: "1", transform: "translateX(0px)" });

        fireEvent.keyDown(window, { key: "3", code: "Digit3" });
        fireEvent.keyDown(window, { key: "2", code: "Digit2" });
        expect(pills()[1].style.transform).toBe("translateX(50px)");

        // Colour is the fourth mode.
        fireEvent.keyDown(window, { key: "5", code: "Digit5" });
        expect(pills()).toHaveLength(1);
        expect(pills()[0].style).toMatchObject({ opacity: "1", transform: "translateX(150px)" });
      } finally {
        width.mockRestore();
        left.mockRestore();
      }
    });

    it("ends a fold after FOLD_MS even when the toolbar re-renders during it", async () => {
      // jsdom lays nothing out: Capture's controls are 200 px, Record's 300 px.
      const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
        return this.dataset.mode === "record" ? 300 : this.dataset.mode === "capture" ? 200 : 0;
      });
      try {
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          fireEvent.keyDown(window, { key: "6", code: "Digit6" });
          const fold = within(toolbar()).getByTestId("overlay-fold");
          expect(fold).toHaveAttribute("data-folding", "true");
          expect(fold.style.width).toBe("300px");
          // Re-rendered mid-fold, as a pointer move does.
          fireEvent.mouseMove(overlay, { clientX: 400, clientY: 400 });
          fireEvent.mouseMove(overlay, { clientX: 410, clientY: 410 });
          act(() => vi.advanceTimersByTime(FOLD_MS + 50));
          expect(fold.style.width).toBe("");
          expect(fold).toHaveAttribute("data-folding", "false");
        } finally {
          vi.useRealTimers();
        }
      } finally {
        scroll.mockRestore();
      }
    });

    it("gives each mode a tooltip with its toolbar key and global shortcut", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();
      const capture = group("Modes").getByRole("button", { name: "Capture" });
      await waitFor(() => expect(capture).toHaveAccessibleDescription(/Ctrl\+Shift\+2 from anywhere/));
      expect(capture).toHaveAccessibleDescription(/^Capture\s*1–3/);
      expect(group("Modes").getByRole("button", { name: "Record" })).toHaveAccessibleDescription(/^Record\s*6/);
      expect(group("Modes").getByRole("button", { name: "Scroll" })).toHaveAccessibleDescription(/^Scroll\s*7/);
    });

    it("names the main button for its action", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();
      fireEvent.keyDown(window, { key: "8", code: "Digit8" });
      expect(screen.getByTestId("overlay-confirm")).toHaveTextContent("Capture in 3 s");
    });

    it("puts a held region's size in a chip under it", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();
      fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 200 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 300, clientY: 200 });
      const chip = screen.getByTestId("overlay-size-panel");
      expect(chip).toHaveAttribute("data-chip", "true");
      expect(within(chip).getByTestId("overlay-size")).toHaveTextContent("200 × 100 px");
      expect(within(chip).getByRole("button", { name: "Aspect ratio" })).toHaveTextContent("Free");
      expect(within(toolbar()).queryByTestId("overlay-size")).not.toBeInTheDocument();
    });

    it("lists Default, the devices and Off for the microphone, with the rest in Recording options", async () => {
      mockOverlay({ allInOne: true, choice: { intent: "record", mode: "region", delaySeconds: 0 } });
      render(<RegionOverlay />);
      await ready();
      const options = await screen.findByTestId("overlay-record-setup");
      fireEvent.click(within(options).getByRole("button", { name: "Microphone" }));
      await waitFor(() =>
        expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
          "Default",
          "USB Microphone",
          "Off",
        ]),
      );
      expect(within(options).queryByRole("button", { name: "Format" })).not.toBeInTheDocument();
      fireEvent.click(within(options).getByRole("button", { name: "Recording options" }));
      const popover = screen.getByRole("dialog", { name: "Recording options" });
      expect(within(popover).getByRole("button", { name: "Format" })).toBeInTheDocument();
      expect(within(popover).getByRole("button", { name: "Show clicks" })).toBeInTheDocument();
    });

    it("shows the setup microphone's level while Record setup is open", async () => {
      const calls = mockOverlay(
        { allInOne: true, choice: { intent: "record", mode: "region", delaySeconds: 0 } },
        {},
        KNOWN_CAMERAS,
        { setup_level_start: () => null },
      );
      const { unmount } = render(<RegionOverlay />);
      await ready();
      await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("setup_level_start"));
      expect(await screen.findByTestId("overlay-mic-level")).toBeInTheDocument();
      unmount();
      expect(calls.map((c) => c.cmd)).toContain("setup_level_stop");
    });

    it("keeps the level of a newer microphone when an older start lands late", async () => {
      let landA: () => void = () => {};
      const calls = mockOverlay(
        { allInOne: true, choice: { intent: "record", mode: "region", delaySeconds: 0 } },
        {},
        KNOWN_CAMERAS,
        {
          setup_level_start: ({ microphone }) =>
            microphone === null
              ? new Promise<null>((resolve) => {
                  landA = () => resolve(null);
                })
              : null,
        },
      );
      render(<RegionOverlay />);
      await ready();
      await waitFor(() => expect(calls.filter((c) => c.cmd === "setup_level_start")).toHaveLength(1));
      const options = await screen.findByTestId("overlay-record-setup");
      fireEvent.click(within(options).getByRole("button", { name: "Microphone" }));
      fireEvent.click(await screen.findByRole("menuitemradio", { name: "USB Microphone" }));
      await waitFor(() => expect(calls.filter((c) => c.cmd === "setup_level_start")).toHaveLength(2));
      const startB = calls.findIndex((c) => c.cmd === "setup_level_start" && (c.payload as { microphone?: string } | undefined)?.microphone === "usb");
      const ownerB = (calls[startB].payload as { owner: string }).owner;
      landA();
      expect(await screen.findByTestId("overlay-mic-level")).toBeInTheDocument();
      // A's own stop came before B started; nothing stops B.
      const stops = calls.filter((c) => c.cmd === "setup_level_stop").map((c) => (c.payload as { owner: string }).owner);
      expect(stops).not.toContain(ownerB);
      expect(calls.slice(startB).filter((c) => c.cmd === "setup_level_stop")).toHaveLength(0);
    });

    it("closes an open popover with a first click outside it, keeping the held selection", async () => {
      mockOverlay({ allInOne: true, choice: { intent: "record", mode: "region", delaySeconds: 0 } });
      render(<RegionOverlay />);
      const overlay = await ready();
      fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 200 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 300, clientY: 200 });
      expect(overlay).toHaveAttribute("data-selected", "true");
      const options = await screen.findByTestId("overlay-record-setup");
      fireEvent.click(within(options).getByRole("button", { name: "Recording options" }));
      expect(screen.getByRole("dialog", { name: "Recording options" })).toBeInTheDocument();

      fireEvent.mouseDown(overlay, { button: 0, clientX: 600, clientY: 500 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 600, clientY: 500 });
      fireEvent.click(overlay, { clientX: 600, clientY: 500 });
      expect(screen.queryByRole("dialog", { name: "Recording options" })).not.toBeInTheDocument();
      expect(overlay).toHaveAttribute("data-selected", "true");
    });

    it("closes a popover from a toolbar button without moving the focus, so Enter still records", async () => {
      const calls = mockOverlay({ allInOne: true, choice: { intent: "record", mode: "region", delaySeconds: 0 } });
      render(<RegionOverlay />);
      const overlay = await ready();
      fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 200 });
      fireEvent.mouseUp(overlay, { button: 0, clientX: 300, clientY: 200 });
      const options = await screen.findByTestId("overlay-record-setup");
      fireEvent.click(within(options).getByRole("button", { name: "Recording options" }));
      const record = group("Modes").getByRole("button", { name: "Record" });

      const press = fireEvent.mouseDown(record, { button: 0 });
      // Its default, which would focus the button, is prevented.
      expect(press).toBe(false);
      fireEvent.mouseUp(record, { button: 0 });
      fireEvent.click(record);
      expect(screen.queryByRole("dialog", { name: "Recording options" })).not.toBeInTheDocument();
      expect(record).not.toHaveFocus();
      // Record stays on, and Enter starts the recording.
      expect(overlay).toHaveAttribute("data-intent", "record");
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("overlay_finish"));
    });

    it("lists the microphone as the prototype: heading, Default's device, Off, then the input level", async () => {
      mockOverlay(
        { allInOne: true, choice: { intent: "record", mode: "region", delaySeconds: 0 } },
        {},
        KNOWN_CAMERAS,
        {
          setup_level_start: () => null,
          setup_level: () => 10 ** (-24 / 20),
          recording_microphones: () => [
            { id: "built-in", name: "MacBook Pro Microphone", isDefault: true },
            { id: "usb", name: "USB Microphone", isDefault: false },
          ],
        },
      );
      render(<RegionOverlay />);
      await ready();
      const options = await screen.findByTestId("overlay-record-setup");
      await screen.findByTestId("overlay-mic-level");
      fireEvent.click(within(options).getByRole("button", { name: "Microphone" }));
      const menu = screen.getByRole("menu", { name: "Microphone" });
      expect(within(menu).getByText("Microphone")).toHaveClass("overlay-chip-heading");
      await waitFor(() =>
        expect(within(menu).getByRole("menuitemradio", { name: /Default/ })).toHaveTextContent("DefaultMacBook Pro Microphone"),
      );
      expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
        "DefaultMacBook Pro Microphone",
        "MacBook Pro Microphone",
        "USB Microphone",
        "Off",
      ]);
      // -24 dB fills 60% of the bar.
      const bar = within(menu).getByTestId("overlay-input-level").querySelector<HTMLElement>(".overlay-chip-meter-track > span");
      await waitFor(() => expect(bar?.style.transform).toBe("scaleX(0.6)"));
    });

    it("keeps Recording options' rows out of a chip list, so none is cut off", async () => {
      mockOverlay({ allInOne: true, choice: { intent: "record", mode: "region", delaySeconds: 0 } });
      render(<RegionOverlay />);
      await ready();
      const options = await screen.findByTestId("overlay-record-setup");
      fireEvent.click(within(options).getByRole("button", { name: "Recording options" }));
      const popover = screen.getByRole("dialog", { name: "Recording options" });
      expect(popover).not.toHaveClass("overlay-chip-list");
      expect(popover).toHaveClass("overlay-options-popover");
    });

    it("lays Recording options out as the prototype: heading, rows and switches", async () => {
      mockOverlay({ allInOne: true, choice: { intent: "record", mode: "region", delaySeconds: 0 } });
      render(<RegionOverlay />);
      await ready();
      const options = await screen.findByTestId("overlay-record-setup");
      fireEvent.click(within(options).getByRole("button", { name: "Recording options" }));
      const popover = screen.getByRole("dialog", { name: "Recording options" });
      expect(popover).toHaveTextContent(/^Recording options/);
      expect([...popover.querySelectorAll(".overlay-options-row > span:first-child")].map((row) => row.textContent)).toEqual([
        "Format",
        "Countdown",
        "Microphone",
        "Camera",
        "System sound",
        "Remove background noise",
        "Show clicks",
        "Show keystrokes",
      ]);
    });

    it("shows a hint in Text and the HEX format in Colour", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      await ready();
      fireEvent.keyDown(window, { key: "4", code: "Digit4" });
      expect(within(toolbar()).getByTestId("overlay-text-hint")).toHaveTextContent("Drag over text");
      fireEvent.keyDown(window, { key: "5", code: "Digit5" });
      expect(within(toolbar()).getByTestId("overlay-colour-format")).toHaveTextContent("HEX");
    });

    describe("Tab in a bare Region capture", () => {
      it("switches to the toolbar on Capture → Region, keeping the held selection", async () => {
        const calls = mockOverlay();
        render(<RegionOverlay />);
        const overlay = await ready();
        // Mid-drag: a bare Region capture would finish on release.
        fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
        fireEvent.mouseMove(overlay, { clientX: 300, clientY: 200 });
        expect(screen.queryByRole("toolbar", { name: "Capture & record" })).not.toBeInTheDocument();

        fireEvent.keyDown(window, { key: "Tab", code: "Tab" });
        fireEvent.mouseUp(overlay, { button: 0, clientX: 300, clientY: 200 });
        expect(calls.map((c) => c.cmd)).not.toContain("overlay_finish");
        expect(toolbar()).toHaveAttribute("data-mode", "capture");
        expect(group("What to capture").getByRole("button", { name: "Region" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByTestId("overlay-size-panel")).toBeInTheDocument();
        await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("overlay_show_toolbar"));
        // Its tooltips show the global shortcuts too.
        await waitFor(() =>
          expect(group("Modes").getByRole("button", { name: "Capture" })).toHaveAccessibleDescription(
            /Ctrl\+Shift\+2 from anywhere/,
          ),
        );
      });

      it("leaves a Window capture as it is", async () => {
        mockOverlay({ mode: "window" });
        render(<RegionOverlay />);
        await ready();
        fireEvent.keyDown(window, { key: "Tab", code: "Tab" });
        expect(screen.queryByRole("toolbar", { name: "Capture & record" })).not.toBeInTheDocument();
      });
    });

    describe("the tick", () => {
      function holdAndConfirm(overlay: HTMLElement) {
        fireEvent.mouseDown(overlay, { button: 0, clientX: 100, clientY: 100 });
        fireEvent.mouseMove(overlay, { clientX: 300, clientY: 200 });
        fireEvent.mouseUp(overlay, { button: 0, clientX: 300, clientY: 200 });
        fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      }

      it("finishes at once and shows a tick with the result, with the setting on", async () => {
        const calls = mockOverlay({ allInOne: true, toolbarTick: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        holdAndConfirm(overlay);
        // The copy and save start now; the backend closes the overlay after the tick.
        expect(screen.getByTestId("overlay-toolbar-done")).toHaveTextContent("Copied · Saved to Library");
        await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("overlay_finish"));
        expect(screen.getByTestId("overlay-toolbar-done")).toBeInTheDocument();
      });

      it("says Text is read to copy, not that it was copied", async () => {
        mockOverlay({ allInOne: true, toolbarTick: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        fireEvent.keyDown(window, { key: "4", code: "Digit4" });
        holdAndConfirm(overlay);
        // The text is read after the overlay goes, so it says nothing was copied yet.
        expect(screen.getByTestId("overlay-toolbar-done")).toHaveTextContent("Reading the text to copy");
      });

      it("says Saved, not Copied, with Copy to clipboard off", async () => {
        mockOverlay({ allInOne: true, toolbarTick: true, copyToClipboard: false });
        render(<RegionOverlay />);
        const overlay = await ready();
        holdAndConfirm(overlay);
        expect(screen.getByTestId("overlay-toolbar-done")).toHaveTextContent("Saved to Library");
        expect(screen.getByTestId("overlay-toolbar-done")).not.toHaveTextContent("Copied");
      });

      it("shows no tick for a timed capture", async () => {
        mockOverlay({ allInOne: true, toolbarTick: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        fireEvent.keyDown(window, { key: "8", code: "Digit8" });
        holdAndConfirm(overlay);
        expect(screen.queryByTestId("overlay-toolbar-done")).not.toBeInTheDocument();
      });

      it("finishes at once with no tick, with the setting off", async () => {
        const calls = mockOverlay({ allInOne: true, toolbarTick: false });
        render(<RegionOverlay />);
        const overlay = await ready();
        holdAndConfirm(overlay);
        expect(screen.queryByTestId("overlay-toolbar-done")).not.toBeInTheDocument();
        await waitFor(() => expect(calls.map((c) => c.cmd)).toContain("overlay_finish"));
      });
    });
  });
});
