import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LibraryWindow from "./LibraryWindow";
import { LIBRARY_CHANGED_EVENT, PAGE_SIZE, parseTags, type Shot } from "./api";

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
}

function mockBackend(shots: Shot[]): Backend {
  const backend: Backend = { shots, calls: [] };
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

describe("parseTags", () => {
  it("splits on commas and drops empty tags", () => {
    expect(parseTags(" bug, ,design ,")).toEqual(["bug", "design"]);
    expect(parseTags("")).toEqual([]);
  });
});
