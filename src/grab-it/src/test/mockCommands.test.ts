import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import { commands } from "../app/bindings";
import { mockCommands } from "./mockCommands";

describe("mockCommands", () => {
  it("answers a command by its Rust name and records the call", async () => {
    const calls = mockCommands({ set_autostart: ({ enabled }) => enabled });

    await expect(commands.setAutostart(true)).resolves.toBe(true);
    expect(calls).toEqual([{ cmd: "set_autostart", payload: { enabled: true } }]);
  });

  it("answers a byte command with its bytes", async () => {
    const bytes = new ArrayBuffer(4);
    mockCommands({ library_image: ({ id }) => (id === 7 ? bytes : new ArrayBuffer(0)) });

    await expect(invoke("library_image", { id: 7 })).resolves.toBe(bytes);
  });

  it("fails a command without a handler", async () => {
    mockCommands({});

    await expect(commands.getAutostart()).rejects.toThrow("get_autostart");
  });

  it("hands other commands to the fallback", async () => {
    mockCommands({}, { otherwise: (cmd) => (cmd === "plugin:dialog|open" ? "/tmp/a.png" : null) });

    await expect(invoke("plugin:dialog|open")).resolves.toBe("/tmp/a.png");
  });

  it("types each handler from its Rust command", () => {
    mockCommands({
      // @ts-expect-error set_autostart returns a boolean.
      set_autostart: () => "on",
      // @ts-expect-error get_autostart takes no `enabled` argument.
      get_autostart: (args: { enabled: boolean }) => args.enabled,
      // @ts-expect-error library_thumbnail returns bytes.
      library_thumbnail: () => null,
    });
  });
});
