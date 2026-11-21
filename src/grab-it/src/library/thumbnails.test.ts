import { describe, expect, it, vi } from "vitest";
import { loadThumbnail, thumbKey } from "./thumbnails";
import { mockCommands, type CommandHandlers } from "../test/mockCommands";

const { drawn } = vi.hoisted(() => ({ drawn: new Uint8Array([137, 80, 78, 71, 7]) }));
vi.mock("../editor/renderCapture", () => ({ renderCapture: vi.fn(async () => drawn) }));

function backend(fail: string[] = []) {
  const failing = (cmd: string) => {
    if (fail.includes(cmd)) throw `${cmd} failed`;
  };
  const handlers: CommandHandlers = {
    library_thumbnail: () => {
      failing("library_thumbnail");
      return new Uint8Array([1, 2, 3]).buffer;
    },
    library_image: () => {
      failing("library_image");
      return new Uint8Array([137, 80, 78, 71]).buffer;
    },
    library_annotations: () => {
      failing("library_annotations");
      return { annotations: { version: 1, shapes: [] }, scaleFactor: 2, editedAt: 5_000 };
    },
    library_save_thumbnail: () => {
      failing("library_save_thumbnail");
      return null;
    },
  };
  return mockCommands(handlers);
}

const commands = (calls: { cmd: string }[]) => calls.map((call) => call.cmd);

describe("thumbKey", () => {
  it("changes when the file moves or its edits are saved again", () => {
    const base = { id: 3, path: "/p/originals/a.png", editedAt: null };
    expect(thumbKey(base)).not.toBe(thumbKey({ ...base, path: "/p/originals/b.png" }));
    expect(thumbKey({ ...base, editedAt: 10 })).not.toBe(thumbKey(base));
    expect(thumbKey({ ...base, editedAt: 10 })).not.toBe(thumbKey({ ...base, editedAt: 11 }));
    expect(thumbKey({ ...base, editedAt: 10 })).toBe(thumbKey({ ...base, editedAt: 10 }));
  });
});

describe("loadThumbnail", () => {
  it("reads a thumbnail that is up to date", async () => {
    const calls = backend();
    await loadThumbnail({ id: 3, thumbStale: false });
    expect(commands(calls)).toEqual(["library_thumbnail"]);
  });

  it("draws an out-of-date one with its edits, saves it and reads back the fitted file", async () => {
    const calls = backend();
    const bytes = await loadThumbnail({ id: 3, thumbStale: true });
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(commands(calls).sort()).toEqual(["library_annotations", "library_image", "library_save_thumbnail", "library_thumbnail"]);
    const save = calls.find((call) => call.cmd === "library_save_thumbnail");
    expect(save?.payload).toEqual(drawn);
  });

  it("shows what it drew when saving fails", async () => {
    backend(["library_save_thumbnail"]);
    await expect(loadThumbnail({ id: 3, thumbStale: true })).resolves.toBe(drawn);
  });

  it("falls back to the saved thumbnail when the edits cannot be drawn", async () => {
    const calls = backend(["library_annotations"]);
    const bytes = await loadThumbnail({ id: 3, thumbStale: true });
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(commands(calls)).not.toContain("library_save_thumbnail");
  });
});
