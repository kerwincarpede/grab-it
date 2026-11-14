import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
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

const UPDATE = {
  current: "0.2.1",
  version: "0.3.0",
  date: "2026-11-12T09:00:00Z",
  changes: [
    { version: "0.3.0", items: ["Settings opens as a dialog", "AI adds short tags"] },
    { version: "0.2.2", items: ["Keeps permissions across updates"] },
  ],
};

/** A backend with two apps and no captures; records every call. */
function backend({ update = { state: "idle", current: "0.2.1" } as unknown } = {}) {
  const calls: { cmd: string; payload?: InvokeArgs }[] = [];
  mockIPC(
    (cmd, payload) => {
      calls.push({ cmd, payload });
      switch (cmd) {
        case "get_settings":
          return SETTINGS;
        case "library_sidebar":
          return {
            total: 3,
            apps: [
              { name: "Chrome", count: 2 },
              { name: "Ghostty", count: 1 },
            ],
            tags: [{ name: "rust", count: 2 }],
          };
        case "update_status":
          return update;
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
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  return calls;
}

describe("AppWindow", () => {
  it("shows the library with the capture button and the version", async () => {
    backend();
    render(<AppWindow />);
    const capture = screen.getByRole("button", { name: "New capture" });
    expect(screen.getByRole("heading", { name: "All captures" })).toBeInTheDocument();
    expect(await screen.findByText("v0.2.1")).toBeInTheDocument();
    // The region hotkey shows on the button, but is not part of its name.
    await waitFor(() => expect(capture).toHaveTextContent("Cmd+Shift+2"));
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
    // The filter menu leaves the app to the sidebar.
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.queryByRole("button", { name: /Filter by app/ })).not.toBeInTheDocument();
  });

  it("filters by a tag from the sidebar", async () => {
    const calls = backend();
    render(<AppWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "rust" }));
    expect(screen.getByRole("heading", { name: "Tagged rust" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "rust" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() =>
      expect(calls.some(({ cmd, payload }) => cmd === "library_search" && JSON.stringify(payload).includes('"tag":"rust"'))).toBe(
        true,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "All captures" }));
    expect(screen.getByRole("button", { name: "rust" })).toHaveAttribute("aria-pressed", "false");
  });

  it("opens Settings in a dialog, a page at a time", async () => {
    backend();
    render(<AppWindow />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    expect(await within(dialog).findByDisplayValue("/home/me/Pictures/Grab-it")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Hotkeys" }));
    expect(within(dialog).getByRole("heading", { level: 1, name: "Hotkeys" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close Settings" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens Settings with Cmd+comma and closes it with Escape", async () => {
    backend();
    render(<AppWindow />);
    await userEvent.keyboard("{Meta>},{/Meta}");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("starts with the welcome the tray asked for, over the library", async () => {
    backend();
    render(<AppWindow initialView="welcome" />);
    const dialog = screen.getByRole("dialog", { name: "Welcome to Grab-it" });
    expect(screen.getByRole("heading", { name: "All captures" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Get started" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens Shortcuts and tips from the sidebar", async () => {
    backend();
    render(<AppWindow />);
    await userEvent.click(screen.getByRole("button", { name: "Shortcuts and tips" }));
    expect(screen.getByRole("dialog", { name: "Welcome to Grab-it" })).toBeInTheDocument();
  });

  it("starts captures from the title bar", async () => {
    const calls = backend();
    render(<AppWindow />);
    await userEvent.click(screen.getByRole("button", { name: "New capture" }));
    await userEvent.click(screen.getByRole("button", { name: "More captures" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Record GIF" }));
    const captures = calls.filter(({ cmd }) => cmd === "hub_capture").map(({ payload }) => (payload as { kind: string }).kind);
    expect(captures).toEqual(["region", "record"]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("checks for updates from the sidebar", async () => {
    const calls = backend();
    render(<AppWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    expect(calls.some(({ cmd }) => cmd === "update_check")).toBe(true);
  });

  it("shows a waiting update in the sidebar and installs it from the dialog", async () => {
    const calls = backend({ update: { state: "available", info: UPDATE, declined: false } });
    render(<AppWindow />);
    expect(await screen.findByText("Update available")).toBeInTheDocument();
    expect(screen.getByText("Version 0.3.0")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = screen.getByRole("dialog", { name: "Updates" });
    expect(within(dialog).getByText("Grab-it 0.3.0 is available")).toBeInTheDocument();
    expect(within(dialog).getByText("Settings opens as a dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Changes in 0.2.2" })).toHaveTextContent("Keeps permissions");

    await userEvent.click(within(dialog).getByRole("button", { name: "Install and restart" }));
    expect(calls.some(({ cmd }) => cmd === "update_install")).toBe(true);
  });

  it("says Later without installing", async () => {
    const calls = backend({ update: { state: "available", info: UPDATE, declined: false } });
    render(<AppWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "View" }));
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some(({ cmd }) => cmd === "update_later")).toBe(true);
    expect(calls.some(({ cmd }) => cmd === "update_install")).toBe(false);
  });

  it("opens the Updates dialog when a check the user asked for reports back", async () => {
    backend();
    render(<AppWindow />);
    await screen.findByText("v0.2.1");
    await act(async () => {
      await emit("update-status", { status: { state: "upToDate", current: "0.2.1", checkedAt: 1 }, show: true });
    });
    const dialog = screen.getByRole("dialog", { name: "Updates" });
    expect(within(dialog).getByText("Grab-it is up to date")).toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();

    await act(async () => {
      await emit("update-status", {
        status: { state: "installing", info: UPDATE, downloaded: 5_000_000, total: 20_000_000 },
        show: true,
      });
    });
    expect(screen.getByText("Installing Grab-it 0.3.0")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Download" })).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("5.0 of 20.0 MB")).toBeInTheDocument();
  });

  it("is the app route", () => {
    backend();
    render(<App route="app" />);
    expect(screen.getByRole("button", { name: "New capture" })).toBeInTheDocument();
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
