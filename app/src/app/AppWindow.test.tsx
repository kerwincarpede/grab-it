import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import AppWindow from "./AppWindow";
import { viewFromHash } from "./api";
import App from "../App";
import { routeFromHash } from "../routes";

const SETTINGS = {
  saveFolder: "/home/me/Pictures/Grab-it",
  hotkeys: {
    region: "Cmd+Shift+2",
    window: "Cmd+Shift+W",
    screen: "Cmd+Shift+F",
    text: "Cmd+Shift+1",
    colour: "Cmd+Shift+9",
  },
  afterCapture: "quickAccess",
  copyToClipboard: true,
};

/** A backend with two apps and no captures; records every call. */
function backend() {
  const calls: { cmd: string; payload?: InvokeArgs }[] = [];
  mockIPC((cmd, payload) => {
    calls.push({ cmd, payload });
    switch (cmd) {
      case "get_settings":
        return SETTINGS;
      case "library_filter_options":
        return { apps: ["Chrome", "Ghostty"], tags: [], categories: [] };
      case "library_list":
        return { shots: [], offset: 0, total: 0 };
      case "library_search":
        return { hits: [], offset: 0, total: 0 };
      case "ocr_status":
        return { state: "idle" };
      case "ai_status":
        return { state: "idle", done: 0, total: 0, error: null };
      case "plugin:app|version":
        return "0.2.1";
      default:
        return null;
    }
  });
  return calls;
}

describe("AppWindow", () => {
  it("shows the logo, the capture button and the library", async () => {
    backend();
    render(<AppWindow />);
    expect(screen.getByText("Grab-it")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture region" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "All captures" })).toBeInTheDocument();
    expect(await screen.findByText("v0.2.1")).toBeInTheDocument();
  });

  it("lists the apps captures came from and filters by one", async () => {
    const calls = backend();
    render(<AppWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Chrome" }));
    expect(screen.getByRole("heading", { name: "Chrome" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chrome" })).toHaveAttribute("aria-current", "page");
    await waitFor(() =>
      expect(calls.some(({ cmd, payload }) => cmd === "library_search" && JSON.stringify(payload).includes("Chrome"))).toBe(
        true,
      ),
    );
    // The filter bar leaves the app to the sidebar.
    expect(screen.queryByRole("button", { name: /Filter by app/ })).not.toBeInTheDocument();
  });

  it("opens Settings pages in the same window", async () => {
    backend();
    render(<AppWindow />);
    await userEvent.click(screen.getByRole("button", { name: "Hotkeys" }));
    expect(screen.getByRole("heading", { level: 1, name: "Hotkeys" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("/home/me/Pictures/Grab-it")).toBeInTheDocument();
    // Hotkeys live on their own page.
    expect(screen.queryByRole("heading", { name: "Hotkeys", level: 2 })).not.toBeInTheDocument();
  });

  it("starts with the view the tray asked for", () => {
    backend();
    render(<AppWindow initialView="welcome" />);
    expect(screen.getByRole("heading", { name: "Welcome to Grab-it" })).toBeInTheDocument();
  });

  it("starts captures from the sidebar", async () => {
    const calls = backend();
    render(<AppWindow />);
    await userEvent.click(screen.getByRole("button", { name: "Capture region" }));
    await userEvent.click(screen.getByRole("button", { name: "More captures" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Record GIF" }));
    const captures = calls.filter(({ cmd }) => cmd === "hub_capture").map(({ payload }) => (payload as { kind: string }).kind);
    expect(captures).toEqual(["region", "record"]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("is the app route", () => {
    backend();
    render(<App route="app" />);
    expect(screen.getByRole("button", { name: "Capture region" })).toBeInTheDocument();
  });
});

describe("viewFromHash", () => {
  it.each([
    ["#/app", "library"],
    ["#/app/library", "library"],
    ["#/app/settings", "settings"],
    ["#/app/welcome", "welcome"],
    ["#/app/nowhere", "library"],
  ] as const)("maps %j to %s", (hash, view) => {
    expect(viewFromHash(hash)).toBe(view);
    expect(routeFromHash(hash)).toBe("app");
  });
});
