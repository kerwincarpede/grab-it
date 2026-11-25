import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RegionOverlay from "./RegionOverlay";
import { CHOICE_EVENT, START_EVENT, type OverlayInfo } from "./api";
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
      recording_microphones: () => [{ id: "usb", name: "USB Microphone", isDefault: false }],
      recording_system_audio: () => true,
      known_cameras: () => cameras,
      remember_cameras: () => null,
      // The overlay always sends every recording setting, so they read back as sent.
      set_recording: ({ recording: sent }) => settings(sent as RecordingSettings),
      overlay_ready: () => null,
      record_bar_remember: () => null,
      overlay_finish: () => null,
      overlay_choose: () => null,
      overlay_cancel: () => undefined,
      overlay_scroll_docs: () => undefined,
      remember_scroll_by_hand: () => null,
    },
    { shouldMockEvents: true },
  );
}

const last = (calls: Call[]) => calls[calls.length - 1];

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

    it("shows one toolbar: modes 1–3, modes 4–7, Timer 8, a dimmed main button and Cancel", async () => {
      mockOverlay({ allInOne: true, topInset: 0.05 });
      render(<RegionOverlay />);
      await ready();

      const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });
      const names = (group: string) =>
        within(within(toolbar).getByRole("group", { name: group }))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label") ?? button.textContent);
      expect(names("What to capture")).toEqual(["Region", "Window", "Screen"]);
      expect(names("Tools")).toEqual(["Text", "Colour", "Record", "Scroll"]);
      expect(names("Actions")).toEqual(["Timer off", "Capture↵", "Cancel"]);
      expect(
        within(toolbar)
          .getAllByRole("button")
          .slice(0, 8)
          .map((button) => button.getAttribute("aria-keyshortcuts")),
      ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
      expect(within(toolbar).getByRole("button", { name: "Region" })).toHaveAttribute("aria-pressed", "true");
      expect(within(toolbar).getByRole("button", { name: "Window" })).toHaveAttribute("aria-pressed", "false");
      expect(within(toolbar).getByRole("button", { name: "Timer off" })).toHaveAttribute("aria-pressed", "false");
      // Dimmed, not disabled, so its tooltip still says what to do first.
      const main = within(toolbar).getByRole("button", { name: "Capture" });
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
      // Record's main button is a red Record, and its countdown takes the Timer's place on 8.
      fireEvent.keyDown(window, { key: "6", code: "Digit6" });
      expect(main()).toHaveAccessibleName("Record");
      expect(main()).toHaveAttribute("data-tone", "record");
      expect(screen.queryByTestId("overlay-timer")).not.toBeInTheDocument();
      const countdown = await screen.findByTestId("overlay-countdown");
      expect(countdown).toHaveAccessibleName("No countdown");
      fireEvent.keyDown(window, { key: "8", code: "Digit8" });
      await waitFor(() =>
        expect(last(calls.filter((c) => c.cmd === "set_recording"))?.payload).toMatchObject({
          recording: { countdown: 3 },
        }),
      );
      expect(screen.getByTestId("overlay-countdown")).toHaveAccessibleName("Countdown 3 s");

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
      fireEvent.click(screen.getByRole("button", { name: "Window" }));
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
      expect(screen.getByRole("button", { name: "Region" })).toHaveAttribute("aria-pressed", "false");
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
        // The loupe stays on the rested pixel while the pointer is over the toolbar.
        expect(screen.getByTestId("overlay-loupe")).toHaveStyle({ transform: "translate3d(260px, 540px, 0)" });
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
      expect(screen.getByRole("button", { name: "Region" })).toHaveFocus();
    });

    describe("on narrower displays", () => {
      function dragOver(overlay: HTMLElement, from: [number, number], to: [number, number]) {
        fireEvent.mouseDown(overlay, { button: 0, clientX: from[0], clientY: from[1] });
        fireEvent.mouseMove(overlay, { clientX: to[0], clientY: to[1] });
        fireEvent.mouseUp(overlay, { button: 0, clientX: to[0], clientY: to[1] });
      }

      const widths = (toolbar: HTMLElement) =>
        within(within(toolbar).getByRole("group", { name: "Tools" }))
          .getAllByRole("button")
          .map((button) => button.textContent);

      it("shows every label and the ratios in a row when there is room", async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1500 });
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });
        expect(toolbar).toHaveAttribute("data-layout", "wide");
        expect(widths(toolbar)).toEqual(["Text4", "Colour5", "Record6", "Scroll7"]);

        dragOver(overlay, [300, 300], [500, 400]);
        expect(within(toolbar).getByRole("group", { name: "Aspect ratio" })).toBeInTheDocument();
      });

      it("shrinks unselected modes to icon and key, and folds the ratios into a menu", async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });
        expect(toolbar).toHaveAttribute("data-layout", "folded");
        expect(widths(toolbar)).toEqual(["4", "5", "6", "7"]);
        // The picked mode keeps its label.
        expect(within(toolbar).getByRole("button", { name: "Region" })).toHaveTextContent("Region1");

        dragOver(overlay, [300, 300], [500, 400]);
        expect(within(toolbar).queryByRole("group", { name: "Aspect ratio" })).not.toBeInTheDocument();
        expect(within(toolbar).getByRole("button", { name: "Aspect ratio" })).toHaveTextContent("Free");
      });

      it("puts the selection's controls on a second row where one row cannot hold them", async () => {
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        const overlay = await ready();
        const toolbar = screen.getByRole("toolbar", { name: "Capture & record" });
        // 1000 px cannot fit the modes, a held region's size and the actions in one row.
        expect(toolbar).toHaveAttribute("data-layout", "stacked");
        dragOver(overlay, [300, 300], [500, 400]);
        expect(within(toolbar).getByTestId("overlay-toolbar-middle")).toContainElement(
          screen.getByRole("textbox", { name: "Width" }),
        );
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

    const sizeOf = () => [
      (screen.getByTestId("overlay-size-width") as HTMLInputElement).value,
      (screen.getByTestId("overlay-size-height") as HTMLInputElement).value,
    ];

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
      // The size is in the toolbar, not beside the selection, and the main button is ready.
      const toolbar = screen.getByRole("toolbar");
      expect(within(toolbar).getByTestId("overlay-size-width")).toBeInTheDocument();
      expect(screen.queryByTestId("overlay-size-panel")).not.toBeInTheDocument();
      expect(within(toolbar).getByRole("button", { name: "Capture" })).not.toHaveAttribute("aria-disabled");
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

      fireEvent.click(screen.getByRole("button", { name: "Capture" }));
      await waitFor(() =>
        expect(last(calls).payload).toMatchObject({
          selection: { kind: "region", rect: { x: 150, y: 120, width: 280, height: 160 } },
        }),
      );
    });

    it("takes an exact size in image pixels, without capturing on the field's Enter", async () => {
      // 2000 image px over 1000 CSS px: two image px per CSS px.
      const calls = mockOverlay({ allInOne: true, imageWidth: 2000 });
      render(<RegionOverlay />);
      const overlay = await ready();
      dragOver(overlay, [100, 100], [300, 200]);
      expect(sizeOf()).toEqual(["400", "200"]);

      const width = screen.getByRole("textbox", { name: "Width" });
      const height = screen.getByRole("textbox", { name: "Height" });
      fireEvent.change(width, { target: { value: "1280" } });
      fireEvent.change(height, { target: { value: "720" } });
      // Number keys typed in the field are digits, not modes.
      fireEvent.keyDown(height, { key: "2", code: "Digit2" });
      expect(overlay).toHaveAttribute("data-mode", "region");
      fireEvent.keyDown(height, { key: "Enter", code: "Enter" });
      expect(sizeOf()).toEqual(["1280", "720"]);
      expect(finishes(calls)).toHaveLength(0);

      // Nonsense is ignored.
      fireEvent.change(width, { target: { value: "wide" } });
      fireEvent.blur(width);
      expect(sizeOf()).toEqual(["1280", "720"]);

      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(finishes(calls)).toHaveLength(1));
      const sent = last(calls).payload as unknown as { selection: { rect: Box } };
      // The corner stays; the box covers exactly 1280 by 720 image pixels.
      expect(sent.selection.rect.x).toBeCloseTo(100, 2);
      expect(sent.selection.rect.y).toBeCloseTo(100, 2);
      expect(sent.selection.rect.width).toBeCloseTo(640, 2);
      expect(sent.selection.rect.height).toBeCloseTo(360, 2);
    });

    it("keeps an exact size exact when it is moved at a fractional scale", async () => {
      // 1500 image px over 1000 CSS px: a 150% monitor.
      const calls = mockOverlay({ allInOne: true, imageWidth: 1500 });
      render(<RegionOverlay />);
      const overlay = await ready();
      dragOver(overlay, [100, 100], [300, 200]);

      const width = screen.getByRole("textbox", { name: "Width" });
      fireEvent.change(width, { target: { value: "1280" } });
      fireEvent.change(screen.getByRole("textbox", { name: "Height" }), { target: { value: "720" } });
      fireEvent.keyDown(width, { key: "Enter" });

      // One CSS px is 1.5 image px: off the grid unless the move snaps.
      dragOver(overlay, [200, 200], [201, 201]);
      expect(sizeOf()).toEqual(["1280", "720"]);

      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(finishes(calls)).toHaveLength(1));
      const { rect } = (last(calls).payload as unknown as { selection: { rect: Box } }).selection;
      // As src-tauri's css_to_image_rect rounds: edges outwards.
      const scale = 1.5;
      const left = Math.floor(rect.x * scale);
      const top = Math.floor(rect.y * scale);
      expect(Math.ceil((rect.x + rect.width) * scale) - left).toBe(1280);
      expect(Math.ceil((rect.y + rect.height) * scale) - top).toBe(720);
      expect(left).toBeGreaterThan(150);
    });

    it("keeps a size that would run off the screen on it", async () => {
      mockOverlay({ allInOne: true, imageWidth: 2000 });
      render(<RegionOverlay />);
      const overlay = await ready();
      dragOver(overlay, [800, 700], [900, 750]);

      fireEvent.change(screen.getByRole("textbox", { name: "Width" }), { target: { value: "5000" } });
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Width" }), { key: "Enter" });
      // As wide as the 2000 px image, moved back to its left edge.
      expect(sizeOf()).toEqual(["2000", "100"]);
      expect(screen.getByTestId("overlay-handle-nw").style.transform).toMatch(/^translate\(0px, 700px\)/);
    });

    it("locks a ratio for the selection and for the next drag", async () => {
      mockOverlay({ allInOne: true });
      render(<RegionOverlay />);
      const overlay = await ready();
      dragOver(overlay, [100, 100], [420, 200]);

      // 1000 px wide: the ratios are folded into one menu.
      const pick = (name: string) => {
        fireEvent.click(screen.getByRole("button", { name: "Aspect ratio" }));
        fireEvent.click(screen.getByRole("menuitemradio", { name }));
      };
      fireEvent.click(screen.getByRole("button", { name: "Aspect ratio" }));
      expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
        "Free",
        "16:9",
        "4:3",
        "1:1",
      ]);
      expect(screen.getByRole("menuitemradio", { name: "Free" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByRole("menuitemradio", { name: "16:9" }));
      expect(screen.getByRole("button", { name: "Aspect ratio" })).toHaveTextContent("16:9");
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

      // A typed size has its own shape: back to Free.
      const width = screen.getByRole("textbox", { name: "Width" });
      fireEvent.change(width, { target: { value: "100" } });
      fireEvent.keyDown(width, { key: "Enter" });
      expect(sizeOf()).toEqual(["100", "160"]);
      expect(screen.getByRole("button", { name: "Aspect ratio" })).toHaveTextContent("Free");
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
      expect(within(setup).getByRole("button", { name: "Format" })).toHaveAccessibleDescription(/silent GIF/);
      expect(within(setup).getByRole("button", { name: "Clicks" })).toHaveAccessibleDescription(/^Clicks · off/);
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
      const tools = () => within(within(chooser()).getByRole("group", { name: "Tools" }));
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
        expect(within(chooser()).getByTestId("overlay-countdown")).toHaveAccessibleDescription(/^Countdown\s*8/);
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
        expect(screen.getByTestId("overlay-size-panel")).toBeInTheDocument();
        expect(within(chooser()).queryByRole("textbox", { name: "Width" })).not.toBeInTheDocument();
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

      it("shows the microphone and webcam by name on a wide display", async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
        mockOverlay({ allInOne: true });
        render(<RegionOverlay />);
        await ready();
        fireEvent.keyDown(window, { key: "6", code: "Digit6" });
        const options = await within(chooser()).findByRole("group", { name: "Recording options" });
        expect(chooser()).toHaveAttribute("data-layout", "wide");
        expect(within(options).getByRole("button", { name: "Microphone" })).toHaveTextContent("Default microphone");
        expect(within(options).getByRole("button", { name: "Camera" })).toHaveTextContent("No webcam");
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

      const system = within(setup).getByRole("button", { name: "System sound" });
      expect(system).toHaveAccessibleDescription(/^System sound · off/);
      fireEvent.click(system);
      await waitFor(() => expect(saved(calls)).toMatchObject({ audio: "both" }));

      fireEvent.click(within(await setupBar()).getByRole("button", { name: "No countdown" }));
      await waitFor(() => expect(saved(calls)).toMatchObject({ countdown: 3 }));

      fireEvent.click(within(setup).getByRole("button", { name: "Format" }));
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
      const toggles = within(setup)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"));
      expect(toggles.indexOf("Remove background noise")).toBe(toggles.indexOf("System sound") + 1);

      const noise = within(setup).getByRole("button", { name: "Remove background noise" });
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
      const noise = within(setup).getByRole("button", { name: "Remove background noise" });
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
        expect(chip).toHaveTextContent("No webcam");

        fireEvent.click(chip);
        const list = screen.getByRole("menu", { name: "Camera" });
        await waitFor(() => expect(choices()).toEqual(["No webcam", "Default camera", "FaceTime HD Camera", "Logitech C920"]));
        expect(screen.getByRole("menuitemradio", { name: "No webcam" })).toHaveAttribute("aria-checked", "true");
        expect(within(list).getByText("Cameras")).toBeInTheDocument();
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
        expect(cameraChip(setup)).toHaveTextContent("Logitech C920");

        fireEvent.click(cameraChip(setup));
        expect(screen.getByRole("menuitemradio", { name: "Logitech C920" })).toHaveAttribute("aria-checked", "true");
        fireEvent.click(screen.getByRole("menuitemradio", { name: "Default camera" }));
        await waitFor(() => expect(saved(calls)).toMatchObject({ showWebcam: true, camera: null }));
        expect(cameraChip(setup)).toHaveTextContent("Default camera");

        fireEvent.click(cameraChip(setup));
        fireEvent.click(screen.getByRole("menuitemradio", { name: "No webcam" }));
        await waitFor(() => expect(saved(calls)).toMatchObject({ showWebcam: false }));
        expect(cameraChip(setup)).toHaveTextContent("No webcam");
        expect(finishes(calls)).toHaveLength(0);
      });

      it("names a saved camera that is no longer listed", async () => {
        mockOverlay({ intent: "record" }, { showWebcam: true, camera: "cam-gone" });
        render(<RegionOverlay />);
        await ready();
        const setup = await screen.findByRole("group", { name: "Recording options" });
        await waitFor(() => expect(cameraChip(setup)).toHaveTextContent("Saved camera"));
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
        expect(choices()).toEqual(["No webcam", "Default camera"]);
        expect(within(list).queryByText("Cameras")).not.toBeInTheDocument();

        fireEvent.click(within(list).getByRole("menuitem", { name: "Refresh camera list" }));
        // The list stays open and takes the cameras' names.
        expect(await screen.findByRole("menuitemradio", { name: "Elgato Facecam" })).toBeInTheDocument();
        expect(screen.getByRole("menu", { name: "Camera" })).toBeInTheDocument();
        expect(choices()).toEqual(["No webcam", "Default camera", "Logitech C920", "Elgato Facecam"]);
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
        expect(choices()).toEqual(["No webcam", "Default camera", "FaceTime HD Camera", "Logitech C920"]);
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

  it("opens the docs page from the guide, which closes the overlay", async () => {
    const calls = mockOverlay({ allInOne: true });
    render(<RegionOverlay />);
    await ready();
    fireEvent.keyDown(window, { key: "7", code: "Digit7" });
    fireEvent.click(screen.getByRole("link", { name: "How scrolling capture works" }));
    await waitFor(() => expect(calls.map(({ cmd }) => cmd)).toContain("overlay_scroll_docs"));
    expect(calls.map(({ cmd }) => cmd)).not.toContain("overlay_finish");
  });
});
