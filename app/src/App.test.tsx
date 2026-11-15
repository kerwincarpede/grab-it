import { render, screen } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { describe, expect, it } from "vitest";
import App from "./App";
import { routeFromHash } from "./routes";

describe("App", () => {
  it("renders the Grab-it heading", () => {
    render(<App route="home" />);
    expect(screen.getByRole("heading", { name: "Grab-it" })).toBeInTheDocument();
  });

  it("renders the Settings window for the settings route", async () => {
    mockIPC(() => ({
      saveFolder: "/home/me/Pictures/Grab-it",
      hotkeys: {
        region: "PrintScreen",
        window: "Alt+PrintScreen",
        screen: "Ctrl+PrintScreen",
        text: "Shift+PrintScreen",
        colour: "Ctrl+Shift+PrintScreen",
        library: "Alt+Shift+PrintScreen",
      },
      afterCapture: "quickAccess",
      copyToClipboard: true,
    }));
    render(<App route="settings" />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("/home/me/Pictures/Grab-it")).toBeInTheDocument();
  });
});

describe("routeFromHash", () => {
  it.each([
    ["#/settings", "settings"],
    ["#/overlay", "overlay"],
    ["#/editor", "editor"],
    ["#/recording", "recording"],
    ["#/library", "library"],
    ["#/quick", "quick"],
    ["#/pin", "pin"],
    ["#/welcome", "welcome"],
    ["#settings", "settings"],
    ["#/settings?tab=general", "settings"],
    ["", "home"],
    ["#/unknown", "home"],
  ] as const)("maps %j to %s", (hash, route) => {
    expect(routeFromHash(hash)).toBe(route);
  });
});
