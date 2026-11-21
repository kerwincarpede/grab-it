/// <reference types="node" />

import { describe, expect, it, vi } from "vitest";
import { chooseExportFile } from "./exportDialog";
import { mockCommands } from "../test/mockCommands";

vi.mock("@tauri-apps/api/path", async () => {
  const { posix } = await import("node:path");
  return { join: posix.join, dirname: posix.dirname };
});

describe("chooseExportFile", () => {
  it.each([undefined, "/previous"])("opens in the configured folder and remembers the choice (%s)", async (lastExportFolder) => {
    const chosen = "/new/place/result.png";
    const calls = mockCommands({}, {
      otherwise: (cmd) => {
        if (cmd === "get_settings") return { lastExportFolder, saveFolder: "/captures" };
        if (cmd === "plugin:dialog|save") return chosen;
        return null;
      },
    });
    expect(await chooseExportFile("result.png", {})).toBe(chosen);
    expect(calls).toContainEqual({
      cmd: "plugin:dialog|save",
      payload: { options: { defaultPath: `${lastExportFolder ?? "/captures"}/result.png` } },
    });
    expect(calls).toContainEqual({ cmd: "set_last_export_folder", payload: { folder: "/new/place" } });
  });

  it("keeps the folder when the dialog is cancelled", async () => {
    const calls = mockCommands({}, { otherwise: (cmd) => cmd === "get_settings" ? { saveFolder: "/captures" } : null });
    expect(await chooseExportFile("result.png", {})).toBeNull();
    expect(calls.some(({ cmd }) => cmd === "set_last_export_folder")).toBe(false);
  });
});
