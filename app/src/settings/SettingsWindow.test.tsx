import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import SettingsWindow from "./SettingsWindow";

const DEFAULT_HOTKEYS = {
  region: "PrintScreen",
  window: "Alt+PrintScreen",
  screen: "Ctrl+PrintScreen",
};

interface Backend {
  saveFolder: string;
  hotkeys: typeof DEFAULT_HOTKEYS;
  hotkeyWarnings: string[];
  picked: string | null;
  setError?: string;
  calls: { cmd: string; payload?: InvokeArgs }[];
}

function mockBackend(initial: Partial<Backend> = {}): Backend {
  const backend: Backend = {
    saveFolder: "/home/me/Pictures/Grab-it",
    picked: "/data/Shots",
    hotkeys: { ...DEFAULT_HOTKEYS },
    hotkeyWarnings: [],
    calls: [],
    ...initial,
  };
  mockIPC((cmd, payload) => {
    backend.calls.push({ cmd, payload });
    switch (cmd) {
      case "get_settings":
        return { saveFolder: backend.saveFolder, hotkeys: backend.hotkeys };
      case "plugin:dialog|open":
        return backend.picked;
      case "set_save_folder": {
        if (backend.setError) throw backend.setError;
        backend.saveFolder = (payload as { path: string }).path;
        return { saveFolder: backend.saveFolder, hotkeys: backend.hotkeys };
      }
      case "set_hotkeys": {
        if (backend.setError) throw backend.setError;
        backend.hotkeys = (payload as { hotkeys: typeof DEFAULT_HOTKEYS }).hotkeys;
        return {
          settings: { saveFolder: backend.saveFolder, hotkeys: backend.hotkeys },
          warnings: backend.hotkeyWarnings,
        };
      }
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return backend;
}

const commands = (backend: Backend) => backend.calls.map((call) => call.cmd);

describe("SettingsWindow", () => {
  it("shows the current save folder", async () => {
    mockBackend();
    render(<SettingsWindow />);
    const input = await screen.findByLabelText("Save folder");
    expect(await screen.findByDisplayValue("/home/me/Pictures/Grab-it")).toBe(input);
    expect(screen.getByRole("button", { name: "Change…" })).toBeEnabled();
  });

  it("changes the save folder to the picked folder", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    await screen.findByDisplayValue("/home/me/Pictures/Grab-it");

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    expect(await screen.findByDisplayValue("/data/Shots")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Save folder updated.");
    const dialog = backend.calls.find((call) => call.cmd === "plugin:dialog|open");
    expect(dialog?.payload).toMatchObject({
      options: { directory: true, defaultPath: "/home/me/Pictures/Grab-it" },
    });
    expect(backend.calls[backend.calls.length - 1]).toEqual({ cmd: "set_save_folder", payload: { path: "/data/Shots" } });
  });

  it("keeps the folder when the dialog is cancelled", async () => {
    const backend = mockBackend({ picked: null });
    render(<SettingsWindow />);
    await screen.findByDisplayValue("/home/me/Pictures/Grab-it");

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    expect(screen.getByDisplayValue("/home/me/Pictures/Grab-it")).toBeInTheDocument();
    expect(commands(backend)).not.toContain("set_save_folder");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("shows the error when the folder cannot be used", async () => {
    mockBackend({ setError: "Permission denied (os error 13)" });
    render(<SettingsWindow />);
    await screen.findByDisplayValue("/home/me/Pictures/Grab-it");

    await userEvent.click(screen.getByRole("button", { name: "Change…" }));

    expect(await screen.findByText("Permission denied (os error 13)")).toBe(
      screen.getByRole("status"),
    );
    expect(screen.getByDisplayValue("/home/me/Pictures/Grab-it")).toBeInTheDocument();
  });

  it("shows the current hotkeys", async () => {
    mockBackend();
    render(<SettingsWindow />);
    expect(await screen.findByLabelText("Region")).toHaveValue("PrintScreen");
    expect(screen.getByLabelText("Window")).toHaveValue("Alt+PrintScreen");
    expect(screen.getByLabelText("Screen")).toHaveValue("Ctrl+PrintScreen");
    expect(screen.getByRole("button", { name: "Save hotkeys" })).toBeDisabled();
  });

  it("records a new hotkey and saves it", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    const region = await screen.findByLabelText("Region");

    await userEvent.click(region);
    await userEvent.keyboard("{Control>}{Shift>}[KeyR]{/Shift}{/Control}");

    expect(region).toHaveValue("Ctrl+Shift+R");
    await userEvent.click(screen.getByRole("button", { name: "Save hotkeys" }));

    expect(await screen.findByText("Hotkeys updated.")).toBe(screen.getByRole("status"));
    expect(backend.calls.at(-1)).toEqual({
      cmd: "set_hotkeys",
      payload: { hotkeys: { ...DEFAULT_HOTKEYS, region: "Ctrl+Shift+R" } },
    });
    expect(screen.getByRole("button", { name: "Save hotkeys" })).toBeDisabled();
  });

  it("reverts unsaved hotkey changes", async () => {
    const backend = mockBackend();
    render(<SettingsWindow />);
    const screenField = await screen.findByLabelText("Screen");

    await userEvent.click(screenField);
    await userEvent.keyboard("[F9]");
    expect(screenField).toHaveValue("F9");
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));

    expect(screenField).toHaveValue("Ctrl+PrintScreen");
    expect(commands(backend)).not.toContain("set_hotkeys");
  });

  it("shows hotkeys the system would not register", async () => {
    mockBackend({ hotkeyWarnings: ["Region hotkey `F9` could not be registered: taken"] });
    render(<SettingsWindow />);
    const region = await screen.findByLabelText("Region");

    await userEvent.click(region);
    await userEvent.keyboard("[F9]");
    await userEvent.click(screen.getByRole("button", { name: "Save hotkeys" }));

    expect(
      await screen.findByText("Region hotkey `F9` could not be registered: taken"),
    ).toBeInTheDocument();
  });

  it("shows why hotkeys were rejected and keeps the draft", async () => {
    mockBackend({ setError: "Window and Region use the same hotkey." });
    render(<SettingsWindow />);
    const windowField = await screen.findByLabelText("Window");

    await userEvent.click(windowField);
    await userEvent.keyboard("[PrintScreen]");
    await userEvent.click(screen.getByRole("button", { name: "Save hotkeys" }));

    expect(await screen.findByText("Window and Region use the same hotkey.")).toBeInTheDocument();
    expect(windowField).toHaveValue("PrintScreen");
  });
});
