/// <reference types="node" />

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GuideWindow from "./GuideWindow";
import type { GuideInfo, GuideStep, Value } from "../app/bindings";
import { mockCommands } from "../test/mockCommands";

vi.mock("@tauri-apps/api/path", async () => {
  const { posix } = await import("node:path");
  return { join: posix.join, dirname: posix.dirname };
});

// The window draws steps on a canvas only once their image loads, which
// jsdom never does; the stand-ins keep Konva out of the test.
vi.mock("react-konva", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  // The stage and the capture image show their sizes, so a test can read what a step is drawn on.
  const Stage = ({ children, width, height }: { children?: ReactNode; width: number; height: number }) => (
    <div data-testid="step-stage" data-width={width} data-height={height}>
      {children}
    </div>
  );
  const Image = ({ image }: { image?: { width: number; height: number } }) =>
    image ? <span data-testid="step-image" data-width={image.width} data-height={image.height} /> : null;
  // The layer is what a step is flattened from; drawing it does nothing here.
  const Layer = forwardRef<{ draw: () => void }, { children?: ReactNode }>(({ children }, ref) => {
    useImperativeHandle(ref, () => ({ draw: () => {} }));
    return <div>{children}</div>;
  });
  return { Stage, Layer, Group: Box, Image, Rect: () => null, Circle: () => null, Line: () => null, Text: () => null, Arrow: () => null, Ellipse: () => null, Shape: () => null, Label: Box, Tag: () => null, Transformer: () => null, Path: () => null };
});

const info: GuideInfo = {
  path: "/pictures/Grab-it/guides/Grab-it Guide 2026-01-02 03-04-05.guide.json",
  title: "Grab-it Guide 2026-01-02 03-04-05",
  steps: [
    { capture: "originals/a.png", description: "Open the File menu", annotations: null, exists: true },
    { capture: "originals/b.png", description: "Click Save", annotations: null, exists: true },
    { capture: "originals/c.png", description: "Click Close", annotations: null, exists: false },
  ],
};

/** What each flattened step was flattened from: the crop and the size of the image under the shapes. */
const flattened = vi.hoisted(() => [] as { crop: unknown; size: unknown }[]);
vi.mock("../editor/flatten", () => ({
  flatten: (_layer: unknown, doc: { crop: unknown }, size: unknown) => {
    flattened.push({ crop: doc.crop, size });
    return Promise.resolve(new Uint8Array([1]));
  },
}));

function mockGuide() {
  const saved: GuideStep[][] = [];
  mockCommands(
    {
      guide_info: () => info,
      guide_image: () => new ArrayBuffer(0),
      guide_save: ({ steps }) => {
        saved.push(steps);
        return null;
      },
    },
    { shouldMockEvents: true, otherwise: () => null },
  );
  return saved;
}


describe("GuideWindow", () => {
  it("lists the steps with their descriptions", async () => {
    mockGuide();
    render(<GuideWindow />);
    expect(await screen.findByRole("heading", { name: info.title })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Open the File menu")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Click Save")).toBeInTheDocument();
    expect(screen.getByText("Capture not found")).toBeInTheDocument();
  });

  it("saves a reordered guide", async () => {
    const saved = mockGuide();
    render(<GuideWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Move step 2 up" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual([
      { capture: "originals/b.png", description: "Click Save" },
      { capture: "originals/a.png", description: "Open the File menu" },
      { capture: "originals/c.png", description: "Click Close" },
    ]);
  });

  it("deletes a step from the guide only and saves an edited description", async () => {
    const saved = mockGuide();
    render(<GuideWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete step 1" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toHaveLength(2);
    const text = screen.getByDisplayValue("Click Save");
    fireEvent.change(text, { target: { value: "Click Save in the toolbar" } });
    fireEvent.blur(text);
    await waitFor(() => expect(saved).toHaveLength(2));
    expect((saved[1] as { description: string }[])[0].description).toBe("Click Save in the toolbar");
  });

  it("puts a deleted step back in its place from the toast's Undo", async () => {
    const saved = mockGuide();
    render(<GuideWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete step 2" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(screen.getByRole("status")).toHaveTextContent("Step 2 deleted.");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1]).toEqual([
      { capture: "originals/a.png", description: "Open the File menu" },
      { capture: "originals/b.png", description: "Click Save" },
      { capture: "originals/c.png", description: "Click Close" },
    ]);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("restores deleted steps in reverse order with Ctrl Z", async () => {
    const saved = mockGuide();
    render(<GuideWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete step 1" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Delete step 2" }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1]).toEqual([{ capture: "originals/b.png", description: "Click Save" }]);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(saved).toHaveLength(3));
    expect(saved[2]).toEqual([
      { capture: "originals/b.png", description: "Click Save" },
      { capture: "originals/c.png", description: "Click Close" },
    ]);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(saved).toHaveLength(4));
    expect(saved[3]).toEqual([
      { capture: "originals/a.png", description: "Open the File menu" },
      { capture: "originals/b.png", description: "Click Save" },
      { capture: "originals/c.png", description: "Click Close" },
    ]);

    // Nothing left to restore.
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saved).toHaveLength(4);
  });

  it("leaves Ctrl Z to a description being edited", async () => {
    const saved = mockGuide();
    render(<GuideWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete step 1" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const text = screen.getByDisplayValue("Click Save");
    fireEvent.keyDown(text, { key: "z", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saved).toHaveLength(1);
    expect(screen.queryByDisplayValue("Open the File menu")).not.toBeInTheDocument();
  });

  it("offers the four export formats", async () => {
    mockGuide();
    render(<GuideWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Export" }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Markdown .md", "HTML .html", "Word document .docx", "PowerPoint deck .pptx"]);
  });
});

describe("GuideWindow steps with cuts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    flattened.length = 0;
  });

  function loadImages() {
    // Captures "load" at 400 × 300, as jsdom never decodes them.
    class LoadedImage {
      naturalWidth = 400;
      naturalHeight = 300;
      width = 400;
      height = 300;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        setTimeout(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", LoadedImage);
    // jsdom has no object URLs.
    Object.assign(URL, { createObjectURL: () => "blob:step", revokeObjectURL: () => {} });
  }

  it("exports a guide from the shared folder and remembers its destination", async () => {
    loadImages();
    const calls = mockCommands({
      guide_info: () => ({ ...info, steps: [info.steps[0]] }),
      guide_image: () => new ArrayBuffer(0),
      guide_export: () => null,
    }, {
      shouldMockEvents: true,
      otherwise: (cmd) => {
        if (cmd === "get_settings") return { saveFolder: "/pictures", lastExportFolder: "/exports" };
        if (cmd === "plugin:dialog|save") return "/desktop/guide.md";
        return null;
      },
    });
    render(<GuideWindow />);
    await waitFor(() => expect(flattened).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Markdown/ }));
    expect(await screen.findByText("Exported to /desktop/guide.md")).toBeInTheDocument();
    expect(calls.find(({ cmd }) => cmd === "plugin:dialog|save")?.payload).toMatchObject({
      options: { defaultPath: `/exports/${info.title}.md` },
    });
    expect(calls).toContainEqual({ cmd: "set_last_export_folder", payload: { folder: "/desktop" } });
  });

  it("draws a cut step on the joined capture, where its shapes and crop live", async () => {
    loadImages();
    const crop = { x: 0, y: 20, width: 400, height: 200 };
    const annotations: Value = { version: 1, shapes: [], crop, cuts: [{ axis: "y", start: 100, end: 160, edge: "straight" }] };
    mockCommands(
      {
        guide_info: () => ({ ...info, steps: [{ ...info.steps[0], annotations }] }),
        guide_image: () => new ArrayBuffer(0),
      },
      { shouldMockEvents: true, otherwise: () => null },
    );
    render(<GuideWindow />);
    const stage = await screen.findByTestId("step-stage");
    // 60 rows went: the step is 400 × 240, and so is the image its shapes sit on.
    expect(stage).toHaveAttribute("data-width", "400");
    expect(stage).toHaveAttribute("data-height", "240");
    expect(screen.getByTestId("step-image")).toHaveAttribute("data-height", "240");
    await waitFor(() => expect(flattened).toEqual([{ crop, size: { width: 400, height: 240 } }]));
  });
});
