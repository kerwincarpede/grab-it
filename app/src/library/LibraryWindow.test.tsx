import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LibraryWindow from "./LibraryWindow";
import {
  LIBRARY_CHANGED_EVENT,
  NO_FILTERS,
  OCR_STATUS_EVENT,
  PAGE_SIZE,
  buildQuery,
  dayStart,
  isSearching,
  parseTags,
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
}

/** A small stand-in for `Library::search`: every word must start a word in some field. */
function search(backend: Backend, query: SearchQuery): SearchHit[] {
  const words = query.text.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  for (const item of [...backend.shots].sort((a, b) => b.capturedAt - a.capturedAt)) {
    if (query.app && item.app !== query.app) continue;
    if (query.tag && !item.tags.some((tag) => tag.toLowerCase() === query.tag?.toLowerCase())) continue;
    if (query.from !== null && item.capturedAt < query.from) continue;
    if (query.to !== null && item.capturedAt >= query.to) continue;
    const fields: [MatchField, string][] = [
      ["text", backend.ocr[item.id] ?? ""],
      ["tags", item.tags.join(" ")],
      ["notes", item.notes],
      ["app", item.app ?? ""],
      ["windowTitle", item.windowTitle ?? ""],
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
  const backend: Backend = { shots, calls: [], ocr: {}, ocrStatus: { state: "idle" } };
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
            tags: [...new Set(backend.shots.flatMap((item) => item.tags))].sort(),
          };
        case "ocr_status":
          return backend.ocrStatus;
        case "ocr_retry":
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

  it("edits a capture's tags", async () => {
    const backend = mockBackend([shot(1, { tags: ["old"] })]);
    render(<LibraryWindow />);
    await userEvent.click(await screen.findByRole("button", { name: "Grab-it 1.png" }));

    const input = screen.getByLabelText("Tags");
    expect(input).toHaveValue("old");
    await userEvent.clear(input);
    await userEvent.type(input, " bug, , design {Enter}");

    await waitFor(() => expect(callsTo(backend, "library_set_tags")).toHaveLength(1));
    expect(callsTo(backend, "library_set_tags")[0].payload).toEqual({ id: 1, tags: ["bug", "design"] });
    const card = screen.getByRole("button", { name: "Grab-it 1.png" });
    expect(await within(card).findByText("design")).toBeInTheDocument();
    expect(within(card).queryByText("old")).not.toBeInTheDocument();
    expect(input).toHaveValue("bug, design");
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
    const app = screen.getByRole("combobox", { name: "Filter by app" });
    await waitFor(() => expect(within(app).getByRole("option", { name: "code" })).toBeInTheDocument());

    await userEvent.selectOptions(app, "firefox");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 2.png" })).not.toBeInTheDocument());
    expect(screen.getByText("2 results")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Filter by tag" }), "receipts");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Grab-it 3.png" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Grab-it 1.png" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
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

describe("search queries", () => {
  it("turns typed words and filters into a query", () => {
    expect(buildQuery("  invoice ", NO_FILTERS)).toEqual({ text: "invoice", from: null, to: null, app: null, tag: null });
    expect(isSearching(buildQuery(" ", NO_FILTERS))).toBe(false);
    const query = buildQuery("", { app: "code", tag: "bug", fromDate: "2026-03-01", toDate: "2026-03-31" });
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

describe("parseTags", () => {
  it("splits on commas and drops empty tags", () => {
    expect(parseTags(" bug, ,design ,")).toEqual(["bug", "design"]);
    expect(parseTags("")).toEqual([]);
  });
});
