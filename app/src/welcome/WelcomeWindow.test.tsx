import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import { acceleratorKeys } from "../settings/accelerator";
import WelcomeWindow from "./WelcomeWindow";

const HOTKEYS = {
  region: "PrintScreen",
  window: "Alt+PrintScreen",
  screen: "Ctrl+PrintScreen",
  text: "Shift+PrintScreen",
  colour: "Ctrl+Shift+PrintScreen",
};

function mockBackend(options: { failSettings?: boolean; failOpen?: string; ai?: object } = {}) {
  const calls: { cmd: string; payload?: InvokeArgs }[] = [];
  mockIPC((cmd, payload) => {
    calls.push({ cmd, payload });
    if (cmd === "get_settings") {
      if (options.failSettings) throw "no settings";
      return {
        saveFolder: "/shots",
        hotkeys: HOTKEYS,
        afterCapture: "quickAccess",
        copyToClipboard: true,
        ...(options.ai ? { ai: options.ai } : {}),
      };
    }
    if (cmd === "open_target" && options.failOpen) throw options.failOpen;
    return null;
  });
  return calls;
}

describe("WelcomeWindow", () => {
  it("lists what each hotkey does with the user's own keys", async () => {
    mockBackend();
    render(<WelcomeWindow />);
    expect(screen.getByRole("heading", { name: "Welcome to Grab-it" })).toBeInTheDocument();

    const text = (await screen.findByLabelText("Shift+PrintScreen")).closest("li") as HTMLElement;
    expect(within(text).getByText("Capture text")).toBeInTheDocument();
    const colour = screen.getByLabelText("Ctrl+Shift+PrintScreen");
    expect(within(colour).getAllByText(/Ctrl|Shift|PrintScreen/)).toHaveLength(3);
  });

  it("mentions AI descriptions only while Claude Code describes captures", async () => {
    mockBackend({ ai: { enabled: true, provider: "claudeCode" } });
    const { unmount } = render(<WelcomeWindow />);
    expect(await screen.findByText(/Claude Code describes each new capture/)).toBeInTheDocument();
    unmount();

    for (const ai of [{ enabled: false, provider: "claudeCode" }, { enabled: true, provider: null }, undefined]) {
      mockBackend({ ai });
      const view = render(<WelcomeWindow />);
      await screen.findByLabelText("Shift+PrintScreen");
      expect(screen.queryByText(/Claude Code describes/)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("still explains itself when the hotkeys cannot be read", async () => {
    const calls = mockBackend({ failSettings: true });
    render(<WelcomeWindow />);
    await waitFor(() => expect(calls.map((call) => call.cmd)).toContain("get_settings"));
    expect(screen.getByText("Capture a region")).toBeInTheDocument();
    expect(screen.getByText("Quick Access")).toBeInTheDocument();
  });

  it.each([
    ["Capture a region now", "region"],
    ["Open Settings", "settings"],
    ["Open the Library", "library"],
  ])("%s opens %s", async (name, target) => {
    const calls = mockBackend();
    render(<WelcomeWindow />);
    await userEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(calls).toContainEqual({ cmd: "open_target", payload: { target } }));
  });

  it("says so when something cannot be opened", async () => {
    mockBackend({ failOpen: "could not open Settings" });
    render(<WelcomeWindow />);
    await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(await screen.findByText("could not open Settings")).toBeInTheDocument();
  });
});

describe("acceleratorKeys", () => {
  it("splits an accelerator into its keys", () => {
    expect(acceleratorKeys("Ctrl+Shift+PrintScreen")).toEqual(["Ctrl", "Shift", "PrintScreen"]);
    expect(acceleratorKeys("PrintScreen")).toEqual(["PrintScreen"]);
    expect(acceleratorKeys("")).toEqual([]);
  });
});
