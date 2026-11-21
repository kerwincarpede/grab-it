import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";
import { routeFromHash } from "./routes";
import { mockCommands } from "./test/mockCommands";
import { testSettings } from "./test/settingsFixture";

describe("App", () => {
  it("renders the Grab-it heading", () => {
    render(<App route="home" />);
    expect(screen.getByRole("heading", { name: "Grab-it" })).toBeInTheDocument();
  });

  it("renders the Settings window for the settings route", async () => {
    // Only the save folder is checked; the window's other calls get the settings too, unchecked.
    mockCommands({ get_settings: () => testSettings() }, { otherwise: () => testSettings() });
    render(<App route="settings" />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("/home/me/Pictures/Grab-it")).toBeInTheDocument();
  });

  it("renders the recorded area's outline for the recordframe route", async () => {
    const calls = mockCommands({}, { shouldMockEvents: true, otherwise: () => null });
    const asked = () => calls.map((call) => call.cmd);
    render(<App route="recordframe" />);
    expect(screen.getByTestId("recordframe")).toBeInTheDocument();
    expect(screen.getAllByTestId("recordframe-corner")).toHaveLength(4);
    // It follows the recording's status, for the countdown.
    await waitFor(() => expect(asked()).toContain("record_bar_status"));
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
    ["#/webcam?shape=arch&mirror=0&camera=abc", "webcam"],
    ["#/recordbar", "recordbar"],
    ["#/recordframe?shape=window&margin=6&protected=1", "recordframe"],
    ["#/welcome", "welcome"],
    ["#/guide", "guide"],
    ["#settings", "settings"],
    ["#/settings?tab=general", "settings"],
    ["", "home"],
    ["#/unknown", "home"],
  ] as const)("maps %j to %s", (hash, route) => {
    expect(routeFromHash(hash)).toBe(route);
  });
});
