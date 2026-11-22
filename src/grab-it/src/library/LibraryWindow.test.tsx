/// <reference types="node" />

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emit } from "@tauri-apps/api/event";
import type { Removal } from "../settings/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LibraryWindow from "./LibraryWindow";
import type { SearchQuery_Deserialize, Settings_Serialize } from "../app/bindings";
import { mockCommands, type CommandCall, type CommandHandlers } from "../test/mockCommands";

vi.mock("@tauri-apps/api/path", async () => {
  const { posix } = await import("node:path");
  return { join: posix.join, dirname: posix.dirname };
});

// Drawing a capture with its edits needs a real canvas; the image it gives is stood in for.
vi.mock("../editor/renderCapture", () => ({ renderCapture: vi.fn(async () => new Uint8Array([137, 80, 78, 71, 1])) }));
import { DETAILS_WIDTH, clampDetailsWidth } from "./detailsWidth";
import { resetThumbnails } from "./thumbnails";
import {
  AI_STATUS_EVENT,
  LIBRARY_CHANGED_EVENT,
  LIBRARY_CLEANED_EVENT,
  CLEANUP_DONE_EVENT,
  CLEANUP_PROGRESS_EVENT,
  cleanedText,
  NO_FILTERS,
  OCR_STATUS_EVENT,
  PAGE_SIZE,
  buildQuery,
  categoryLabel,
  dateFilterLabel,
  dayLabel,
  dayStart,
  groupByDay,
  isSearching,
  parseTags,
  type AiStatus,
  type LibraryStorage,
  type MatchField,
  type OcrStatus,
  type SearchHit,
  type SearchQuery,
  type Shot,
} from "./api";

function shot(id: number, overrides: Partial<Shot> = {}): Shot {
  return {
    id,
    path: `/home/me/Pictures/Grab-it/originals/Grab-it ${id}.png`,
    fileName: `Grab-it ${id}.png`,
    thumbPath: `/home/me/Pictures/Grab-it/thumbs/Grab-it ${id}.png`,
    capturedAt: Date.UTC(2026, 2, 7, 9, 0, id),
    mode: "region",
    app: "firefox",
    windowTitle: "Docs",
    width: 800,
    height: 600,
    tags: [],
    notes: "",
    aiDescription: null,
    aiCategory: null,
    aiTags: [],
    aiWaiting: false,
    kind: "image",
    durationMs: null,
    bytes: null,
    keep: false,
    editedAt: null,
    thumbStale: false,
    ...overrides,
  };
}

/** Settings as `get_settings` sends them, with AI describing as the backend says. */
function settings(backend: Backend): Settings_Serialize {
  return {
    lastExportFolder: backend.lastExportFolder,
    saveFolder: "/home/me/Pictures/Grab-it",
    hotkeys: {
      allInOne: "",
      region: "",
      window: "",
      screen: "",
      text: "",
      colour: "",
      library: "",
      steps: "",
    },
    editor: {},
    showInDock: true,
    appearance: { textScale: 1, hubScale: 1, popupCorner: "bottomRight", popupSeconds: 5 },
    recording: {
      format: "mp4",
      quality: "medium",
      fps: 30,
      showCursor: true,
      showClicks: false,
      showKeystrokes: false,
      audio: "none",
      microphone: null,
      removeNoise: false,
      showWebcam: false,
      camera: null,
      webcamShape: "squircle",
      mirrorWebcam: false,
      countdown: 0,
      source: "region",
    },
    retention: backend.removal
      ? { image: null, gif: 90, video: 30, removal: backend.removal }
      : { image: null, gif: null, video: null, removal: "trash" },
    permissions: { asked: true, resume: false },
    agentAccess: false,
    updateChannel: "stable",
    afterCapture: "quickAccess",
    copyToClipboard: true,
    copySound: true,
    copySoundVolume: 50,
    ai: {
      enabled: backend.aiEnabled ?? backend.aiNotice,
      ...(backend.aiAutomatic === undefined ? {} : { automaticDescriptions: backend.aiAutomatic }),
      provider: backend.aiProvider === undefined ? "claudeCode" : backend.aiProvider,
      endpoint: "",
      model: "",
      claudeModel: "",
      codexModel: "",
      apiKey: null,
      newCapturesOnly: false,
      tidyText: false,
      noticePending: backend.aiNotice,
      apiKeyStorage: "keychain",
    },
  };
}

interface Backend {
  shots: Shot[];
  calls: CommandCall[];
  fail?: string;
  /** Text OCR found, by shot id. */
  ocr: Record<number, string>;
  /** Shots OCR has not read yet, and the text it finds when asked to read one now. */
  unread?: Record<number, string>;
  ocrStatus: OcrStatus;
  aiStatus: AiStatus;
  /** Grab-it turned AI descriptions on and the Library has not said so yet. */
  aiNotice: boolean;
  /** Whether describing is on now; the notice's own flag when unset. */
  aiEnabled?: boolean;
  /** Settings' Describe captures with AI; left out, as from an earlier version, when unset. */
  aiAutomatic?: boolean;
  /** The provider now; Claude Code when unset. */
  aiProvider?: "claudeCode" | "codex" | "endpoint" | null;
  /** The save folder's disk; unreadable when null. */
  disk?: { free: number; total: number } | null;
  /** `library_storage` fails, as an older backend without it would. */
  storageFails?: boolean;
  /** What cleanup would remove, by kind; left out of `library_storage` when unset, as older backends do. */
  due?: Partial<Record<"image" | "gif" | "video", { count: number; bytes: number }>>;
  /** How Settings says cleanup removes items; no Keep settings when unset. */
  removal?: Removal;
  /** The system can ask which app to open a file with; it cannot when unset. */
  openWith?: boolean;
  /** What the save dialog answers; cancelled when unset. */
  lastExportFolder?: string;
  saveAs?: string | null;
  /** The folder the open dialog answers; cancelled when unset. */
  openFolder?: string | null;
  /** Commands that fail for these shot ids, by command. */
  failIds?: Record<string, number[]>;
  /** `library_set_tags` fails with this. */
  tagsFail?: string;
  /** Answers `library_clean_up`; nothing removed when unset. */
  cleanUp?: (removal: Removal) => Promise<{ count: number; bytes: number }> | { count: number; bytes: number };
}

/** A small stand-in for `Library::search`: every word must start a word in some field. */
function search(backend: Backend, query: SearchQuery_Deserialize): SearchHit[] {
  const words = (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  for (const item of [...backend.shots].sort((a, b) => b.capturedAt - a.capturedAt)) {
    if (query.app && item.app !== query.app) continue;
    if (query.tag && ![...item.tags, ...item.aiTags].some((tag) => tag.toLowerCase() === query.tag?.toLowerCase()))
      continue;
    if (query.category && item.aiCategory !== query.category) continue;
    const recorded = item.kind === "video" || item.kind === "gif";
    if (query.kind === "recording" && !recorded) continue;
    if (query.kind === "image" && recorded) continue;
    if (query.from != null && item.capturedAt < query.from) continue;
    if (query.to != null && item.capturedAt >= query.to) continue;
    const fields: [MatchField, string][] = [
      ["text", backend.ocr[item.id] ?? ""],
      ["tags", item.tags.join(" ")],
      ["notes", item.notes],
      ["app", item.app ?? ""],
      ["windowTitle", item.windowTitle ?? ""],
      ["description", item.aiDescription ?? ""],
    ];
    const tokens = fields.map(([, value]) => value.toLowerCase().split(/\W+/));
    if (!words.every((word) => tokens.some((list) => list.some((token) => token.startsWith(word))))) continue;
    if (words.length === 0) {
      hits.push({ shot: item, field: null, snippet: [] });
      continue;
    }
    const index = tokens.findIndex((list) => list.some((token) => token.startsWith(words[0])));
    const [field, value] = fields[index];
    const snippet = value.split(/(\W+)/).map((part) => ({
      text: part,
      hit: words.some((word) => part.toLowerCase().startsWith(word)),
    }));
    hits.push({ shot: item, field, snippet });
  }
  return hits;
}

function mockBackend(shots: Shot[]): Backend {
  const backend: Backend = {
    shots,
    calls: [],
    ocr: {},
    ocrStatus: { state: "idle" },
    aiStatus: { state: "idle", done: 0, total: 0, error: null, provider: "claudeCode", current: null },
    aiNotice: false,
    aiProvider: "claudeCode",
  };
  const find = (id: number) => {
    const found = backend.shots.find((item) => item.id === id);
    if (!found) throw `no capture with id ${id}`;
    return found;
  };
  /** Fails a command as the backend would: all of them with `fail`, or for the ids in `failIds`. */
  const check = (cmd: string, payload: unknown) => {
    if (backend.fail) throw backend.fail;
    const id = (payload as { id?: number } | undefined)?.id;
    if (id !== undefined && backend.failIds?.[cmd]?.includes(id)) throw `could not reach shot ${id}`;
  };
  const update = (updated: Shot) => {
    backend.shots = backend.shots.map((item) => (item.id === updated.id ? updated : item));
    return updated;
  };
  const opened = ({ id }: { id: number }) => {
    find(id);
    return null;
  };
  const handlers: CommandHandlers = {
    library_list: ({ offset, limit }) => {
      const sorted = [...backend.shots].sort((a, b) => b.capturedAt - a.capturedAt);
      return { shots: sorted.slice(offset, offset + limit), offset, total: sorted.length };
    },
    library_thumbnail: () => new Uint8Array([137, 80, 78, 71]).buffer,
    library_storage: () => {
      if (backend.storageFails) throw new Error("unexpected command library_storage");
      const usage = (kind: string) => {
        const items = backend.shots.filter((item) => (item.kind ?? "image") === kind);
        return { count: items.length, bytes: items.reduce((sum, item) => sum + (item.bytes ?? 0), 0) };
      };
      const none = { count: 0, bytes: 0 };
      const due = backend.due && {
        image: backend.due.image ?? none,
        gif: backend.due.gif ?? none,
        video: backend.due.video ?? none,
      };
      // Without `due` set, it is left out as older backends do, which the generated type does not allow.
      return {
        image: usage("image"),
        gif: usage("gif"),
        video: usage("video"),
        disk: backend.disk ?? null,
        ...(due ? { due } : {}),
      } as LibraryStorage;
    },
    library_clean_up: ({ removal, confirmed }) => {
      // As the backend does: nothing is removed when more is due than the dialog showed.
      const due = Object.values(backend.due ?? {});
      const count = due.reduce((sum, kind) => sum + kind.count, 0);
      const bytes = due.reduce((sum, kind) => sum + kind.bytes, 0);
      if (count > confirmed.count || bytes > confirmed.bytes) {
        throw `More is due now than when you confirmed: ${count} items. Check what Clean up removes and confirm again.`;
      }
      return backend.cleanUp ? backend.cleanUp(removal) : { count: 0, bytes: 0 };
    },
    library_stop_clean_up: () => undefined,
    library_set_tags: ({ id, tags }) => {
      if (backend.tagsFail) throw backend.tagsFail;
      return update({ ...find(id), tags });
    },
    library_set_notes: ({ id, notes }) => update({ ...find(id), notes }),
    library_set_keep: ({ id, keep }) => update({ ...find(id), keep }),
    library_delete: ({ id }) => {
      find(id);
      backend.shots = backend.shots.filter((item) => item.id !== id);
      return null;
    },
    library_trash: ({ id }) => {
      find(id);
      backend.shots = backend.shots.filter((item) => item.id !== id);
      return null;
    },
    library_rename: ({ id, name }) => {
      // As the backend does: the extension is kept, and a taken name is refused.
      const current = find(id);
      const extension = current.fileName.slice(current.fileName.lastIndexOf("."));
      const fileName = `${name.trim()}${extension}`;
      if (backend.shots.some((item) => item.id !== current.id && item.fileName === fileName)) {
        throw `There is already a file called ${fileName}.`;
      }
      const folder = current.path.slice(0, current.path.lastIndexOf("/") + 1);
      return update({ ...current, fileName, path: `${folder}${fileName}` });
    },
    library_duplicate: ({ id }) => {
      const current = find(id);
      const dot = current.fileName.lastIndexOf(".");
      const fileName = `${current.fileName.slice(0, dot)} copy${current.fileName.slice(dot)}`;
      const folder = current.path.slice(0, current.path.lastIndexOf("/") + 1);
      const copy = {
        ...current,
        id: Math.max(...backend.shots.map((item) => item.id)) + 1,
        fileName,
        path: `${folder}${fileName}`,
        keep: false,
      };
      backend.shots = [...backend.shots, copy];
      return copy;
    },
    library_open_with_supported: () => backend.openWith ?? false,
    library_text: ({ id }) => {
      find(id);
      if (backend.unread && id in backend.unread) return { state: "waiting" };
      return { state: "read", text: backend.ocr[id] ?? "" };
    },
    library_copy_text: ({ id }) => {
      find(id);
      if (backend.unread && id in backend.unread) {
        backend.ocr[id] = backend.unread[id];
        delete backend.unread[id];
      }
      const text = backend.ocr[id] ?? "";
      if (!text.trim()) throw "No text found in this capture.";
      return text;
    },
    library_image: ({ id }) => {
      find(id);
      return new Uint8Array([137, 80, 78, 71]).buffer;
    },
    library_annotations: ({ id }) => {
      find(id);
      return { annotations: { version: 1, shapes: [] }, scaleFactor: 2, editedAt: 5_000 };
    },
    editor_copy: () => null,
    editor_pin: () => null,
    library_save_thumbnail: () => null,
    library_open: opened,
    library_copy: opened,
    library_pin: opened,
    library_play: opened,
    library_reveal: opened,
    library_open_folder: opened,
    library_open_external: opened,
    library_open_with: opened,
    library_copy_path: ({ id }) => find(id).path,
    library_copy_file: opened,
    library_export: ({ id, target }) => {
      find(id);
      return target;
    },
    library_search: ({ query, offset, limit }) => {
      const hits = search(backend, query);
      return { hits: hits.slice(offset, offset + limit), offset, total: hits.length };
    },
    library_filter_options: () => ({
      apps: [...new Set(backend.shots.map((item) => item.app).filter((app): app is string => !!app))].sort(),
      tags: [...new Set(backend.shots.flatMap((item) => [...item.tags, ...item.aiTags]))].sort(),
      categories: [
        ...new Set(backend.shots.map((item) => item.aiCategory).filter((found): found is string => !!found)),
      ].sort(),
    }),
    ocr_status: () => backend.ocrStatus,
    ai_status: () => backend.aiStatus,
    ai_redescribe: opened,
    ai_cancel: () => null,
    library_remove_ai_tag: ({ id, tag }) => {
      const current = find(id);
      const lower = tag.toLowerCase();
      return update({ ...current, aiTags: current.aiTags.filter((item) => item.toLowerCase() !== lower) });
    },
    ai_clear: ({ id }) => {
      update({ ...find(id), aiDescription: null, aiCategory: null, aiTags: [] });
      return null;
    },
    open_target: () => null,
    get_settings: () => settings(backend),
    set_last_export_folder: ({ folder }) => {
      backend.lastExportFolder = folder;
      return settings(backend);
    },
    dismiss_ai_notice: () => {
      backend.aiNotice = false;
      return settings(backend);
    },
  };
  const guarded: Record<string, (payload: unknown) => unknown> = {};
  for (const [cmd, handler] of Object.entries(handlers) as [string, (payload: unknown) => unknown][]) {
    guarded[cmd] = (payload) => {
      check(cmd, payload);
      return handler(payload);
    };
  }
  backend.calls = mockCommands(guarded as CommandHandlers, {
    shouldMockEvents: true,
    otherwise: (cmd, payload) => {
      check(cmd, payload);
      switch (cmd) {
        case "plugin:dialog|save":
          return backend.saveAs ?? null;
        case "plugin:dialog|open":
          return backend.openFolder ?? null;
        default:
          throw new Error(`unexpected command ${cmd}`);
      }
    },
  });
  return backend;
}

const callsTo = (backend: Backend, cmd: string) => backend.calls.filter((call) => call.cmd === cmd);

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:thumb");
  URL.revokeObjectURL = vi.fn();
  resetThumbnails();
});

describe("LibraryWindow", () => {
  it("lists captures newest first with their tags and thumbnails", async () => {
    mockBackend([shot(1, { tags: ["old"] }), shot(3, { tags: ["bug", "login"] }), shot(2)]);
    render(<LibraryWindow />);

    const cards = await screen.findAllByRole("button", { name: /^Grab-it \d\.png$/ });
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Grab-it 3.png",
      "Grab-it 2.png",
      "Grab-it 1.png",
    ]);
    expect(within(cards[0]).getByText("bug")).toBeInTheDocument();
    expect(within(cards[0]).getByText("login")).toBeInTheDocument();
    expect(within(cards[2]).getByText("old")).toBeInTheDocument();
    expect(screen.getByText("3 captures")).toBeInTheDocument();
    await waitFor(() => expect(cards[0].querySelector("img")).toHaveAttribute("src", "blob:thumb"));
  });

  it("says so when there are no captures", async () => {
    mockBackend([]);
    render(<LibraryWindow />);
    expect(await screen.findByText(/No captures yet/)).toBeInTheDocument();
    expect(screen.getByText("0 captures")).toBeInTheDocument();
  });

  it("edits a capture's tags as chips", async () => {
    const backend = mockBackend([shot(1, { tags: ["old"] })]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    await userEvent.click(screen.getByRole("button", { name: "Remove tag old" }));
    const input = screen.getByLabelText("Tags");
    await userEvent.type(input, " bug, , design {Enter}");

    await waitFor(() => expect(callsTo(backend, "library_set_tags")).toHaveLength(3));
    expect(callsTo(backend, "library_set_tags").map((call) => call.payload)).toEqual([
      { id: 1, tags: [] },
      { id: 1, tags: ["bug"] },
      { id: 1, tags: ["bug", "design"] },
    ]);
    const card = screen.getByRole("button", { name: "Grab-it 1.png" });
    expect(await within(card).findByText("design")).toBeInTheDocument();
    expect(within(card).queryByText("old")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remove tag design" })).toBeInTheDocument();
  });

  it("does not add a tag twice", async () => {
    const backend = mockBackend([shot(1, { tags: ["bug"] })]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    await userEvent.type(screen.getByLabelText("Tags"), "BUG{Enter}");
    expect(callsTo(backend, "library_set_tags")).toHaveLength(0);
  });

  it("groups captures by the day they were taken", async () => {
    mockBackend([
      shot(1, { capturedAt: new Date(2026, 2, 1, 9).getTime() }),
      shot(2, { capturedAt: new Date(2026, 2, 1, 17).getTime() }),
      shot(3, { capturedAt: new Date(2026, 2, 4, 12).getTime() }),
    ]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 3.png" });

    const days = screen.getAllByRole("region").filter((region) => region.classList.contains("day"));
    expect(days).toHaveLength(2);
    expect(within(days[0]).getAllByRole("button", { name: /^Grab-it \d\.png$/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Grab-it 3.png",
    ]);
    expect(within(days[1]).getAllByRole("button", { name: /^Grab-it \d\.png$/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Grab-it 2.png",
      "Grab-it 1.png",
    ]);
  });

  it("copies from a tile's hover actions and says so", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Copy Grab-it 1.png" }));
    await waitFor(() => expect(callsTo(backend, "library_copy")).toHaveLength(1));
    expect(await screen.findByText("Copied to the clipboard")).toBeInTheDocument();
  });

  it("copies the text in a capture from its tile", async () => {
    const backend = mockBackend([shot(1)]);
    backend.ocr[1] = "Invoice 2026-03\nTotal due: $12";
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Copy the text in Grab-it 1.png" }));
    await waitFor(() => expect(callsTo(backend, "library_copy_text")[0]?.payload).toEqual({ id: 1 }));
    expect(await screen.findByText("Copied 2 lines of text")).toBeInTheDocument();
  });

  it("shows the text in a capture in its details, selectable, and copies it", async () => {
    const backend = mockBackend([shot(1)]);
    backend.ocr[1] = "Error 503: upstream timed out";
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    expect(await screen.findByLabelText("Text found in the image")).toHaveTextContent("Error 503: upstream timed out");
    await userEvent.click(screen.getByRole("button", { name: "Copy text" }));
    expect(await screen.findByText("Copied 1 line of text")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy the text" }));
    await waitFor(() => expect(callsTo(backend, "library_copy_text")).toHaveLength(2));
  });

  it("reads a capture OCR has not got to yet when its text is copied", async () => {
    const backend = mockBackend([shot(1)]);
    backend.unread = { 1: "Fresh text" };
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    expect(await screen.findByText("Not read yet. Copy reads it now.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Copy the text" }));
    expect(await screen.findByText("Copied 1 line of text")).toBeInTheDocument();
    expect(backend.ocr[1]).toBe("Fresh text");
  });

  it("says when a capture has no text, and copying it explains why", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    expect(await screen.findByText("No text found in this image.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the text" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Copy the text in Grab-it 1.png" }));
    expect(await screen.findByText("No text found in this capture.")).toBeInTheDocument();
    expect(callsTo(backend, "library_copy_text")).toHaveLength(1);
  });

  it("closes the details with Escape", async () => {
    mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    expect(screen.getByLabelText("Capture details")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("Capture details")).not.toBeInTheDocument();
  });

  it("resizes the details from the keyboard and remembers the width", async () => {
    localStorage.removeItem("grab-it.library.detailsWidth");
    mockBackend([shot(1)]);
    const { unmount } = render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    const details = screen.getByLabelText("Capture details");
    expect(details).toHaveStyle({ width: `${DETAILS_WIDTH.initial}px` });

    const handle = screen.getByRole("separator", { name: "Resize details" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(details).toHaveStyle({ width: `${DETAILS_WIDTH.initial + 16}px` });
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", String(DETAILS_WIDTH.max));
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", String(DETAILS_WIDTH.min));

    unmount();
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    expect(screen.getByLabelText("Capture details")).toHaveStyle({ width: `${DETAILS_WIDTH.min}px` });
  });

  it("keeps the details between their minimum and maximum, leaving the grid room", () => {
    expect(clampDetailsWidth(100)).toBe(DETAILS_WIDTH.min);
    expect(clampDetailsWidth(5000)).toBe(DETAILS_WIDTH.max);
    expect(clampDetailsWidth(450.4)).toBe(450);
    // A 900px body leaves the grid 360px, so the details stop at 540px.
    expect(clampDetailsWidth(600, 900)).toBe(540);
    // Never below the minimum, however narrow the window.
    expect(clampDetailsWidth(600, 500)).toBe(DETAILS_WIDTH.min);
  });

  it("saves notes when the field loses focus", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    await userEvent.type(screen.getByLabelText("Notes"), "Login error on staging");
    fireEvent.blur(screen.getByLabelText("Notes"));

    await waitFor(() =>
      expect(callsTo(backend, "library_set_notes")[0]?.payload).toEqual({ id: 1, notes: "Login error on staging" }),
    );
  });

  it("opens a capture in the editor from the details and by double-click", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    const card = await screen.findByRole("button", { name: "Grab-it 1.png" });

    await userEvent.dblClick(card);
    await userEvent.click(screen.getByRole("button", { name: "Open in editor" }));

    await waitFor(() => expect(callsTo(backend, "library_open")).toHaveLength(2));
    expect(callsTo(backend, "library_open")[0].payload).toEqual({ id: 1 });
  });

  it("opens the tile a double-click started on when the grid moves under the second click", async () => {
    const backend = mockBackend([shot(1), shot(2)]);
    render(<LibraryWindow />);
    const first = await screen.findByRole("button", { name: "Grab-it 1.png" });
    const second = screen.getByRole("button", { name: "Grab-it 2.png" });

    // The first click opens the details; the second lands on the tile that moved under the pointer.
    fireEvent.click(first, { detail: 1 });
    fireEvent.click(second, { detail: 2 });
    fireEvent.doubleClick(second, { detail: 2 });

    await waitFor(() => expect(callsTo(backend, "library_open")).toHaveLength(1));
    expect(callsTo(backend, "library_open")[0].payload).toEqual({ id: 1 });
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(second).toHaveAttribute("aria-pressed", "false");
  });

  it("opens the tile whose Edit button is clicked, not the one clicked before", async () => {
    const backend = mockBackend([shot(1), shot(2)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    await userEvent.click(screen.getByRole("button", { name: "Edit Grab-it 2.png" }));

    await waitFor(() => expect(callsTo(backend, "library_open")).toHaveLength(1));
    expect(callsTo(backend, "library_open")[0].payload).toEqual({ id: 2 });
  });

  it("deletes a capture only after confirmation", async () => {
    const backend = mockBackend([shot(1), shot(2)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 2.png" }));

    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(callsTo(backend, "library_delete")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 2.png" })).not.toBeInTheDocument());
    expect(callsTo(backend, "library_delete")[0].payload).toEqual({ id: 2 });
    expect(screen.getByRole("button", { name: "Grab-it 1.png" })).toBeInTheDocument();
    expect(screen.getByText("1 capture")).toBeInTheDocument();
    expect(screen.queryByLabelText("Capture details")).not.toBeInTheDocument();
  });

  it("can cancel a delete", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete…" })).toBeInTheDocument();
    expect(callsTo(backend, "library_delete")).toHaveLength(0);
  });

  it("loads more captures a page at a time", async () => {
    const many = Array.from({ length: PAGE_SIZE + 5 }, (_, index) => shot(index + 1));
    const backend = mockBackend(many);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: `Grab-it ${PAGE_SIZE + 5}.png` });
    expect(screen.getAllByRole("listitem")).toHaveLength(PAGE_SIZE);

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(PAGE_SIZE + 5));
    expect(callsTo(backend, "library_list")[1].payload).toEqual({ offset: PAGE_SIZE, limit: PAGE_SIZE });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("refreshes when the library changes", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    // Let the event listener finish registering.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    backend.shots = [...backend.shots, shot(2)];
    await act(async () => {
      await emit(LIBRARY_CHANGED_EVENT);
    });

    expect(await screen.findByRole("button", { name: "Grab-it 2.png" })).toBeInTheDocument();
  });

  it("stars a capture Keep forever from its tile, and unstars it", async () => {
    const backend = mockBackend([shot(1), shot(2, { keep: true })]);
    render(<LibraryWindow />);
    const star = await screen.findByRole("button", { name: "Keep Grab-it 1.png forever" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Keep Grab-it 2.png forever" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(star);

    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));
    expect(callsTo(backend, "library_set_keep")[0].payload).toEqual({ id: 1, keep: true });

    await userEvent.click(star);

    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "false"));
    expect(callsTo(backend, "library_set_keep")[1].payload).toEqual({ id: 1, keep: false });
  });

  it("stars a capture Keep forever from its details", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    const details = screen.getByLabelText("Capture details");
    const star = within(details).getByRole("button", { name: "Keep forever" });
    expect(star).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(star);

    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));
    expect(callsTo(backend, "library_set_keep")[0].payload).toEqual({ id: 1, keep: true });
    expect(screen.getByRole("button", { name: "Keep Grab-it 1.png forever" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says what an automatic cleanup removed", async () => {
    mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    // Let the event listener finish registering.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      await emit(LIBRARY_CLEANED_EVENT, { count: 12, bytes: 340 * 1024 * 1024 });
    });

    expect(await screen.findByText("Cleanup removed 12 old items (340 MB)")).toBeInTheDocument();
  });

  it("words the cleanup notice for one item", () => {
    expect(cleanedText({ count: 1, bytes: 4_404_019 })).toBe("Cleanup removed 1 old item (4.2 MB)");
  });

  it("shows backend errors", async () => {
    const backend = mockBackend([shot(1)]);
    backend.fail = "library database error: disk I/O error";
    render(<LibraryWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk I/O error");
  });
});

const GB = 1024 ** 3;

describe("LibraryWindow storage", () => {
  function storageBackend() {
    const backend = mockBackend([
      shot(1, { bytes: 1_000_000 }),
      shot(2, { bytes: 500_000 }),
      recording(3, { bytes: 10_800_000 }),
      recording(4, { kind: "gif", bytes: 2_000_000 }),
    ]);
    backend.disk = { free: 48 * GB, total: 256 * GB };
    return backend;
  }

  it("shows the count and total size in a pill with a ring by type", async () => {
    storageBackend();
    render(<LibraryWindow />);
    const pill = await screen.findByRole("button", { name: /4 captures/ });
    expect(pill).toHaveTextContent("4 captures·14 MB");
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(pill.querySelectorAll(".storage-ring-mini .storage-arc")).toHaveLength(3);
  });

  it("opens the Storage popover with a donut, a legend and the disk", async () => {
    storageBackend();
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: /4 captures/ }));

    const popover = screen.getByRole("dialog", { name: "Storage" });
    const donut = within(popover).getByRole("img", { name: /^Storage by type/ });
    expect(donut).toHaveAccessibleName("Storage by type: Screenshots 1.4 MB, GIFs 1.9 MB, Videos 10 MB");
    expect(donut).toHaveTextContent("14 MB");

    const rows = within(within(popover).getByRole("list", { name: "Storage by type" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Screenshots1.4 MB2 screenshots · 10%",
      "GIFs1.9 MB1 GIF · 14%",
      "Videos10 MB1 video · 76%",
    ]);

    expect(within(popover).getByText("This disk")).toBeInTheDocument();
    expect(within(popover).getByRole("meter", { name: "Grab-it's share of this disk" })).toHaveAttribute(
      "aria-valuetext",
      "14 MB of 256.0 GB, 48.0 GB free",
    );
  });

  it("names a type, its size and its share in a tooltip over its arc", async () => {
    storageBackend();
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: /4 captures/ }));
    const popover = screen.getByRole("dialog", { name: "Storage" });
    const arc = popover.querySelector<SVGElement>('.storage-donut .storage-arc[data-kind="video"]');
    expect(arc).not.toBeNull();

    await userEvent.hover(arc!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Videos · 10 MB1 video · 76% of the library");
    await userEvent.unhover(arc!);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("leaves the disk out when it cannot be read", async () => {
    const backend = storageBackend();
    backend.disk = null;
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: /4 captures/ }));
    const popover = screen.getByRole("dialog", { name: "Storage" });
    expect(within(popover).queryByText("This disk")).not.toBeInTheDocument();
    expect(within(popover).getByRole("list", { name: "Storage by type" })).toBeInTheDocument();
  });

  it("closes the popover with Escape, keeping the details open", async () => {
    storageBackend();
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 2.png" }));
    expect(await screen.findByRole("complementary")).toBeInTheDocument();
    const pill = screen.getByRole("button", { name: /4 captures/ });
    await userEvent.click(pill);
    expect(screen.getByRole("dialog", { name: "Storage" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Storage" })).not.toBeInTheDocument();
    expect(pill).toHaveFocus();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
  });

  it("refreshes the pill and the open popover when the library changes", async () => {
    const backend = mockBackend([shot(1, { bytes: 1_000_000 })]);
    render(<LibraryWindow />);
    const pill = await screen.findByRole("button", { name: /1 capture/ });
    expect(pill).toHaveTextContent("977 KB");
    await userEvent.click(pill);
    // Let the event listener finish registering.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    backend.shots = [...backend.shots, shot(2, { bytes: 2_000_000 })];
    await act(async () => {
      await emit(LIBRARY_CHANGED_EVENT);
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /2 captures/ })).toHaveTextContent("2.9 MB"));
    const popover = screen.getByRole("dialog", { name: "Storage" });
    expect(within(popover).getByText("2 screenshots · 100%")).toBeInTheDocument();
    expect(callsTo(backend, "library_storage").length).toBeGreaterThanOrEqual(2);
  });

  it("shows just the count when sizes cannot be read", async () => {
    const backend = storageBackend();
    backend.storageFails = true;
    render(<LibraryWindow />);
    expect(await screen.findByText("4 captures")).toBeInTheDocument();
    await waitFor(() => expect(callsTo(backend, "library_storage")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /4 captures/ })).not.toBeInTheDocument();
  });

  it("shows the result count instead while searching", async () => {
    storageBackend();
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: /4 captures/ });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search captures" }), "firefox{Enter}");
    expect(await screen.findByText("2 results")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /4 captures/ })).not.toBeInTheDocument();
  });
});

const MB = 1024 ** 2;

describe("LibraryWindow cleanup", () => {
  /** Four items, of which a GIF and a video are older than their Keep settings. */
  function dueBackend() {
    const backend = mockBackend([
      shot(1, { bytes: 1_000_000 }),
      shot(2, { bytes: 500_000 }),
      recording(3, { bytes: 10_800_000 }),
      recording(4, { kind: "gif", bytes: 2_000_000 }),
    ]);
    backend.disk = { free: 48 * GB, total: 256 * GB };
    backend.due = { gif: { count: 1, bytes: 2 * MB }, video: { count: 1, bytes: 10 * MB } };
    return backend;
  }

  async function openPopover() {
    await userEvent.click(await screen.findByRole("button", { name: /4 captures/ }));
    return screen.getByRole("dialog", { name: "Storage" });
  }

  /** Opens the Clean up dialog from the popover. */
  async function openCleanUp() {
    const popover = await openPopover();
    await userEvent.click(within(popover).getByRole("button", { name: "Clean up" }));
    const dialog = screen.getByRole("dialog", { name: "Clean up storage" });
    // It reads what is due afresh before it offers to remove anything.
    await within(dialog).findByText(/older than your Keep settings\.$/);
    return dialog;
  }

  /** Lets event listeners finish registering. */
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("shows what Clean up frees in the popover's footer, and stripes what is due", async () => {
    dueBackend();
    render(<LibraryWindow />);
    const popover = await openPopover();

    expect(within(popover).getByText(/Cleanup frees/)).toHaveTextContent("Cleanup frees 12 MB · 2 items");
    expect(within(popover).getByRole("button", { name: "Clean up" })).toBeEnabled();
    const stripes = popover.querySelectorAll(".storage-donut .storage-arc-due");
    expect([...stripes].map((stripe) => stripe.getAttribute("data-kind"))).toEqual(["gif", "video"]);
    // The stripes do not take the arcs' tooltips.
    expect(stripes[0]).toHaveAttribute("pointer-events", "none");
    const rows = within(within(popover).getByRole("list", { name: "Storage by type" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Screenshots1.4 MB2 screenshots · 10%",
      "GIFs1.9 MB1 GIF · 14% · 2.0 MB due",
      "Videos10 MB1 video · 76% · 10 MB due",
    ]);
  });

  it("offers no Clean up when nothing is older than the Keep settings", async () => {
    const backend = dueBackend();
    backend.due = {};
    render(<LibraryWindow />);
    const popover = await openPopover();
    expect(within(popover).getByText("Nothing is older than your Keep settings")).toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Clean up" })).toBeDisabled();
    expect(popover.querySelector(".storage-arc-due")).toBeNull();
  });

  it("leaves the footer out for a backend that does not say what is due", async () => {
    const backend = dueBackend();
    backend.due = undefined;
    render(<LibraryWindow />);
    const popover = await openPopover();
    expect(within(popover).queryByRole("button", { name: "Clean up" })).not.toBeInTheDocument();
  });

  it("shows an automatic cleanup's progress in the footer, with Stop", async () => {
    const backend = dueBackend();
    render(<LibraryWindow />);
    const popover = await openPopover();
    await settle();

    await act(async () => {
      await emit(CLEANUP_PROGRESS_EVENT, { done: 1, total: 3, bytes: 2 * MB });
    });
    expect(within(popover).getByText("Cleaning up · 1 of 3")).toBeInTheDocument();
    expect(within(popover).getByText("2.0 MB removed")).toBeInTheDocument();
    expect(within(popover).getByRole("progressbar", { name: "Cleanup progress" })).toHaveAttribute("aria-valuenow", "1");
    expect(within(popover).queryByRole("button", { name: "Clean up" })).not.toBeInTheDocument();

    await userEvent.click(within(popover).getByRole("button", { name: "Stop" }));
    expect(callsTo(backend, "library_stop_clean_up")).toHaveLength(1);

    await act(async () => {
      await emit(CLEANUP_DONE_EVENT, { count: 1, bytes: 2 * MB });
    });
    expect(within(popover).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(popover).getByRole("button", { name: "Clean up" })).toBeInTheDocument();
  });

  it("closes the popover and asks how to remove items, Move to Trash first by default", async () => {
    const backend = dueBackend();
    backend.cleanUp = () => ({ count: 2, bytes: 12 * MB });
    render(<LibraryWindow />);
    const dialog = await openCleanUp();

    expect(screen.queryByRole("dialog", { name: "Storage" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("2 items (12 MB) are older than your Keep settings.")).toBeInTheDocument();
    const kinds = within(within(dialog).getByRole("list", { name: "Due for cleanup" })).getAllByRole("listitem");
    expect(kinds.map((row) => row.textContent)).toEqual(["1 GIF2.0 MB", "1 video10 MB"]);
    expect(within(dialog).getByRole("radio", { name: /Move to Trash/ })).toBeChecked();

    await userEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));

    const done = await screen.findByRole("dialog", { name: "Cleanup done" });
    expect(callsTo(backend, "library_clean_up").map((call) => call.payload)).toEqual([
      { removal: "trash", confirmed: { count: 2, bytes: 12 * MB }, retention: null },
    ]);
    expect(within(done).getByText("2 items moved to the Trash · 12 MB")).toBeInTheDocument();
    await userEvent.click(within(done).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cancels without cleaning up", async () => {
    const backend = dueBackend();
    render(<LibraryWindow />);
    const dialog = await openCleanUp();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(callsTo(backend, "library_clean_up")).toHaveLength(0);
  });

  it("pre-selects deleting permanently from Settings and asks again before it", async () => {
    const backend = dueBackend();
    backend.removal = "permanent";
    backend.cleanUp = () => ({ count: 2, bytes: 12 * MB });
    render(<LibraryWindow />);
    const dialog = await openCleanUp();
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /Delete permanently/ })).toBeChecked());

    await userEvent.click(within(dialog).getByRole("button", { name: "Continue…" }));
    const confirm = screen.getByRole("dialog", { name: "Delete 2 items permanently?" });
    expect(
      within(confirm).getByText("12 MB will be deleted from this computer. They won't go to the Trash, and this can't be undone."),
    ).toBeInTheDocument();
    expect(callsTo(backend, "library_clean_up")).toHaveLength(0);

    // Back keeps the choice.
    await userEvent.click(within(confirm).getByRole("button", { name: "Back" }));
    const again = screen.getByRole("dialog", { name: "Clean up storage" });
    expect(within(again).getByRole("radio", { name: /Delete permanently/ })).toBeChecked();
    await userEvent.click(within(again).getByRole("button", { name: "Continue…" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    const done = await screen.findByRole("dialog", { name: "Cleanup done" });
    expect(callsTo(backend, "library_clean_up").map((call) => call.payload)).toEqual([
      { removal: "permanent", confirmed: { count: 2, bytes: 12 * MB }, retention: null },
    ]);
    expect(within(done).getByText("2 items deleted · 12 MB freed")).toBeInTheDocument();
  });

  it("can switch to deleting permanently when Settings says the Trash", async () => {
    const backend = dueBackend();
    backend.removal = "trash";
    render(<LibraryWindow />);
    const dialog = await openCleanUp();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Delete permanently/ }));
    expect(within(dialog).getByRole("button", { name: "Continue…" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Move to Trash/ }));
    expect(within(dialog).getByRole("button", { name: "Move to Trash" })).toBeInTheDocument();
    expect(callsTo(backend, "library_clean_up")).toHaveLength(0);
  });

  it("shows progress while it runs, and stops when asked", async () => {
    const backend = dueBackend();
    let finish: (cleaned: { count: number; bytes: number }) => void = () => {};
    backend.cleanUp = () => new Promise((resolve) => (finish = resolve));
    render(<LibraryWindow />);
    const dialog = await openCleanUp();
    await userEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));

    const running = screen.getByRole("dialog", { name: "Moving to the Trash…" });
    expect(within(running).getByText("0 of 2 items · 0 B of 12 MB")).toBeInTheDocument();
    await settle();
    await act(async () => {
      await emit(CLEANUP_PROGRESS_EVENT, { done: 1, total: 2, bytes: 2 * MB });
    });
    expect(within(running).getByText("1 of 2 items · 2.0 MB of 12 MB")).toBeInTheDocument();
    expect(within(running).getByRole("progressbar", { name: "Cleanup progress" })).toHaveAttribute("aria-valuenow", "1");

    // A running cleanup is not closed by Escape.
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Moving to the Trash…" })).toBeInTheDocument();

    await userEvent.click(within(running).getByRole("button", { name: "Stop" }));
    expect(callsTo(backend, "library_stop_clean_up")).toHaveLength(1);
    expect(within(running).getByRole("button", { name: "Stopping…" })).toBeDisabled();

    await act(async () => {
      finish({ count: 1, bytes: 2 * MB });
      await emit(CLEANUP_DONE_EVENT, { count: 1, bytes: 2 * MB });
    });
    const stopped = await screen.findByRole("dialog", { name: "Stopped" });
    expect(within(stopped).getByText("1 item moved to the Trash · 2.0 MB · 1 left")).toBeInTheDocument();
  });

  it("says why a cleanup could not start", async () => {
    const backend = dueBackend();
    backend.cleanUp = () => Promise.reject("a cleanup is already running");
    render(<LibraryWindow />);
    const dialog = await openCleanUp();
    await userEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("a cleanup is already running");
    expect(screen.getByRole("dialog", { name: "Clean up storage" })).toBeInTheDocument();
  });

  it("shows what is due when the dialog opens, not when the popover first measured", async () => {
    const backend = dueBackend();
    render(<LibraryWindow />);
    const popover = await openPopover();
    expect(within(popover).getByText(/Cleanup frees/)).toHaveTextContent("Cleanup frees 12 MB · 2 items");

    // A shorter Keep setting makes another video due while the popover is open.
    backend.due = { gif: { count: 1, bytes: 2 * MB }, video: { count: 2, bytes: 20 * MB } };
    await userEvent.click(within(popover).getByRole("button", { name: "Clean up" }));
    const dialog = screen.getByRole("dialog", { name: "Clean up storage" });
    expect(await within(dialog).findByText("3 items (22 MB) are older than your Keep settings.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Delete permanently/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue…" }));
    expect(screen.getByRole("dialog", { name: "Delete 3 items permanently?" })).toBeInTheDocument();
  });

  it("measures again when the popover opens", async () => {
    const backend = dueBackend();
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: /4 captures/ });
    backend.due = { video: { count: 1, bytes: 10 * MB } };
    const popover = await openPopover();
    await waitFor(() => expect(within(popover).getByText(/Cleanup frees/)).toHaveTextContent("Cleanup frees 10 MB · 1 item"));
  });

  it("deletes nothing, and asks again, when more became due after confirming", async () => {
    const backend = dueBackend();
    backend.cleanUp = vi.fn(() => ({ count: 2, bytes: 12 * MB }));
    render(<LibraryWindow />);
    const dialog = await openCleanUp();
    await within(dialog).findByText("2 items (12 MB) are older than your Keep settings.");
    await userEvent.click(within(dialog).getByRole("radio", { name: /Delete permanently/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue…" }));
    const confirm = screen.getByRole("dialog", { name: "Delete 2 items permanently?" });

    // Items age past their Keep setting before the user confirms.
    backend.due = { gif: { count: 1, bytes: 2 * MB }, video: { count: 3, bytes: 30 * MB } };
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("More is due now than when you confirmed");
    expect(backend.cleanUp).not.toHaveBeenCalled();
    const again = screen.getByRole("dialog", { name: "Clean up storage" });
    expect(await within(again).findByText("4 items (32 MB) are older than your Keep settings.")).toBeInTheDocument();
    await userEvent.click(within(again).getByRole("button", { name: "Continue…" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await screen.findByRole("dialog", { name: "Cleanup done" });
    expect(callsTo(backend, "library_clean_up").map((call) => call.payload)).toEqual([
      { removal: "permanent", confirmed: { count: 2, bytes: 12 * MB }, retention: null },
      { removal: "permanent", confirmed: { count: 4, bytes: 32 * MB }, retention: null },
    ]);
  });

  it("opens Storage settings from the popover", async () => {
    dueBackend();
    const onOpenSettings = vi.fn();
    render(<LibraryWindow onOpenSettings={onOpenSettings} />);
    const popover = await openPopover();
    await userEvent.click(within(popover).getByRole("button", { name: "Storage settings…" }));
    expect(onOpenSettings).toHaveBeenCalledWith("storage");
    expect(screen.queryByRole("dialog", { name: "Storage" })).not.toBeInTheDocument();
  });

  it("opens the Settings window from the popover on its own", async () => {
    const backend = dueBackend();
    render(<LibraryWindow />);
    const popover = await openPopover();
    await userEvent.click(within(popover).getByRole("button", { name: "Storage settings…" }));
    expect(callsTo(backend, "open_target").map((call) => call.payload)).toEqual([{ target: "settings" }]);
  });
});

/** An MP4 (or, with `kind: "gif"`, a GIF) recording. */
function recording(id: number, overrides: Partial<Shot> = {}): Shot {
  const ext = overrides.kind === "gif" ? "gif" : "mp4";
  return shot(id, {
    kind: "video",
    path: `/home/me/Pictures/Grab-it/recordings/Grab-it ${id}.${ext}`,
    fileName: `Grab-it ${id}.${ext}`,
    thumbPath: `/home/me/Pictures/Grab-it/recordings/thumbs/Grab-it ${id}.png`,
    mode: null,
    app: null,
    windowTitle: null,
    width: 1920,
    height: 1080,
    durationMs: 46_000,
    bytes: 10_800_000,
    ...overrides,
  });
}

describe("LibraryWindow recordings", () => {
  it("shows a recording among the captures with its length, and plays or edits it", async () => {
    const backend = mockBackend([shot(1), recording(2)]);
    render(<LibraryWindow />);
    const card = await screen.findByRole("button", { name: "Grab-it 2.mp4" });
    const tile = card.closest("li")!;
    expect(within(tile).getByText("0:46")).toBeInTheDocument();
    expect(within(tile).getByText(/^Video · /)).toBeInTheDocument();
    // Copying as an image, its text and pinning are for captures.
    expect(within(tile).queryByRole("button", { name: "Copy Grab-it 2.mp4" })).not.toBeInTheDocument();
    expect(within(tile).queryByRole("button", { name: "Pin Grab-it 2.mp4" })).not.toBeInTheDocument();

    await userEvent.click(within(tile).getByRole("button", { name: "Play Grab-it 2.mp4" }));
    await userEvent.click(within(tile).getByRole("button", { name: "Edit Grab-it 2.mp4" }));
    await userEvent.click(within(tile).getByRole("button", { name: "Show Grab-it 2.mp4 in its folder" }));
    await userEvent.dblClick(card);

    await waitFor(() => expect(callsTo(backend, "library_open")).toHaveLength(2));
    expect(callsTo(backend, "library_play")[0].payload).toEqual({ id: 2 });
    expect(callsTo(backend, "library_reveal")[0].payload).toEqual({ id: 2 });
    expect(callsTo(backend, "library_open")[0].payload).toEqual({ id: 2 });
  });

  it("shows a recording's details without the text and AI sections", async () => {
    const backend = mockBackend([recording(2, { tags: ["demo"] })]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 2.mp4" }));

    const details = screen.getByLabelText("Recording details");
    // On the preview and under Length.
    expect(within(details).getAllByText("0:46")).toHaveLength(2);
    expect(within(details).getByText("10.3 MB")).toBeInTheDocument();
    expect(within(details).getByText("1920 × 1080")).toBeInTheDocument();
    expect(within(details).queryByLabelText("Text in image")).not.toBeInTheDocument();
    expect(within(details).queryByLabelText("AI description")).not.toBeInTheDocument();
    expect(within(details).getByText("demo")).toBeInTheDocument();

    await userEvent.click(within(details).getByRole("button", { name: "Open in the recording editor" }));
    await userEvent.click(within(details).getByRole("button", { name: "Play" }));
    await waitFor(() => expect(callsTo(backend, "library_play")).toHaveLength(1));
    expect(callsTo(backend, "library_open")[0].payload).toEqual({ id: 2 });
  });

  it("offers no editor for a GIF, only to play it", async () => {
    mockBackend([recording(3, { kind: "gif", durationMs: null })]);
    render(<LibraryWindow />);
    const card = await screen.findByRole("button", { name: "Grab-it 3.gif" });
    expect(within(card.closest("li")!).getByText(/^GIF · /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Grab-it 3.gif" })).not.toBeInTheDocument();

    await userEvent.click(card);
    const details = screen.getByLabelText("Recording details");
    expect(within(details).queryByRole("button", { name: "Open in the recording editor" })).not.toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Play" })).toHaveClass("btn-primary");
    expect(within(details).queryByText("Length")).not.toBeInTheDocument();
  });

  it("deletes a recording after confirmation", async () => {
    const backend = mockBackend([shot(1), recording(2)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 2.mp4" }));

    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText("Delete this recording and its edits?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 2.mp4" })).not.toBeInTheDocument());
    expect(callsTo(backend, "library_delete")[0].payload).toEqual({ id: 2 });
    expect(screen.getByText("Recording deleted")).toBeInTheDocument();
  });

  it("narrows to recordings or screenshots", async () => {
    const backend = mockBackend([shot(1), recording(2)]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 2.mp4" });

    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.click(screen.getByRole("button", { name: "Filter by type" }));
    await userEvent.click(within(screen.getByRole("listbox", { name: "Filter by type" })).getByRole("option", { name: "Recordings" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 1.png" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Grab-it 2.mp4" })).toBeInTheDocument();
    const searches = callsTo(backend, "library_search").map((call) => (call.payload as { query: SearchQuery }).query);
    expect(searches[searches.length - 1].kind).toBe("recording");
  });

  it("lets the sidebar pick recordings, leaving the type out of the filter menu", async () => {
    const backend = mockBackend([shot(1), recording(2)]);
    render(<LibraryWindow kindFilter="recording" onKindFilter={() => {}} />);
    await screen.findByRole("button", { name: "Grab-it 2.mp4" });
    expect(screen.queryByRole("button", { name: "Grab-it 1.png" })).not.toBeInTheDocument();
    expect(callsTo(backend, "library_search")[0].payload).toMatchObject({ query: { kind: "recording" } });

    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.queryByRole("button", { name: "Filter by type" })).not.toBeInTheDocument();
  });
});

describe("LibraryWindow right-click menu", () => {
  /** Right-clicks the tile for `name` and resolves to its menu. */
  async function openMenu(name: string) {
    const card = await screen.findByRole("button", { name });
    fireEvent.contextMenu(card, { clientX: 120, clientY: 80 });
    return screen.getByRole("menu", { name: `Actions for ${name}` });
  }

  const labels = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.textContent);

  it("offers a capture's actions and runs them from the menu", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    const menu = await openMenu("Grab-it 1.png");
    expect(labels(menu)).toEqual([
      "Open in editor",
      "Open in default app",
      "Copy image",
      "Copy as file",
      "Copy text in image",
      "Pin to screen",
      "Rename…",
      "Duplicate",
      "Export…",
      "Show in file manager",
      "Open containing folder",
      "Copy file path",
      "Add tag",
      "Keep forever",
      "Analyse again",
      "Show details",
      "Move to Trash",
      "Delete permanently…",
    ]);
    expect(within(menu).getByText("Screenshot · 800 × 600 · firefox")).toBeInTheDocument();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Open containing folder" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Copy file path" }));
    expect(await screen.findByText("Copied the file path")).toBeInTheDocument();
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Show in file manager" }));
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Open in default app" }));
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Open in editor" }));

    await waitFor(() => expect(callsTo(backend, "library_open")).toHaveLength(1));
    expect(callsTo(backend, "library_open_folder")[0].payload).toEqual({ id: 1 });
    expect(callsTo(backend, "library_copy_path")[0].payload).toEqual({ id: 1 });
    expect(callsTo(backend, "library_reveal")[0].payload).toEqual({ id: 1 });
    expect(callsTo(backend, "library_open_external")[0].payload).toEqual({ id: 1 });
  });

  it("stars a capture and opens its details", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Keep forever" }));
    await waitFor(() => expect(callsTo(backend, "library_set_keep")[0].payload).toEqual({ id: 1, keep: true }));
    const menu = await openMenu("Grab-it 1.png");
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: "Stop keeping forever" })).toBeInTheDocument());

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Show details" }));
    expect(screen.getByLabelText("Capture details")).toBeInTheDocument();
  });

  it("asks again in place before deleting permanently", async () => {
    const backend = mockBackend([shot(1), shot(2)]);
    render(<LibraryWindow />);
    const menu = await openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently…" }));
    expect(callsTo(backend, "library_delete")).toHaveLength(0);
    // Moving to another entry disarms it.
    await userEvent.hover(within(menu).getByRole("menuitem", { name: "Move to Trash" }));
    expect(within(menu).getByRole("menuitem", { name: "Delete permanently…" })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently…" }));
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Click again to delete for good" }));

    await waitFor(() => expect(callsTo(backend, "library_delete")[0].payload).toEqual({ id: 1 }));
    expect(await screen.findByText("Capture deleted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grab-it 1.png" })).not.toBeInTheDocument();
  });

  it("copies and pins an edited capture with its edits, and offers its original too", async () => {
    const backend = mockBackend([shot(1, { editedAt: 5_000 })]);
    render(<LibraryWindow />);
    let menu = await openMenu("Grab-it 1.png");
    expect(labels(menu)).toContain("Copy original image");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy image" }));
    await waitFor(() => expect(callsTo(backend, "editor_copy")).toHaveLength(1));
    expect(callsTo(backend, "library_annotations")[0].payload).toEqual({ id: 1 });
    expect(callsTo(backend, "library_copy")).toHaveLength(0);

    menu = await openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy original image" }));
    await waitFor(() => expect(callsTo(backend, "library_copy")[0].payload).toEqual({ id: 1 }));
    expect(await screen.findByText("Copied the original image")).toBeInTheDocument();
    expect(callsTo(backend, "editor_copy")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Pin Grab-it 1.png" }));
    await waitFor(() => expect(callsTo(backend, "editor_pin")).toHaveLength(1));
    expect(callsTo(backend, "library_pin")).toHaveLength(0);
  });

  it("offers no Copy original image for a capture without edits and copies it directly", async () => {
    const backend = mockBackend([shot(1, { editedAt: null })]);
    render(<LibraryWindow />);
    const menu = await openMenu("Grab-it 1.png");
    expect(labels(menu)).not.toContain("Copy original image");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy image" }));
    await waitFor(() => expect(callsTo(backend, "library_copy")[0].payload).toEqual({ id: 1 }));
    expect(callsTo(backend, "editor_copy")).toHaveLength(0);
    expect(callsTo(backend, "library_image")).toHaveLength(0);
  });

  it("is driven by the keyboard and closes with Escape, keeping the details open", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    const menu = await openMenu("Grab-it 1.png");
    expect(menu).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(callsTo(backend, "library_copy")[0].payload).toEqual({ id: 1 }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await openMenu("Grab-it 1.png");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Capture details")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grab-it 1.png" })).toHaveFocus();
  });

  it("closes on a click outside it", async () => {
    mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await openMenu("Grab-it 1.png");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers a recording's actions, and no image ones", async () => {
    const backend = mockBackend([recording(2)]);
    render(<LibraryWindow />);
    const menu = await openMenu("Grab-it 2.mp4");
    expect(labels(menu)).toEqual([
      "Play",
      "Edit in recording editor",
      "Copy as file",
      "Rename…",
      "Duplicate",
      "Export…",
      "Show in file manager",
      "Open containing folder",
      "Copy file path",
      "Add tag",
      "Keep forever",
      "Show details",
      "Move to Trash",
      "Delete permanently…",
    ]);
    expect(within(menu).getByText("Video · 0:46 · 10.3 MB")).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Play" }));
    await waitFor(() => expect(callsTo(backend, "library_play")[0].payload).toEqual({ id: 2 }));
  });

  it("offers no editor for a GIF", async () => {
    mockBackend([recording(3, { kind: "gif", durationMs: null })]);
    render(<LibraryWindow />);
    const menu = await openMenu("Grab-it 3.gif");
    expect(within(menu).queryByRole("menuitem", { name: "Edit in recording editor" })).not.toBeInTheDocument();
  });

  it("moves a capture to the Trash without asking again", async () => {
    const backend = mockBackend([shot(1), shot(2)]);
    render(<LibraryWindow />);
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Move to Trash" }));

    await waitFor(() => expect(callsTo(backend, "library_trash")[0].payload).toEqual({ id: 1 }));
    expect(callsTo(backend, "library_delete")).toHaveLength(0);
    expect(await screen.findByText("Capture moved to the Trash")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grab-it 1.png" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grab-it 2.png" })).toBeInTheDocument();
  });

  it("moves a recording to the Trash", async () => {
    const backend = mockBackend([recording(2)]);
    render(<LibraryWindow />);
    await userEvent.click(within(await openMenu("Grab-it 2.mp4")).getByRole("menuitem", { name: "Move to Trash" }));
    await waitFor(() => expect(callsTo(backend, "library_trash")[0].payload).toEqual({ id: 2 }));
    expect(await screen.findByText("Recording moved to the Trash")).toBeInTheDocument();
  });

  it("duplicates a capture and shows the copy", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() => expect(callsTo(backend, "library_duplicate")[0].payload).toEqual({ id: 1 }));
    expect(await screen.findByText("Duplicated as Grab-it 1 copy.png")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Grab-it 1 copy.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grab-it 1.png" })).toBeInTheDocument();
  });

  it("renames a capture in the menu, keeping its extension", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    const menu = await openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Rename…" }));

    const field = within(menu).getByRole("textbox", { name: "New name" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("Grab-it 1");
    expect(within(menu).getByText(".png")).toBeInTheDocument();
    await userEvent.clear(field);
    // Typed letters go to the field, not to the menu's type-ahead or the search box.
    await userEvent.type(field, "Login bug/x{Backspace}{Backspace}{Enter}");

    await waitFor(() =>
      expect(callsTo(backend, "library_rename")[0].payload).toEqual({ id: 1, name: "Login bug" }),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(await screen.findByText("Renamed to Login bug.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Login bug.png" })).toBeInTheDocument();
  });

  it("cancels a rename with Escape, back to the menu", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    const menu = await openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Rename…" }));
    await userEvent.type(within(menu).getByRole("textbox", { name: "New name" }), "Other");
    await userEvent.keyboard("{Escape}");

    expect(within(menu).queryByRole("textbox", { name: "New name" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Rename…" })).toBeInTheDocument();
    expect(screen.getByLabelText("Capture details")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(callsTo(backend, "library_rename")).toHaveLength(0);
  });

  it("keeps the name field open with the reason when a rename is refused", async () => {
    const backend = mockBackend([shot(1), shot(2)]);
    render(<LibraryWindow />);
    const menu = await openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Rename…" }));
    const field = within(menu).getByRole("textbox", { name: "New name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Grab-it 2{Enter}");

    expect(await within(menu).findByRole("alert")).toHaveTextContent("There is already a file called Grab-it 2.png.");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grab-it 1.png" })).toBeInTheDocument();

    // An empty name is not sent.
    await userEvent.clear(field);
    await userEvent.keyboard("{Enter}");
    expect(within(menu).getByRole("alert")).toHaveTextContent("Give it a name.");
    expect(callsTo(backend, "library_rename")).toHaveLength(1);
  });

  it("closes without renaming when the name is unchanged", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    const menu = await openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Rename…" }));
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(callsTo(backend, "library_rename")).toHaveLength(0);
  });

  it("offers Open with… only where the system has an app chooser", async () => {
    const backend = mockBackend([shot(1), recording(2)]);
    backend.openWith = true;
    render(<LibraryWindow />);
    await waitFor(() => expect(callsTo(backend, "library_open_with_supported")).toHaveLength(1));
    const menu = await openMenu("Grab-it 1.png");
    await waitFor(() => expect(labels(menu).slice(0, 3)).toEqual(["Open in editor", "Open in default app", "Open with…"]));
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Open with…" }));
    await waitFor(() => expect(callsTo(backend, "library_open_with")[0].payload).toEqual({ id: 1 }));

    const recordingMenu = await openMenu("Grab-it 2.mp4");
    expect(labels(recordingMenu).slice(0, 3)).toEqual(["Play", "Edit in recording editor", "Open with…"]);
  });

  it("hides Open with… where the system cannot ask", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await waitFor(() => expect(callsTo(backend, "library_open_with_supported")).toHaveLength(1));
    const menu = await openMenu("Grab-it 1.png");
    expect(within(menu).queryByRole("menuitem", { name: "Open with…" })).not.toBeInTheDocument();
  });

  it("copies a capture or a recording as a file", async () => {
    const backend = mockBackend([shot(1), recording(2)]);
    render(<LibraryWindow />);
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Copy as file" }));
    expect(await screen.findByText("Copied as a file")).toBeInTheDocument();
    await userEvent.click(within(await openMenu("Grab-it 2.mp4")).getByRole("menuitem", { name: "Copy as file" }));

    await waitFor(() => expect(callsTo(backend, "library_copy_file")).toHaveLength(2));
    expect(callsTo(backend, "library_copy_file").map((call) => call.payload)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(callsTo(backend, "library_copy")).toHaveLength(0);
  });

  /** Waits for the library's tags, which the Add tag submenu offers. */
  async function tagsLoaded(backend: Backend) {
    await waitFor(() => expect(callsTo(backend, "library_filter_options").length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("checks a capture's tags in the Add tag submenu, the most used others below", async () => {
    const backend = mockBackend([
      shot(1, { tags: ["bug"] }),
      shot(2, { tags: ["login", "ui"] }),
      shot(3, { tags: ["login"] }),
    ]);
    render(<LibraryWindow />);
    await tagsLoaded(backend);
    const menu = await openMenu("Grab-it 1.png");
    const item = within(menu).getByRole("menuitem", { name: "Add tag" });
    await userEvent.click(item);

    expect(item).toHaveAttribute("aria-expanded", "true");
    const submenu = within(menu).getByRole("menu", { name: "Tags" });
    const rows = within(submenu).getAllByRole("menuitemcheckbox");
    expect(rows.map((row) => row.textContent)).toEqual(["bug", "login", "ui"]);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(within(submenu).getByRole("menuitem", { name: "New tag…" })).toBeInTheDocument();

    await userEvent.click(within(submenu).getByRole("menuitemcheckbox", { name: "login" }));
    await waitFor(() =>
      expect(callsTo(backend, "library_set_tags")[0].payload).toEqual({ id: 1, tags: ["bug", "login"] }),
    );
    expect(within(submenu).getByRole("menuitemcheckbox", { name: "login" })).toHaveAttribute("aria-checked", "true");

    // Unchecking keeps the row, so it can be checked again.
    await userEvent.click(within(submenu).getByRole("menuitemcheckbox", { name: "bug" }));
    await waitFor(() => expect(callsTo(backend, "library_set_tags")[1].payload).toEqual({ id: 1, tags: ["login"] }));
    expect(within(submenu).getByRole("menuitemcheckbox", { name: "bug" })).toHaveAttribute("aria-checked", "false");

    // The menu stays open, and the tile shows the new tags.
    expect(screen.getByRole("menu", { name: "Actions for Grab-it 1.png" })).toBeInTheDocument();
    const card = screen.getByRole("button", { name: "Grab-it 1.png" });
    await waitFor(() => expect(within(card).getByText("login")).toBeInTheDocument());
    expect(within(card).queryByText("bug")).not.toBeInTheDocument();
  });

  it("adds a new tag from the Add tag submenu", async () => {
    const backend = mockBackend([shot(1, { tags: ["bug"] }), shot(2, { tags: ["ui"] })]);
    render(<LibraryWindow />);
    await tagsLoaded(backend);
    const menu = await openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add tag" }));
    const submenu = within(menu).getByRole("menu", { name: "Tags" });
    await userEvent.click(within(submenu).getByRole("menuitem", { name: "New tag…" }));

    const field = within(submenu).getByRole("textbox", { name: "New tag" });
    expect(field).toHaveFocus();
    // Typed letters go to the field, not to the submenu's type-ahead.
    await userEvent.type(field, "Release, ui{Enter}");

    await waitFor(() =>
      expect(callsTo(backend, "library_set_tags")[0].payload).toEqual({ id: 1, tags: ["bug", "Release", "ui"] }),
    );
    const rows = within(submenu).getAllByRole("menuitemcheckbox");
    expect(rows.map((row) => row.textContent)).toEqual(["bug", "ui", "Release"]);
    expect(rows.every((row) => row.getAttribute("aria-checked") === "true")).toBe(true);
    expect(within(submenu).queryByRole("textbox", { name: "New tag" })).not.toBeInTheDocument();

    // Escape leaves the field without adding anything.
    await userEvent.click(within(submenu).getByRole("menuitem", { name: "New tag…" }));
    await userEvent.type(within(submenu).getByRole("textbox", { name: "New tag" }), "draft");
    await userEvent.keyboard("{Escape}");
    expect(within(submenu).queryByRole("textbox", { name: "New tag" })).not.toBeInTheDocument();
    expect(callsTo(backend, "library_set_tags")).toHaveLength(1);
  });

  it("drives the Add tag submenu from the keyboard, Escape going back to the menu", async () => {
    const backend = mockBackend([shot(1, { tags: ["bug"] }), shot(2, { tags: ["login"] })]);
    render(<LibraryWindow />);
    await tagsLoaded(backend);
    const menu = await openMenu("Grab-it 1.png");

    // "a" jumps to Add tag; the right arrow opens it on its first row.
    await userEvent.keyboard("a{ArrowRight}");
    const submenu = within(menu).getByRole("menu", { name: "Tags" });
    expect(menu).toHaveAttribute("aria-activedescendant", "shot-menu-tag-0");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() =>
      expect(callsTo(backend, "library_set_tags")[0].payload).toEqual({ id: 1, tags: ["bug", "login"] }),
    );
    expect(within(submenu).getByRole("menuitemcheckbox", { name: "login" })).toHaveAttribute("aria-checked", "true");

    await userEvent.keyboard("{Escape}");
    expect(within(menu).queryByRole("menu", { name: "Tags" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "Actions for Grab-it 1.png" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("says why tags could not be saved and shows what was", async () => {
    const backend = mockBackend([shot(1, { tags: ["bug"] }), shot(2, { tags: ["login"] })]);
    backend.tagsFail = "the library is locked";
    render(<LibraryWindow />);
    await tagsLoaded(backend);
    const menu = await openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add tag" }));
    const submenu = within(menu).getByRole("menu", { name: "Tags" });
    await userEvent.click(within(submenu).getByRole("menuitemcheckbox", { name: "login" }));

    expect(await within(submenu).findByRole("alert")).toHaveTextContent("the library is locked");
    expect(within(submenu).getByRole("menuitemcheckbox", { name: "login" })).toHaveAttribute("aria-checked", "false");
  });

  it("exports a capture through the save dialog, offering PNG, JPG and WebP", async () => {
    const backend = mockBackend([shot(1)]);
    backend.saveAs = "/home/me/Desktop/Login bug.webp";
    render(<LibraryWindow />);
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Export…" }));

    expect(await screen.findByText("Exported to Login bug.webp")).toBeInTheDocument();
    expect(callsTo(backend, "plugin:dialog|save")[0].payload).toMatchObject({
      options: {
        defaultPath: "/home/me/Pictures/Grab-it/Grab-it 1.png",
        filters: [
          { name: "PNG image", extensions: ["png"] },
          { name: "JPEG image", extensions: ["jpg", "jpeg"] },
          { name: "WebP image", extensions: ["webp"] },
        ],
      },
    });
    expect(backend.lastExportFolder).toBe("/home/me/Desktop");
    expect(callsTo(backend, "library_export")[0].payload).toEqual({ id: 1, target: "/home/me/Desktop/Login bug.webp" });
  });

  it("gives an export its extension when the dialog leaves it off", async () => {
    const backend = mockBackend([shot(1)]);
    backend.saveAs = "/home/me/Desktop/Login bug";
    render(<LibraryWindow />);
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Export…" }));

    await waitFor(() =>
      expect(callsTo(backend, "library_export")[0].payload).toEqual({ id: 1, target: "/home/me/Desktop/Login bug.png" }),
    );
  });

  it("exports a recording as a copy of its own kind", async () => {
    const backend = mockBackend([recording(2), recording(3, { kind: "gif" })]);
    backend.saveAs = "/home/me/Desktop/Demo";
    render(<LibraryWindow />);
    await userEvent.click(within(await openMenu("Grab-it 2.mp4")).getByRole("menuitem", { name: "Export…" }));
    await waitFor(() =>
      expect(callsTo(backend, "library_export")[0].payload).toEqual({ id: 2, target: "/home/me/Desktop/Demo.mp4" }),
    );
    expect(callsTo(backend, "plugin:dialog|save")[0].payload).toMatchObject({
      options: { defaultPath: "/home/me/Pictures/Grab-it/Grab-it 2.mp4", filters: [{ name: "MP4 video", extensions: ["mp4"] }] },
    });

    await userEvent.click(within(await openMenu("Grab-it 3.gif")).getByRole("menuitem", { name: "Export…" }));
    await waitFor(() => expect(callsTo(backend, "plugin:dialog|save")).toHaveLength(2));
    expect(callsTo(backend, "plugin:dialog|save")[1].payload).toMatchObject({
      options: { defaultPath: "/home/me/Desktop/Grab-it 3.gif", filters: [{ name: "GIF animation", extensions: ["gif"] }] },
    });
  });

  it("exports nothing when the save dialog is cancelled", async () => {
    const backend = mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(within(await openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Export…" }));
    await waitFor(() => expect(callsTo(backend, "plugin:dialog|save")).toHaveLength(1));
    expect(callsTo(backend, "library_export")).toHaveLength(0);
    expect(screen.queryByText(/Exported to/)).not.toBeInTheDocument();
  });

  it("shows tags set from the menu in the open details", async () => {
    const backend = mockBackend([shot(1, { tags: ["bug"] }), shot(2, { tags: ["login"] })]);
    render(<LibraryWindow />);
    await tagsLoaded(backend);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    const details = screen.getByLabelText("Capture details");
    const menu = await openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add tag" }));
    const submenu = within(menu).getByRole("menu", { name: "Tags" });
    await userEvent.click(within(submenu).getByRole("menuitemcheckbox", { name: "login" }));

    await waitFor(() => expect(within(details).getByRole("button", { name: "Remove tag login" })).toBeInTheDocument());
    expect(within(details).getByRole("button", { name: "Remove tag bug" })).toBeInTheDocument();
  });

  it("leaves out Analyse again while AI descriptions are off", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiStatus = { state: "off", done: 0, total: 0, error: null, provider: "claudeCode", current: null };
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    await waitFor(() => expect(callsTo(backend, "ai_status")).toHaveLength(1));
    const menu = await openMenu("Grab-it 1.png");
    await waitFor(() => expect(within(menu).queryByRole("menuitem", { name: "Analyse again" })).not.toBeInTheDocument());
  });
});

describe("LibraryWindow multi-select", () => {
  const tile = (name: string) => screen.getByRole("button", { name });
  /** The tiles selected, by file name, in the order shown. */
  const selectedTiles = () =>
    [...document.querySelectorAll<HTMLElement>(".tile-main[aria-pressed='true']")].map((item) => item.getAttribute("aria-label"));

  /** Clicks `first` and Shift-clicks `last`, selecting both and every tile between. */
  async function selectRange(first: string, last: string) {
    fireEvent.click(await screen.findByRole("button", { name: first }));
    fireEvent.click(tile(last), { shiftKey: true });
  }

  /** Right-clicks the tile for `name` and resolves to the menu that opens. */
  function openMenu(name: string) {
    fireEvent.contextMenu(tile(name), { clientX: 120, clientY: 80 });
    return screen.getByRole("menu");
  }

  const labels = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.textContent);

  it("toggles with Ctrl or Cmd, selects a range with Shift, and clears with Escape", async () => {
    mockBackend([shot(1), shot(2), shot(3), shot(4), shot(5)]);
    render(<LibraryWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Grab-it 4.png" }));
    expect(selectedTiles()).toEqual(["Grab-it 4.png"]);
    expect(screen.getByLabelText("Capture details")).toBeInTheDocument();

    // Several selected: no details.
    fireEvent.click(tile("Grab-it 2.png"), { ctrlKey: true });
    expect(selectedTiles()).toEqual(["Grab-it 4.png", "Grab-it 2.png"]);
    expect(screen.queryByLabelText("Capture details")).not.toBeInTheDocument();

    // Toggled off again, one is left and its details come back.
    fireEvent.click(tile("Grab-it 2.png"), { metaKey: true });
    expect(selectedTiles()).toEqual(["Grab-it 4.png"]);
    expect(screen.getByLabelText("Capture details")).toBeInTheDocument();

    // Shift selects from the last tile clicked without it, either way; a Ctrl/Cmd-click counts.
    fireEvent.click(tile("Grab-it 4.png"));
    fireEvent.click(tile("Grab-it 1.png"), { shiftKey: true });
    expect(selectedTiles()).toEqual(["Grab-it 4.png", "Grab-it 3.png", "Grab-it 2.png", "Grab-it 1.png"]);
    fireEvent.click(tile("Grab-it 5.png"), { shiftKey: true });
    expect(selectedTiles()).toEqual(["Grab-it 5.png", "Grab-it 4.png"]);
    fireEvent.click(tile("Grab-it 2.png"), { metaKey: true });
    fireEvent.click(tile("Grab-it 1.png"), { shiftKey: true });
    expect(selectedTiles()).toEqual(["Grab-it 2.png", "Grab-it 1.png"]);
    fireEvent.click(tile("Grab-it 4.png"), { shiftKey: true });
    expect(selectedTiles()).toEqual(["Grab-it 4.png", "Grab-it 3.png", "Grab-it 2.png"]);
    expect(screen.queryByLabelText("Capture details")).not.toBeInTheDocument();

    // Ctrl/Cmd+Shift adds a range to what is selected.
    fireEvent.click(tile("Grab-it 5.png"));
    fireEvent.click(tile("Grab-it 4.png"), { shiftKey: true });
    fireEvent.click(tile("Grab-it 1.png"), { ctrlKey: true });
    fireEvent.click(tile("Grab-it 2.png"), { ctrlKey: true, shiftKey: true });
    expect(selectedTiles()).toEqual(["Grab-it 5.png", "Grab-it 4.png", "Grab-it 2.png", "Grab-it 1.png"]);

    await userEvent.keyboard("{Escape}");
    expect(selectedTiles()).toEqual([]);

    // A plain click selects just that tile.
    await selectRange("Grab-it 5.png", "Grab-it 3.png");
    fireEvent.click(tile("Grab-it 1.png"));
    expect(selectedTiles()).toEqual(["Grab-it 1.png"]);
    expect(screen.getByLabelText("Capture details")).toBeInTheDocument();
  });

  it("offers the bulk menu inside a multi-selection, and the usual one outside it", async () => {
    mockBackend([shot(1), recording(2), shot(3), shot(4)]);
    render(<LibraryWindow />);
    await selectRange("Grab-it 3.png", "Grab-it 1.png");
    const menu = openMenu("Grab-it 2.mp4");
    expect(menu).toHaveAccessibleName("Actions for 3 items");
    expect(labels(menu)).toEqual(["Add tag", "Keep forever", "Export to folder…", "Move to Trash", "Delete permanently…"]);
    expect(within(menu).getByText("3 items selected")).toBeInTheDocument();
    expect(within(menu).getByText("2 screenshots · 1 recording")).toBeInTheDocument();

    // Escape closes the menu and keeps the selection.
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(selectedTiles()).toEqual(["Grab-it 3.png", "Grab-it 2.mp4", "Grab-it 1.png"]);

    const single = openMenu("Grab-it 4.png");
    expect(single).toHaveAccessibleName("Actions for Grab-it 4.png");
    expect(labels(single)).toContain("Rename…");
  });

  it("moves every selected item to the Trash", async () => {
    const backend = mockBackend([shot(1), shot(2), shot(3), shot(4)]);
    render(<LibraryWindow />);
    await selectRange("Grab-it 3.png", "Grab-it 1.png");
    await userEvent.click(within(openMenu("Grab-it 2.png")).getByRole("menuitem", { name: "Move to Trash" }));

    expect(await screen.findByText("3 items moved to the Trash")).toBeInTheDocument();
    expect(callsTo(backend, "library_trash").map((call) => call.payload)).toEqual([{ id: 3 }, { id: 2 }, { id: 1 }]);
    expect(screen.queryByRole("button", { name: "Grab-it 1.png" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Grab-it 3.png" })).not.toBeInTheDocument();
    expect(tile("Grab-it 4.png")).toBeInTheDocument();
    expect(selectedTiles()).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("asks again before deleting every selected item permanently", async () => {
    const backend = mockBackend([shot(1), shot(2), shot(3)]);
    render(<LibraryWindow />);
    await selectRange("Grab-it 3.png", "Grab-it 2.png");
    const menu = openMenu("Grab-it 3.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently…" }));
    expect(callsTo(backend, "library_delete")).toHaveLength(0);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Click again to delete 2 for good" }));

    expect(await screen.findByText("2 items deleted")).toBeInTheDocument();
    expect(callsTo(backend, "library_delete").map((call) => call.payload)).toEqual([{ id: 3 }, { id: 2 }]);
    expect(tile("Grab-it 1.png")).toBeInTheDocument();
  });

  it("says in one error how many items could not be moved to the Trash", async () => {
    const backend = mockBackend([shot(1), shot(2), shot(3)]);
    backend.failIds = { library_trash: [2] };
    render(<LibraryWindow />);
    await selectRange("Grab-it 3.png", "Grab-it 1.png");
    await userEvent.click(within(openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Move to Trash" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not move 1 of 3 items to the Trash: could not reach shot 2");
    expect(screen.getByText("2 items moved to the Trash")).toBeInTheDocument();
    // The one that failed stays, still selected.
    expect(tile("Grab-it 2.png")).toBeInTheDocument();
    expect(selectedTiles()).toEqual(["Grab-it 2.png"]);
    expect(screen.queryByRole("button", { name: "Grab-it 1.png" })).not.toBeInTheDocument();
  });

  it("says how many items could not be deleted", async () => {
    const backend = mockBackend([shot(1), shot(2), shot(3)]);
    backend.failIds = { library_delete: [1, 3] };
    render(<LibraryWindow />);
    await selectRange("Grab-it 3.png", "Grab-it 1.png");
    const menu = openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete permanently…" }));
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Click again to delete 3 for good" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not delete 2 of 3 items: could not reach shot 3");
    expect(screen.queryByRole("button", { name: "Grab-it 2.png" })).not.toBeInTheDocument();
  });

  it("keeps every selected item forever, then stops keeping them all", async () => {
    const backend = mockBackend([shot(1, { keep: true }), shot(2), shot(3)]);
    render(<LibraryWindow />);
    await selectRange("Grab-it 3.png", "Grab-it 1.png");
    await userEvent.click(within(openMenu("Grab-it 2.png")).getByRole("menuitem", { name: "Keep forever" }));

    // Only those not kept yet are changed.
    await waitFor(() =>
      expect(callsTo(backend, "library_set_keep").map((call) => call.payload)).toEqual([
        { id: 3, keep: true },
        { id: 2, keep: true },
      ]),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep Grab-it 3.png forever" })).toHaveAttribute("aria-pressed", "true"));

    await userEvent.click(within(openMenu("Grab-it 2.png")).getByRole("menuitem", { name: "Stop keeping forever" }));
    await waitFor(() => expect(callsTo(backend, "library_set_keep")).toHaveLength(5));
    expect(callsTo(backend, "library_set_keep").slice(2).map((call) => call.payload)).toEqual([
      { id: 3, keep: false },
      { id: 2, keep: false },
      { id: 1, keep: false },
    ]);
  });

  it("says how many items could not be kept forever", async () => {
    const backend = mockBackend([shot(1), shot(2), shot(3)]);
    backend.failIds = { library_set_keep: [3] };
    render(<LibraryWindow />);
    await selectRange("Grab-it 3.png", "Grab-it 1.png");
    await userEvent.click(within(openMenu("Grab-it 2.png")).getByRole("menuitem", { name: "Keep forever" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not keep 1 of 3 items forever: could not reach shot 3");
    expect(screen.getByRole("button", { name: "Keep Grab-it 1.png forever" })).toHaveAttribute("aria-pressed", "true");
  });

  it("exports every selected item to one folder", async () => {
    const backend = mockBackend([shot(1), recording(2), shot(3)]);
    backend.openFolder = "/home/me/Desktop/Shots";
    render(<LibraryWindow />);
    await selectRange("Grab-it 3.png", "Grab-it 1.png");
    await userEvent.click(within(openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Export to folder…" }));

    expect(await screen.findByText("Exported 3 items to Shots")).toBeInTheDocument();
    expect(callsTo(backend, "plugin:dialog|open")).toHaveLength(1);
    expect(callsTo(backend, "plugin:dialog|open")[0].payload).toMatchObject({ options: { directory: true } });
    expect(callsTo(backend, "library_export").map((call) => call.payload)).toEqual([
      { id: 3, target: "/home/me/Desktop/Shots" },
      { id: 2, target: "/home/me/Desktop/Shots" },
      { id: 1, target: "/home/me/Desktop/Shots" },
    ]);
    expect(callsTo(backend, "plugin:dialog|save")).toHaveLength(0);
  });

  it("exports nothing when the folder picker is cancelled", async () => {
    const backend = mockBackend([shot(1), shot(2)]);
    render(<LibraryWindow />);
    await selectRange("Grab-it 2.png", "Grab-it 1.png");
    await userEvent.click(within(openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Export to folder…" }));

    await waitFor(() => expect(callsTo(backend, "plugin:dialog|open")).toHaveLength(1));
    expect(callsTo(backend, "library_export")).toHaveLength(0);
    expect(screen.queryByText(/Exported/)).not.toBeInTheDocument();
  });

  it("says how many items could not be exported", async () => {
    const backend = mockBackend([shot(1), shot(2), shot(3)]);
    backend.openFolder = "/home/me/Desktop/Shots";
    backend.failIds = { library_export: [1] };
    render(<LibraryWindow />);
    await selectRange("Grab-it 3.png", "Grab-it 1.png");
    await userEvent.click(within(openMenu("Grab-it 1.png")).getByRole("menuitem", { name: "Export to folder…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not export 1 of 3 items: could not reach shot 1");
    expect(screen.getByText("Exported 2 items to Shots")).toBeInTheDocument();
  });

  /** Waits for the library's tags, which the Add tag submenu offers. */
  async function tagsLoaded(backend: Backend) {
    await waitFor(() => expect(callsTo(backend, "library_filter_options").length).toBeGreaterThan(0));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const tagsOf = (backend: Backend, id: number) => backend.shots.find((item) => item.id === id)?.tags;

  it("adds a tag to every selected item, and takes it off them all", async () => {
    const backend = mockBackend([shot(1, { tags: ["bug"] }), shot(2, { tags: ["bug", "ui"] }), shot(3), shot(4, { tags: ["docs"] })]);
    render(<LibraryWindow />);
    await tagsLoaded(backend);
    await selectRange("Grab-it 3.png", "Grab-it 1.png");
    const menu = openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add tag" }));
    const submenu = within(menu).getByRole("menu", { name: "Tags" });

    // Tags on some of them are mixed, those on the most first; others are offered below.
    const rows = within(submenu).getAllByRole("menuitemcheckbox");
    expect(rows.map((row) => row.textContent)).toEqual(["bug", "ui", "docs"]);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual(["mixed", "mixed", "false"]);

    await userEvent.click(within(submenu).getByRole("menuitemcheckbox", { name: "bug" }));
    await waitFor(() => expect(within(submenu).getByRole("menuitemcheckbox", { name: "bug" })).toHaveAttribute("aria-checked", "true"));
    // Only the one without it is saved.
    await waitFor(() => expect(callsTo(backend, "library_set_tags").map((call) => call.payload)).toEqual([{ id: 3, tags: ["bug"] }]));

    await userEvent.click(within(submenu).getByRole("menuitemcheckbox", { name: "bug" }));
    await waitFor(() => expect(callsTo(backend, "library_set_tags")).toHaveLength(4));
    expect(tagsOf(backend, 1)).toEqual([]);
    expect(tagsOf(backend, 2)).toEqual(["ui"]);
    expect(tagsOf(backend, 3)).toEqual([]);
    expect(within(submenu).getByRole("menuitemcheckbox", { name: "bug" })).toHaveAttribute("aria-checked", "false");

    // A new tag goes on them all.
    await userEvent.click(within(submenu).getByRole("menuitem", { name: "New tag…" }));
    await userEvent.type(within(submenu).getByRole("textbox", { name: "New tag" }), "Release{Enter}");
    // Saved in the order shown, the last one last.
    await waitFor(() => expect(tagsOf(backend, 1)).toEqual(["Release"]));
    expect(tagsOf(backend, 3)).toEqual(["Release"]);
    expect(tagsOf(backend, 2)).toEqual(["ui", "Release"]);
    expect(tagsOf(backend, 4)).toEqual(["docs"]);
    expect(within(submenu).getByRole("menuitemcheckbox", { name: "Release" })).toHaveAttribute("aria-checked", "true");
  });

  it("says in the submenu how many items could not be tagged", async () => {
    const backend = mockBackend([shot(1), shot(2), shot(3, { tags: ["bug"] })]);
    backend.failIds = { library_set_tags: [2] };
    render(<LibraryWindow />);
    await tagsLoaded(backend);
    await selectRange("Grab-it 2.png", "Grab-it 1.png");
    const menu = openMenu("Grab-it 1.png");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add tag" }));
    const submenu = within(menu).getByRole("menu", { name: "Tags" });
    await userEvent.click(within(submenu).getByRole("menuitemcheckbox", { name: "bug" }));

    expect(await within(submenu).findByRole("alert")).toHaveTextContent("Could not tag 1 of 2 items: could not reach shot 2");
    expect(tagsOf(backend, 1)).toEqual(["bug"]);
    expect(within(submenu).getByRole("menuitemcheckbox", { name: "bug" })).toHaveAttribute("aria-checked", "mixed");
  });
});

describe("LibraryWindow search", () => {
  const searchesOf = (backend: Backend) =>
    callsTo(backend, "library_search").map((call) => (call.payload as { query: SearchQuery }).query);

  it("finds a capture by a word only OCR saw, once typing pauses, and highlights it", async () => {
    const backend = mockBackend([shot(1), shot(2, { app: "code", windowTitle: "main.rs" })]);
    backend.ocr[1] = "Order pineapple today";
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 2.png" });

    await userEvent.type(screen.getByRole("searchbox", { name: "Search captures" }), "pinea");

    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 2.png" })).not.toBeInTheDocument());
    const card = screen.getByRole("button", { name: "Grab-it 1.png" });
    expect(within(card).getByText("Text in image:", { exact: false })).toBeInTheDocument();
    const mark = card.querySelector("mark");
    expect(mark).toHaveTextContent("pineapple");
    expect(screen.getByText("1 result")).toBeInTheDocument();
    // Debounced: no search for the partly typed word.
    expect(searchesOf(backend).map((query) => query.text)).toEqual(["pinea"]);
  });

  it("says when nothing matches and clears back to every capture", async () => {
    const backend = mockBackend([shot(1), shot(2)]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });

    await userEvent.type(screen.getByRole("searchbox", { name: "Search captures" }), "zebra{Enter}");
    expect(await screen.findByText(/No captures match/)).toBeInTheDocument();
    expect(screen.getByText("0 results")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByRole("button", { name: "Grab-it 2.png" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search captures" })).toHaveValue("");
    expect(screen.getByText("2 captures")).toBeInTheDocument();
    expect(callsTo(backend, "library_list").length).toBeGreaterThan(1);
  });

  it("filters by the date pills", async () => {
    const now = Date.now();
    mockBackend([shot(1, { capturedAt: now }), shot(2, { capturedAt: now - 40 * 86_400_000 })]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 2.png" });
    expect(screen.getByRole("button", { name: "Any time" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 2.png" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Grab-it 1.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true");
    // The date menu stays idle: the time switch already says which dates are shown.
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("button", { name: "Filter by date" })).toHaveTextContent("Any dates");
    expect(screen.getByRole("button", { name: "Filters" })).not.toHaveTextContent("1");
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));

    await userEvent.click(screen.getByRole("button", { name: "Any time" }));
    expect(await screen.findByRole("button", { name: "Grab-it 2.png" })).toBeInTheDocument();
  });

  it("filters by app, tag and date", async () => {
    const backend = mockBackend([
      shot(1, { tags: ["receipts"], capturedAt: new Date(2026, 2, 1, 12).getTime() }),
      shot(2, { app: "code", tags: ["Work"], capturedAt: new Date(2026, 2, 5, 12).getTime() }),
      shot(3, { capturedAt: new Date(2026, 2, 9, 12).getTime() }),
    ]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 3.png" });
    await waitFor(() => expect(callsTo(backend, "library_filter_options").length).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.click(screen.getByRole("button", { name: "Filter by app" }));
    const apps = screen.getByRole("listbox", { name: "Filter by app" });
    expect(within(apps).getByRole("option", { name: "code" })).toBeInTheDocument();
    await userEvent.click(within(apps).getByRole("option", { name: "firefox" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 2.png" })).not.toBeInTheDocument());
    expect(screen.getByText("2 results")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter by app" })).toHaveTextContent("firefox");

    await userEvent.click(screen.getByRole("button", { name: "Filter by tag" }));
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 3.png" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Grab-it 1.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter by tag" })).toHaveTextContent("receipts");
    expect(screen.getByRole("button", { name: "Filters" })).toHaveTextContent("2");

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.click(screen.getByRole("button", { name: "Filter by date" }));
    fireEvent.change(screen.getByLabelText("Captured from"), { target: { value: "2026-03-05" } });
    fireEvent.change(screen.getByLabelText("Captured to"), { target: { value: "2026-03-05" } });
    await waitFor(() => expect(screen.getByText("1 result")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Grab-it 2.png" })).toBeInTheDocument();

    const last = searchesOf(backend)[searchesOf(backend).length - 1];
    expect(last).toEqual({
      text: "",
      app: null,
      tag: null,
      from: new Date(2026, 2, 5).getTime(),
      to: new Date(2026, 2, 6).getTime(),
    });
  });

  it("shows the OCR queue while it reads captures", async () => {
    const backend = mockBackend([shot(1)]);
    backend.ocrStatus = { state: "working", pending: 1 };
    render(<LibraryWindow />);

    expect(await screen.findByText("Reading text in 1 capture…")).toBeInTheDocument();
    // Let the event listener finish registering.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      await emit(OCR_STATUS_EVENT, { state: "working", pending: 3 });
    });
    expect(screen.getByText("Reading text in 3 captures…")).toBeInTheDocument();

    await act(async () => {
      await emit(OCR_STATUS_EVENT, { state: "idle" });
    });
    expect(screen.queryByText(/Reading text/)).not.toBeInTheDocument();
  });

  it("says to reinstall when the bundled models cannot be loaded", async () => {
    const backend = mockBackend([shot(1)]);
    backend.ocrStatus = {
      state: "failed",
      message: "could not load the text recognition models: text-detection.onnx: not found",
    };
    render(<LibraryWindow />);

    expect(await screen.findByText(/text-detection.onnx: not found/)).toBeInTheDocument();
    expect(screen.getByText(/Reinstall it to restore them/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});

describe("LibraryWindow AI descriptions", () => {
  const searchesOf = (backend: Backend) =>
    callsTo(backend, "library_search").map((call) => (call.payload as { query: SearchQuery }).query);
  const described = (id: number, overrides: Partial<Shot> = {}) =>
    shot(id, {
      aiDescription: "A Rust compiler error about a borrowed value in main.rs, shown in VS Code",
      aiCategory: "error",
      aiTags: ["rust", "compiler"],
      ...overrides,
    });
  /** Lets the event listeners finish registering. */
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it("shows AI tags on cards and leaves the description to the details", async () => {
    mockBackend([described(1), shot(2)]);
    render(<LibraryWindow />);

    const card = await screen.findByRole("button", { name: "Grab-it 1.png" });
    // AI tags show on the card like the user's own.
    expect(within(card).getByText("rust")).toHaveClass("tag");
    expect(within(card).queryByText(/A Rust compiler error/)).not.toBeInTheDocument();
    expect(within(card).queryByText("Error / dialog")).not.toBeInTheDocument();

    await userEvent.click(card);
    const details = screen.getByRole("complementary", { name: "Capture details" });
    expect(within(details).getByText(/A Rust compiler error/)).toBeInTheDocument();
    expect(within(details).getByText("Error / dialog")).toHaveClass("category-chip");
  });

  it("highlights a match in the description as the snippet", async () => {
    const backend = mockBackend([described(1), shot(2)]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 2.png" });

    await userEvent.type(screen.getByRole("searchbox", { name: "Search captures" }), "borrow{Enter}");

    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 2.png" })).not.toBeInTheDocument());
    const card = screen.getByRole("button", { name: "Grab-it 1.png" });
    expect(within(card).getByText("Description:", { exact: false })).toBeInTheDocument();
    expect(card.querySelector("mark")).toHaveTextContent("borrowed");
    // Shown once: as the snippet, not also as the plain line.
    expect(card.querySelector(".shot-description")).toBeNull();
    expect(searchesOf(backend).pop()?.text).toBe("borrow");
  });

  it("filters by category with friendly names", async () => {
    const backend = mockBackend([described(1), described(2, { aiCategory: "receipt" }), shot(3)]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 3.png" });
    await waitFor(() => expect(callsTo(backend, "library_filter_options").length).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    const chip = screen.getByRole("button", { name: "Filter by category" });
    expect(chip).toHaveTextContent("All categories");
    await userEvent.click(chip);
    const list = screen.getByRole("listbox", { name: "Filter by category" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "All categories",
      "Error / dialog",
      "Receipt",
    ]);

    await userEvent.click(within(list).getByRole("option", { name: "Error / dialog" }));

    await waitFor(() => expect(screen.getByText("1 result")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Grab-it 1.png" })).toBeInTheDocument();
    expect(searchesOf(backend).pop()).toEqual({ text: "", from: null, to: null, app: null, tag: null, category: "error" });

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByText("3 captures")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("button", { name: "Filter by category" })).toHaveTextContent("All categories");
  });

  it("shows AI tags with the user's tags, each removable", async () => {
    mockBackend([described(1, { tags: ["work"] })]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    const details = screen.getByRole("complementary", { name: "Capture details" });
    const ai = within(details).getByRole("region", { name: "AI description" });
    expect(within(ai).getByText(/A Rust compiler error about a borrowed value/)).toBeInTheDocument();
    expect(within(details).getByText("Error / dialog")).toBeInTheDocument();
    expect(within(ai).queryByText("rust")).not.toBeInTheDocument();

    expect(within(details).getByRole("button", { name: "Remove tag work" })).toBeInTheDocument();
    expect(within(details).getByText("rust")).toHaveClass("tag", "tag-ai");
    expect(within(details).getByText("compiler")).toHaveAttribute("title", "Added by AI");

    await userEvent.click(within(details).getByRole("button", { name: "Remove AI tag rust" }));
    await waitFor(() => expect(within(details).queryByText("rust")).not.toBeInTheDocument());
    expect(within(details).getByText("compiler")).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Remove tag work" })).toBeInTheDocument();
  });

  it("re-describes a capture and clears its AI description", async () => {
    const backend = mockBackend([described(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    await userEvent.click(screen.getByRole("button", { name: "Analyse again" }));
    await waitFor(() => expect(callsTo(backend, "ai_redescribe")).toHaveLength(1));
    expect(callsTo(backend, "ai_redescribe")[0].payload).toEqual({ id: 1 });
    expect(await screen.findByText(/Analysing again/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear AI description" }));
    await waitFor(() => expect(callsTo(backend, "ai_clear")[0]?.payload).toEqual({ id: 1 }));
    expect(await screen.findByText("Not described yet.")).toBeInTheDocument();
    const card = screen.getByRole("button", { name: "Grab-it 1.png" });
    expect(within(card).queryByText(/A Rust compiler error/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear AI description" })).toBeDisabled();
  });

  it("says to turn AI on when it is off", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiStatus = { state: "off", done: 0, total: 0, error: null, provider: "claudeCode", current: null };
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    expect(await screen.findByText(/Turn on AI descriptions in Settings/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyse again" })).toBeDisabled();
    expect(screen.queryByText(/Analysing/)).not.toBeInTheDocument();
  });

  it("shows progress from the status event, then the error with a hint", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiStatus = { state: "working", done: 2, total: 40, error: null, provider: "claudeCode", current: null };
    render(<LibraryWindow />);

    expect(await screen.findByText("Analysing 3 of 40…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Descriptions" })).toHaveAttribute("value", "2");
    await settle();

    await act(async () => {
      await emit(AI_STATUS_EVENT, { state: "working", done: 9, total: 40, error: null });
    });
    expect(screen.getByText("Analysing 10 of 40…")).toBeInTheDocument();

    await act(async () => {
      await emit(AI_STATUS_EVENT, {
        state: "error",
        done: 9,
        total: 40,
        error: "could not reach http://localhost:11434/v1",
      });
    });
    expect(screen.queryByText(/Analysing \d+ of/)).not.toBeInTheDocument();
    expect(screen.getByText(/Could not describe captures: could not reach/)).toBeInTheDocument();
    expect(screen.getByText(/Is the AI endpoint running\?/)).toBeInTheDocument();
    expect(screen.queryByText(/Ollama/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    await waitFor(() => expect(callsTo(backend, "open_target")[0]?.payload).toEqual({ target: "settings" }));

    await act(async () => {
      await emit(AI_STATUS_EVENT, { state: "idle", done: 0, total: 0, error: null });
    });
    expect(screen.queryByText(/Could not describe/)).not.toBeInTheDocument();
  });

  it("names Claude Code in the error hint when it describes captures", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiStatus = {
      state: "error",
      done: 0,
      total: 1,
      error: "Claude Code failed: Not logged in · Please run /login",
      provider: "claudeCode",
      current: null,
    };
    render(<LibraryWindow />);
    expect(await screen.findByText(/Could not describe captures: Claude Code failed/)).toBeInTheDocument();
    expect(screen.getByText(/Is Claude Code installed and signed in\?/)).toBeInTheDocument();
  });

  it("says once that Claude Code now describes captures, until dismissed", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiNotice = true;
    const { unmount } = render(<LibraryWindow />);
    expect(await screen.findByText(/Claude Code now describes your new captures/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss AI notice" }));

    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();
    await waitFor(() => expect(callsTo(backend, "dismiss_ai_notice")).toHaveLength(1));
    unmount();

    // The next time the Library opens it is gone.
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    await settle();
    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();
  });

  it("opens Settings from the notice, which dismisses it", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiNotice = true;
    render(<LibraryWindow />);
    await screen.findByText(/Claude Code now describes your new captures/);

    await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));

    await waitFor(() => expect(callsTo(backend, "open_target")[0]?.payload).toEqual({ target: "settings" }));
    expect(callsTo(backend, "dismiss_ai_notice")).toHaveLength(1);
    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();
  });

  it.each([
    ["turned off", { aiEnabled: false }],
    ["switched to an endpoint", { aiEnabled: true, aiProvider: "endpoint" as const }],
  ])("shows no notice once describing was %s in Settings", async (_, change) => {
    const backend = mockBackend([shot(1)]);
    backend.aiNotice = true;
    Object.assign(backend, change);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    await settle();
    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();
  });

  it("shows the notice when Grab-it turns AI on after the Library opened", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiStatus = { state: "off", done: 0, total: 0, error: null, provider: "claudeCode", current: null };
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    await settle();
    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();

    backend.aiNotice = true;
    await act(async () => {
      await emit(AI_STATUS_EVENT, { state: "idle", done: 0, total: 0, error: null, provider: "claudeCode", current: null });
    });
    expect(await screen.findByText(/Claude Code now describes your new captures/)).toBeInTheDocument();
  });

  it("names Codex in the error hint when it describes captures", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiStatus = {
      state: "error",
      done: 0,
      total: 1,
      error: "Codex failed: Not logged in. Run `codex login`.",
      provider: "codex",
      current: null,
    };
    render(<LibraryWindow />);
    expect(await screen.findByText(/Could not describe captures: Codex failed/)).toBeInTheDocument();
    expect(screen.getByText(/Is Codex installed and signed in\? Run codex in a terminal/)).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code/)).not.toBeInTheDocument();
  });

  it("names Codex in the notice when Grab-it turned AI on with it", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiNotice = true;
    backend.aiProvider = "codex";
    render(<LibraryWindow />);
    expect(await screen.findByText(/Codex now describes your new captures/)).toBeInTheDocument();
    expect(screen.getByText(/go to OpenAI under your ChatGPT or OpenAI account/)).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();
  });

  it("invites a new user to set up AI integration, opening its settings", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiNotice = true;
    backend.aiEnabled = false;
    backend.aiProvider = null;
    const onOpenSettings = vi.fn();
    render(<LibraryWindow onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/Set up AI integration to search captures by what they show/)).toBeInTheDocument();
    expect(screen.getByText(/It stays off until you choose a provider/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Choose a provider" }));

    expect(onOpenSettings).toHaveBeenCalledWith("ai");
    await waitFor(() => expect(callsTo(backend, "dismiss_ai_notice")).toHaveLength(1));
    expect(screen.queryByText(/Set up AI integration/)).not.toBeInTheDocument();
  });

  it("remembers a dismissed invitation", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiNotice = true;
    backend.aiEnabled = false;
    backend.aiProvider = null;
    const { unmount } = render(<LibraryWindow />);
    await screen.findByText(/Set up AI integration/);

    await userEvent.click(screen.getByRole("button", { name: "Dismiss AI notice" }));

    expect(screen.queryByText(/Set up AI integration/)).not.toBeInTheDocument();
    await waitFor(() => expect(callsTo(backend, "dismiss_ai_notice")).toHaveLength(1));
    unmount();
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    await settle();
    expect(screen.queryByText(/Set up AI integration/)).not.toBeInTheDocument();
  });

  it("opens Settings from the invitation in its own window", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiNotice = true;
    backend.aiEnabled = false;
    backend.aiProvider = null;
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Choose a provider" }));
    await waitFor(() => expect(callsTo(backend, "open_target")[0]?.payload).toEqual({ target: "settings" }));
  });

  it("drops the Claude Code notice once describing is off but the provider is still on", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiNotice = true;
    backend.aiEnabled = true;
    backend.aiAutomatic = false;
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    await settle();
    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Set up AI integration/)).not.toBeInTheDocument();
  });

  it("does not invite a user who already chose a provider and turned it off", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiNotice = true;
    backend.aiEnabled = false;
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    await settle();
    expect(screen.queryByText(/Set up AI integration/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();
  });

  it("marks the capture being analysed and those queued, and cancels the run", async () => {
    const backend = mockBackend([shot(1), shot(2, { aiWaiting: true }), shot(3)]);
    backend.aiStatus = { state: "working", done: 0, total: 2, error: null, provider: "claudeCode", current: 1 };
    render(<LibraryWindow />);

    const working = await screen.findByRole("button", { name: "Grab-it 1.png" });
    expect(await within(working).findByText("Analysing…")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "Grab-it 2.png" })).getByText("Queued")).toBeInTheDocument();
    const idle = screen.getByRole("button", { name: "Grab-it 3.png" });
    expect(within(idle).queryByText(/Queued|Analysing/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(callsTo(backend, "ai_cancel")).toHaveLength(1));
    await act(async () => {
      await emit(AI_STATUS_EVENT, { state: "idle", done: 0, total: 0, error: null, provider: "claudeCode", current: null });
    });
    expect(screen.queryByText(/Analysing/)).not.toBeInTheDocument();
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
  });

  it("shows no notice when Grab-it did not turn AI on", async () => {
    mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    await settle();
    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();
  });

  it("reloads when a run finishes, to show the new descriptions", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiStatus = { state: "working", done: 0, total: 1, error: null, provider: "claudeCode", current: null };
    render(<LibraryWindow />);
    expect(await screen.findByText("Analysing 1 of 1…")).toBeInTheDocument();
    await settle();

    backend.shots = [described(1)];
    await act(async () => {
      await emit(AI_STATUS_EVENT, { state: "idle", done: 1, total: 1, error: null });
    });

    const card = screen.getByRole("button", { name: "Grab-it 1.png" });
    expect(await within(card).findByText("rust")).toBeInTheDocument();
    expect(screen.queryByText(/Analysing/)).not.toBeInTheDocument();
  });

  it("names categories", () => {
    expect(categoryLabel("error")).toBe("Error / dialog");
    expect(categoryLabel("browser")).toBe("Browser / web page");
    expect(categoryLabel("spreadsheet")).toBe("Spreadsheet");
  });
});

describe("search queries", () => {
  it("turns typed words and filters into a query", () => {
    expect(buildQuery("  invoice ", NO_FILTERS)).toEqual({ text: "invoice", from: null, to: null, app: null, tag: null });
    expect(isSearching(buildQuery(" ", NO_FILTERS))).toBe(false);
    const query = buildQuery("", {
      app: "code",
      tag: "bug",
      category: "",
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    expect(query).toEqual({
      text: "",
      app: "code",
      tag: "bug",
      from: new Date(2026, 2, 1).getTime(),
      to: new Date(2026, 3, 1).getTime(),
    });
    expect(isSearching(query)).toBe(true);
  });

  it("reads date inputs as local days", () => {
    expect(dayStart("")).toBeNull();
    expect(dayStart("March 1")).toBeNull();
    expect(dayStart("2026-12-31", 1)).toBe(new Date(2027, 0, 1).getTime());
  });
});

describe("dates", () => {
  const now = new Date(2026, 10, 14, 15).getTime();

  it("names recent days relatively and older ones by date", () => {
    expect(dayLabel(new Date(2026, 10, 14).getTime(), now).title).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 13).getTime(), now).title).toBe("Yesterday");
    const older = dayLabel(new Date(2026, 9, 1).getTime(), now);
    expect(older.subtitle).toBeNull();
    expect(older.title).toContain("1");
    expect(dayLabel(new Date(2025, 9, 1).getTime(), now).title).toContain("2025");
  });

  it("groups newest-first shots into local days", () => {
    const groups = groupByDay([
      { capturedAt: new Date(2026, 10, 14, 23).getTime() },
      { capturedAt: new Date(2026, 10, 14, 0, 5).getTime() },
      { capturedAt: new Date(2026, 10, 13, 23, 59).getTime() },
    ]);
    expect(groups.map((group) => group.items.length)).toEqual([2, 1]);
    expect(groups[0].day).toBe(new Date(2026, 10, 14).getTime());
  });

  it("labels the date filter with its preset or range", () => {
    expect(dateFilterLabel("", "", now)).toBeNull();
    expect(dateFilterLabel("2026-11-14", "2026-11-14", now)).toBe("Today");
    expect(dateFilterLabel("2026-11-08", "2026-11-14", now)).toBe("Past 7 days");
    expect(dateFilterLabel("2026-03-01", "2026-03-05", now)).toMatch(/–/);
  });
});

describe("parseTags", () => {
  it("splits on commas and drops empty tags", () => {
    expect(parseTags(" bug, ,design ,")).toEqual(["bug", "design"]);
    expect(parseTags("")).toEqual([]);
  });
});
