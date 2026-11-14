import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import Hub from "./Hub";
import { keyCaps, shortcutLabel } from "./keys";
import { routeFromHash } from "../routes";

function backend({ monitors = 1, shots = 0 } = {}) {
  const calls: { cmd: string; payload?: InvokeArgs }[] = [];
  mockIPC((cmd, payload) => {
    calls.push({ cmd, payload });
    switch (cmd) {
      case "get_settings":
        return {
          saveFolder: "/tmp",
          hotkeys: { region: "Ctrl+Shift+R", window: "Alt+PrintScreen", screen: "", text: "", colour: "" },
          afterCapture: "quickAccess",
          copyToClipboard: true,
        };
      case "library_list":
        return {
          shots: Array.from({ length: shots }, (_, index) => ({
            id: index + 1,
            path: `/tmp/${index}.png`,
            fileName: `${index}.png`,
            windowTitle: `Shot ${index + 1}`,
          })),
          offset: 0,
          total: shots,
        };
      case "library_thumbnail":
        return new ArrayBuffer(0);
      case "hub_monitors":
        return Array.from({ length: monitors }, (_, index) => ({ index, label: `${index + 1}. Display` }));
      default:
        return null;
    }
  });
  return calls;
}

const sent = (calls: { cmd: string; payload?: InvokeArgs }[], cmd: string) =>
  calls.filter((call) => call.cmd === cmd).map((call) => call.payload);

describe("Hub", () => {
  it("starts each capture by its kind", async () => {
    const calls = backend();
    render(<Hub />);
    for (const name of [/^Capture region/, /^Window/, /^Screen/, /^Record GIF/, /^Grab text/, /^Pick colour/]) {
      await userEvent.click(screen.getByRole("button", { name }));
    }
    await userEvent.click(screen.getByRole("button", { name: "Repeat last region" }));
    expect(sent(calls, "hub_capture").map((payload) => (payload as { kind: string }).kind)).toEqual([
      "region",
      "window",
      "screen",
      "record",
      "text",
      "colour",
      "repeat",
    ]);
  });

  it("shows the hotkeys", async () => {
    backend();
    render(<Hub />);
    expect(await screen.findByText("Ctrl+Shift+R")).toBeInTheDocument();
    expect(screen.getByText("Alt+PrintScreen")).toBeInTheDocument();
  });

  it("offers timed captures", async () => {
    const calls = backend();
    render(<Hub />);
    await userEvent.click(screen.getByRole("button", { name: "Timed" }));
    await userEvent.click(screen.getByRole("button", { name: "Region in 5 s" }));
    expect(sent(calls, "hub_capture")).toContainEqual({ kind: "region", delaySeconds: 5, monitor: undefined });
  });

  it("offers each monitor when there are several", async () => {
    const calls = backend({ monitors: 2 });
    render(<Hub />);
    await userEvent.click(await screen.findByRole("button", { name: "Monitor" }));
    await userEvent.click(screen.getByRole("button", { name: "2. Display" }));
    expect(sent(calls, "hub_capture")).toContainEqual({ kind: "monitor", delaySeconds: undefined, monitor: 1 });
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
