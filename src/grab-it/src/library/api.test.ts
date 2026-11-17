import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import { shotWords, type OcrLine } from "./api";

const lines: OcrLine[] = [
  {
    text: "Order pineapple today",
    x: 120,
    y: 60,
    width: 400,
    height: 40,
    words: [
      { text: "Order", x: 120, y: 62, width: 110, height: 36 },
      { text: "pineapple", x: 245, y: 60, width: 170, height: 40 },
      { text: "today", x: 430, y: 62, width: 90, height: 36 },
    ],
  },
];

describe("shotWords", () => {
  it("asks for the shot's lines and resolves to them", async () => {
    const calls: { cmd: string; payload?: InvokeArgs }[] = [];
    mockIPC((cmd, payload) => {
      calls.push({ cmd, payload });
      return cmd === "library_words" ? lines : undefined;
    });

    await expect(shotWords(7)).resolves.toEqual(lines);
    expect(calls).toEqual([{ cmd: "library_words", payload: { id: 7 } }]);
  });

  it("resolves to null for a shot without word boxes", async () => {
    mockIPC((cmd) => (cmd === "library_words" ? null : undefined));

    await expect(shotWords(3)).resolves.toBeNull();
  });

  it("rejects with the backend's message", async () => {
    mockIPC(() => {
      throw "no shot 99";
    });

    await expect(shotWords(99)).rejects.toBe("no shot 99");
  });
});
