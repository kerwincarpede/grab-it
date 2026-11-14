import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LibraryWindow from "./LibraryWindow";
import { resetThumbnails } from "./thumbnails";
import {
  AI_STATUS_EVENT,
  LIBRARY_CHANGED_EVENT,
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
    ...overrides,
  };
}

interface Backend {
  shots: Shot[];
  calls: { cmd: string; payload?: InvokeArgs }[];
  fail?: string;
  /** Text OCR found, by shot id. */
  ocr: Record<number, string>;
  ocrStatus: OcrStatus;
  aiStatus: AiStatus;
  /** Grab-it turned AI descriptions on and the Library has not said so yet. */
  aiNotice: boolean;
  /** Whether describing is on now; the notice's own flag when unset. */
  aiEnabled?: boolean;
  /** The provider now; Claude Code when unset. */
  aiProvider?: "claudeCode" | "endpoint" | null;
}

/** A small stand-in for `Library::search`: every word must start a word in some field. */
function search(backend: Backend, query: SearchQuery): SearchHit[] {
  const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  for (const item of [...backend.shots].sort((a, b) => b.capturedAt - a.capturedAt)) {
    if (query.app && item.app !== query.app) continue;
    if (query.tag && ![...item.tags, ...item.aiTags].some((tag) => tag.toLowerCase() === query.tag?.toLowerCase()))
      continue;
    if (query.category && item.aiCategory !== query.category) continue;
    if (query.from !== null && item.capturedAt < query.from) continue;
    if (query.to !== null && item.capturedAt >= query.to) continue;
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
    aiStatus: { state: "idle", done: 0, total: 0, error: null },
    aiNotice: false,
  };
  const find = (id: number) => {
    const found = backend.shots.find((item) => item.id === id);
    if (!found) throw `no capture with id ${id}`;
    return found;
  };
  mockIPC(
    (cmd, payload) => {
      backend.calls.push({ cmd, payload });
      const args = payload as Record<string, unknown>;
      if (backend.fail) throw backend.fail;
      switch (cmd) {
        case "library_list": {
          const { offset, limit } = args as { offset: number; limit: number };
          const sorted = [...backend.shots].sort((a, b) => b.capturedAt - a.capturedAt);
          return { shots: sorted.slice(offset, offset + limit), offset, total: sorted.length };
        }
        case "library_thumbnail":
          return new Uint8Array([137, 80, 78, 71]).buffer;
        case "library_set_tags": {
          const updated = { ...find(args.id as number), tags: args.tags as string[] };
          backend.shots = backend.shots.map((item) => (item.id === updated.id ? updated : item));
          return updated;
        }
        case "library_set_notes": {
          const updated = { ...find(args.id as number), notes: args.notes as string };
          backend.shots = backend.shots.map((item) => (item.id === updated.id ? updated : item));
          return updated;
        }
        case "library_delete":
          find(args.id as number);
          backend.shots = backend.shots.filter((item) => item.id !== args.id);
          return null;
        case "library_open":
        case "library_copy":
        case "library_pin":
          find(args.id as number);
          return null;
        case "library_search": {
          const { query, offset, limit } = args as { query: SearchQuery; offset: number; limit: number };
          const hits = search(backend, query);
          return { hits: hits.slice(offset, offset + limit), offset, total: hits.length };
        }
        case "library_filter_options":
          return {
            apps: [...new Set(backend.shots.map((item) => item.app).filter((app): app is string => !!app))].sort(),
            tags: [...new Set(backend.shots.flatMap((item) => [...item.tags, ...item.aiTags]))].sort(),
            categories: [
              ...new Set(backend.shots.map((item) => item.aiCategory).filter((found): found is string => !!found)),
            ].sort(),
          };
        case "ocr_status":
          return backend.ocrStatus;
        case "ocr_retry":
          return null;
        case "ai_status":
          return backend.aiStatus;
        case "ai_redescribe":
          find(args.id as number);
          return null;
        case "ai_clear": {
          const updated = { ...find(args.id as number), aiDescription: null, aiCategory: null, aiTags: [] };
          backend.shots = backend.shots.map((item) => (item.id === updated.id ? updated : item));
          return null;
        }
        case "open_target":
          return null;
        case "get_settings":
          return {
            ai: {
              enabled: backend.aiEnabled ?? backend.aiNotice,
              provider: backend.aiProvider ?? "claudeCode",
              noticePending: backend.aiNotice,
            },
          };
        case "dismiss_ai_notice":
          backend.aiNotice = false;
          return null;
        default:
          throw new Error(`unexpected command ${cmd}`);
      }
    },
    { shouldMockEvents: true },
  );
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

  it("closes the details with Escape", async () => {
    mockBackend([shot(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));
    expect(screen.getByLabelText("Capture details")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("Capture details")).not.toBeInTheDocument();
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

  it("shows backend errors", async () => {
    const backend = mockBackend([shot(1)]);
    backend.fail = "library database error: disk I/O error";
    render(<LibraryWindow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk I/O error");
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

  it("filters by app, tag and date", async () => {
    const backend = mockBackend([
      shot(1, { tags: ["receipts"], capturedAt: new Date(2026, 2, 1, 12).getTime() }),
      shot(2, { app: "code", tags: ["Work"], capturedAt: new Date(2026, 2, 5, 12).getTime() }),
      shot(3, { capturedAt: new Date(2026, 2, 9, 12).getTime() }),
    ]);
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 3.png" });
    await waitFor(() => expect(callsTo(backend, "library_filter_options").length).toBeGreaterThan(0));

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

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
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

  it("shows model download progress, then the OCR queue", async () => {
    const backend = mockBackend([shot(1)]);
    backend.ocrStatus = { state: "downloading", downloaded: 25, total: 100 };
    render(<LibraryWindow />);

    expect(await screen.findByText(/Downloading text recognition models… 25%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Model download" })).toHaveAttribute("value", "25");
    // Let the event listener finish registering.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      await emit(OCR_STATUS_EVENT, { state: "working", pending: 3 });
    });
    expect(screen.getByText("Reading text in 3 captures…")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    await act(async () => {
      await emit(OCR_STATUS_EVENT, { state: "idle" });
    });
    expect(screen.queryByText(/Reading text/)).not.toBeInTheDocument();
  });

  it("offers a retry when the models could not be downloaded", async () => {
    const backend = mockBackend([shot(1)]);
    backend.ocrStatus = { state: "failed", message: "could not download the text recognition models: offline" };
    render(<LibraryWindow />);

    expect(await screen.findByText(/offline/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(callsTo(backend, "ocr_retry")).toHaveLength(1));
    expect(screen.queryByText(/offline/)).not.toBeInTheDocument();
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

  it("shows a one-line description and category chip on cards", async () => {
    mockBackend([described(1), shot(2)]);
    render(<LibraryWindow />);

    const card = await screen.findByRole("button", { name: "Grab-it 1.png" });
    const text = within(card).getByText(/A Rust compiler error/);
    expect(text).toHaveClass("shot-description");
    expect(text).toHaveAttribute("title", "A Rust compiler error about a borrowed value in main.rs, shown in VS Code");
    expect(within(card).getByText("Error / dialog")).toHaveClass("category-chip");
    // AI tags stay in the details, not on the card.
    expect(within(card).queryByText("rust")).not.toBeInTheDocument();
    const plain = screen.getByRole("button", { name: "Grab-it 2.png" });
    expect(plain.querySelector(".shot-ai-line")).toBeNull();
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
    expect(chip).toHaveTextContent("All categories");
  });

  it("shows the description, category and AI tags apart from the user's tags", async () => {
    mockBackend([described(1, { tags: ["work"] })]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    const details = screen.getByRole("complementary", { name: "Capture details" });
    const ai = within(details).getByRole("region", { name: "AI description" });
    expect(within(ai).getByText(/A Rust compiler error about a borrowed value/)).toBeInTheDocument();
    expect(within(ai).getByText("Error / dialog")).toBeInTheDocument();
    const aiTags = within(ai).getByLabelText("AI tags");
    expect(within(aiTags).getByText("rust")).toHaveClass("tag", "tag-ai");
    expect(within(aiTags).getByText("compiler")).toHaveAttribute("title", "Suggested by AI");
    // User tags stay in their own field.
    expect(within(details).getByRole("button", { name: "Remove tag work" })).toBeInTheDocument();
    expect(within(ai).queryByText("work")).not.toBeInTheDocument();
  });

  it("re-describes a capture and clears its AI description", async () => {
    const backend = mockBackend([described(1)]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    await userEvent.click(screen.getByRole("button", { name: "Re-describe" }));
    await waitFor(() => expect(callsTo(backend, "ai_redescribe")).toHaveLength(1));
    expect(callsTo(backend, "ai_redescribe")[0].payload).toEqual({ id: 1 });
    expect(await screen.findByText(/Describing again/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear AI description" }));
    await waitFor(() => expect(callsTo(backend, "ai_clear")[0]?.payload).toEqual({ id: 1 }));
    expect(await screen.findByText("Not described yet.")).toBeInTheDocument();
    const card = screen.getByRole("button", { name: "Grab-it 1.png" });
    expect(within(card).queryByText(/A Rust compiler error/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear AI description" })).toBeDisabled();
  });

  it("says to turn AI on when it is off", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiStatus = { state: "off", done: 0, total: 0, error: null };
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    expect(await screen.findByText(/Turn on AI descriptions in Settings/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-describe" })).toBeDisabled();
    expect(screen.queryByText(/Describing/)).not.toBeInTheDocument();
  });

  it("shows progress from the status event, then the error with a hint", async () => {
    const backend = mockBackend([shot(1)]);
    backend.aiStatus = { state: "working", done: 2, total: 40, error: null };
    render(<LibraryWindow />);

    expect(await screen.findByText("Describing 3 of 40…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Descriptions" })).toHaveAttribute("value", "2");
    await settle();

    await act(async () => {
      await emit(AI_STATUS_EVENT, { state: "working", done: 9, total: 40, error: null });
    });
    expect(screen.getByText("Describing 10 of 40…")).toBeInTheDocument();

    await act(async () => {
      await emit(AI_STATUS_EVENT, {
        state: "error",
        done: 9,
        total: 40,
        error: "could not reach http://localhost:11434/v1",
      });
    });
    expect(screen.queryByText(/Describing \d+ of/)).not.toBeInTheDocument();
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
    render(<LibraryWindow />);
    await screen.findByRole("button", { name: "Grab-it 1.png" });
    await settle();
    expect(screen.queryByText(/Claude Code now describes/)).not.toBeInTheDocument();

    backend.aiNotice = true;
    await act(async () => {
      await emit(AI_STATUS_EVENT, { state: "idle", done: 0, total: 0, error: null, provider: "claudeCode" });
    });
    expect(await screen.findByText(/Claude Code now describes your new captures/)).toBeInTheDocument();
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
    backend.aiStatus = { state: "working", done: 0, total: 1, error: null };
    render(<LibraryWindow />);
    expect(await screen.findByText("Describing 1 of 1…")).toBeInTheDocument();
    await settle();

    backend.shots = [described(1)];
    await act(async () => {
      await emit(AI_STATUS_EVENT, { state: "idle", done: 1, total: 1, error: null });
    });

    const card = screen.getByRole("button", { name: "Grab-it 1.png" });
    expect(await within(card).findByText(/A Rust compiler error/)).toBeInTheDocument();
    expect(screen.queryByText(/Describing/)).not.toBeInTheDocument();
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
