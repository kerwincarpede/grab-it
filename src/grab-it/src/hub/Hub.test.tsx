import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import { describe, expect, it, vi } from "vitest";
import Hub from "./Hub";
import { keyCaps, shortcutLabel } from "./keys";
import { routeFromHash } from "../routes";
import { HUB_ACTIVITY_EVENT, type HubActivity } from "./api";
import type { Shot_Serialize } from "../app/bindings";
import { mockCommands, type CommandCall } from "../test/mockCommands";

/** A shot the Library lists, as `library_list` sends it. */
function shot(index: number): Shot_Serialize {
  return {
    id: index + 1,
    kind: "image",
    path: `/tmp/${index}.png`,
    fileName: `${index}.png`,
    thumbPath: `/tmp/${index}.thumb.png`,
    capturedAt: 0,
    mode: "region",
    app: null,
    windowTitle: `Shot ${index + 1}`,
    width: 800,
    height: 600,
    tags: [],
    notes: "",
    aiDescription: null,
    aiCategory: null,
    aiTags: [],
    durationMs: null,
    bytes: null,
    keep: false,
    editedAt: null,
    thumbStale: false,
  };
}

function backend({ monitors = 1, shots = 0, activity = { recording: false, steps: false } as HubActivity } = {}) {
  return mockCommands(
    {
      effective_hotkeys: () => ({ allInOne: "Ctrl+Alt+A", region: "Ctrl+Shift+R", window: "Alt+PrintScreen", library: "Ctrl+Shift+L" }),
      library_list: () => ({
        shots: Array.from({ length: shots }, (_, index) => shot(index)),
        offset: 0,
        total: shots,
      }),
      library_thumbnail: () => new ArrayBuffer(0),
      hub_monitors: () => Array.from({ length: monitors }, (_, index) => ({ index, label: `${index + 1}. Display` })),
      hub_activity: () => activity,
    },
    { shouldMockEvents: true, otherwise: () => null },
  );
}

const sent = (calls: CommandCall[], cmd: string) => calls.filter((call) => call.cmd === cmd).map((call) => call.payload);

describe("Hub", () => {
  it("starts each capture by its kind", async () => {
    const calls = backend();
    render(<Hub />);
    for (const name of [/^Capture region/, /^Capture & record…/, /^Window/, /^Screen/, /^Record/, /^Grab text/, /^Pick colour/, /^Step capture/]) {
      await userEvent.click(screen.getByRole("button", { name }));
    }
    await userEvent.click(screen.getByRole("button", { name: "Repeat last region" }));
    expect(sent(calls, "hub_capture").map((payload) => (payload as { kind: string }).kind)).toEqual([
      "region",
      "allInOne",
      "window",
      "screen",
      "record",
      "text",
      "colour",
      "steps",
      "repeat",
    ]);
  });

  it("shows the hotkeys", async () => {
    backend();
    render(<Hub />);
    expect(await screen.findByText("Ctrl+Shift+R")).toBeInTheDocument();
    expect(screen.getByText("Alt+PrintScreen")).toBeInTheDocument();
  });

  it("keeps region first and activates the chooser by keyboard with its live binding", async () => {
    const calls = backend();
    render(<Hub />);
    const chooser = screen.getByRole("button", { name: /^Capture & record…/ });
    await waitFor(() => expect(chooser).toHaveTextContent("Ctrl+Alt+A"));
    expect(screen.getByRole("button", { name: /^Capture region/ })).toHaveFocus();
    await userEvent.tab();
    expect(chooser).toHaveFocus();
    await act(() => emit("effective-hotkeys-changed", { allInOne: "⌘⇧A" }));
    expect(chooser).toHaveTextContent("⌘⇧A");
    await act(() => emit("effective-hotkeys-changed", {}));
    expect(chooser).toHaveAccessibleName("Capture & record…");
    await userEvent.keyboard("{Enter}");
    expect(sent(calls, "hub_capture")).toContainEqual({ kind: "allInOne", delaySeconds: null, monitor: null });
    expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
  });

  it("tabs into a nested action and activates it", async () => {
    const calls = backend();
    render(<Hub />);
    const timed = screen.getByRole("button", { name: "Timed" });
    timed.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Region in 3 s" })).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(sent(calls, "hub_capture")).toContainEqual({ kind: "region", delaySeconds: 3, monitor: null });
  });

  it("offers timed captures", async () => {
    const calls = backend();
    render(<Hub />);
    await userEvent.click(screen.getByRole("button", { name: "Timed" }));
    await userEvent.click(screen.getByRole("button", { name: "Region in 5 s" }));
    expect(sent(calls, "hub_capture")).toContainEqual({ kind: "region", delaySeconds: 5, monitor: null });
  });

  it("offers each monitor when there are several", async () => {
    const calls = backend({ monitors: 2 });
    render(<Hub />);
    await userEvent.click(await screen.findByRole("button", { name: "Monitor" }));
    await userEvent.click(screen.getByRole("button", { name: "2. Display" }));
    expect(sent(calls, "hub_capture")).toContainEqual({ kind: "monitor", delaySeconds: null, monitor: 1 });
  });

  it("scrolls opened submenus into view and keeps recent captures outside the scrolling list", async () => {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });

    try {
      backend({ monitors: 2, shots: 3 });
      render(<Hub />);
      const latest = await screen.findByRole("button", { name: "Open Shot 3 in the editor" });
      for (const [menu, option] of [["Timed", "Screen in 5 s"], ["Monitor", "2. Display"]]) {
        scrollIntoView.mockClear();
        await userEvent.click(screen.getByRole("button", { name: menu }));
        const button = screen.getByRole("button", { name: option });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
        expect(scrollIntoView.mock.contexts[0]).toBe(button.closest(".hub-sub"));

        const list = button.closest(".hub-scroll");
        expect(list).toBeInTheDocument();
        expect(list).not.toContainElement(screen.getByRole("heading", { name: "Recent" }));
        expect(list).not.toContainElement(latest);
      }
    } finally {
      if (original) {
        Object.defineProperty(Element.prototype, "scrollIntoView", original);
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
  });

  it("leaves the monitor list out with one monitor", async () => {
    backend({ monitors: 1 });
    render(<Hub />);
    await screen.findByText("Ctrl+Shift+R");
    expect(screen.queryByRole("button", { name: "Monitor" })).not.toBeInTheDocument();
  });

  it("opens the Grab-it window and Settings", async () => {
    const calls = backend();
    render(<Hub />);
    // Its tooltip names the library hotkey.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open Grab-it" })).toHaveAttribute("title", expect.stringMatching(/^Open Grab-it \(.+\)$/)),
    );
    await userEvent.click(screen.getByRole("button", { name: "Open Grab-it" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Shortcuts" }));
    expect(sent(calls, "hub_open")).toEqual([{ view: "library" }, { view: "settings" }, { view: "welcome" }]);
  });

  it("shows the latest captures and opens one in the editor", async () => {
    const calls = backend({ shots: 2 });
    render(<Hub />);
    await userEvent.click(await screen.findByRole("button", { name: "Open Shot 2 in the editor" }));
    expect(sent(calls, "library_open")).toEqual([{ id: 2 }]);
  });

  it("says where captures will show before there are any", async () => {
    backend();
    render(<Hub />);
    expect(await screen.findByText("Your captures will show up here.")).toBeInTheDocument();
  });

  it("says Stop recording while a recording runs, and stops it", async () => {
    const calls = backend({ activity: { recording: true, steps: false } });
    render(<Hub />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop recording" }));
    expect(screen.getByRole("button", { name: /^Step capture/ })).toBeInTheDocument();
    expect(sent(calls, "hub_capture")).toContainEqual({ kind: "record", delaySeconds: null, monitor: null });
  });

  it("says Stop step capture while a step capture runs, and stops it", async () => {
    const calls = backend({ activity: { recording: false, steps: true } });
    render(<Hub />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop step capture" }));
    expect(screen.getByRole("button", { name: /^Record/ })).toBeInTheDocument();
    expect(sent(calls, "hub_capture")).toContainEqual({ kind: "steps", delaySeconds: null, monitor: null });
  });

  it("updates as a recording starts and stops while it is open", async () => {
    backend();
    render(<Hub />);
    // Loaded, so the first answer cannot land after the event.
    await screen.findByText("Ctrl+Shift+R");
    expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
    await act(() => emit(HUB_ACTIVITY_EVENT, { recording: true, steps: false }));
    expect(await screen.findByRole("button", { name: "Stop recording" })).toBeInTheDocument();
    await act(() => emit(HUB_ACTIVITY_EVENT, { recording: false, steps: true }));
    expect(await screen.findByRole("button", { name: "Stop step capture" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop recording" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Record/ })).toBeInTheDocument();
  });

  it("asks what is running each time it is shown", async () => {
    const calls = backend();
    render(<Hub />);
    await screen.findByText("Ctrl+Shift+R");
    expect(sent(calls, "hub_activity")).toHaveLength(1);
    await act(() => emit("hub-shown"));
    await waitFor(() => expect(sent(calls, "hub_activity")).toHaveLength(2));
  });

  it("is the hub route", () => {
    expect(routeFromHash("#/hub")).toBe("hub");
  });
});

describe("shortcutLabel", () => {
  it("uses key symbols on a Mac", () => {
    expect(shortcutLabel("Cmd+Shift+2", true)).toBe("⌘⇧2");
    expect(shortcutLabel("Alt+Ctrl+F", true)).toBe("⌥⌃F");
  });

  it("spells keys out elsewhere", () => {
    expect(shortcutLabel("Ctrl+Shift+PrintScreen", false)).toBe("Ctrl+Shift+PrintScreen");
  });
});

describe("keyCaps", () => {
  it("splits a hotkey into symbols on a Mac and words elsewhere", () => {
    expect(keyCaps("Cmd+Shift+2", true)).toEqual(["⌘", "⇧", "2"]);
    expect(keyCaps("Ctrl+Shift+PrintScreen", false)).toEqual(["Ctrl", "Shift", "PrintScreen"]);
  });
});
