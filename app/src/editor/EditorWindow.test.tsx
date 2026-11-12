import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EditorWindow from "./EditorWindow";
import type { Annotations } from "./model";

// jsdom has no canvas, so Konva nodes render as plain elements that keep
// the props the tests look at.
vi.mock("react-konva", async () => {
  const { createElement } = await import("react");
  const node =
    (kind: string) =>
    ({ children, id, text, onMouseDown }: { children?: ReactNode; id?: string; text?: string; onMouseDown?: () => void }) =>
      // Only annotations (which have ids) take clicks; the Stage's handler
      // needs real Konva events.
      createElement("div", { "data-konva": kind, "data-id": id, "data-text": text, onMouseDown: id ? () => onMouseDown?.() : undefined }, children);
  return {
    Stage: node("Stage"),
    Layer: node("Layer"),
    Group: node("Group"),
    Arrow: node("Arrow"),
    Line: node("Line"),
    Rect: node("Rect"),
    Ellipse: node("Ellipse"),
    Circle: node("Circle"),
    Text: node("Text"),
    Image: node("Image"),
    Transformer: node("Transformer"),
  };
});

class LoadedImage {
  width = 400;
  height = 300;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_url: string) {
    setTimeout(() => this.onload?.());
  }
}

const sidecar: Annotations = {
  version: 1,
  shapes: [
    { id: "a1", type: "arrow", color: "#e5484d", strokeWidth: 4, points: [10, 10, 100, 80] },
    { id: "t1", type: "text", color: "#1f2328", x: 20, y: 200, text: "Click here", fontSize: 24 },
    { id: "s1", type: "step", color: "#e5484d", x: 50, y: 50, radius: 16 },
    { id: "s2", type: "step", color: "#e5484d", x: 90, y: 50, radius: 16 },
  ],
  crop: null,
};

function mockEditor(): Annotations[] {
  const saved: Annotations[] = [];
  mockIPC((cmd, payload) => {
    switch (cmd) {
      case "editor_info":
        return { path: "/p/originals/shot.png", fileName: "shot.png", annotations: sidecar };
      case "editor_image":
        return new ArrayBuffer(8);
      case "editor_save_annotations":
        saved.push((payload as { annotations: Annotations }).annotations);
        return null;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return saved;
}

async function ready() {
  render(<EditorWindow />);
  await waitFor(() => expect(screen.getByTestId("editor")).toHaveAttribute("data-ready", "true"));
}

const shapeIds = () =>
  Array.from(document.querySelectorAll("[data-konva] [data-id]")).map((element) => element.getAttribute("data-id"));

describe("EditorWindow", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", LoadedImage);
    URL.createObjectURL = vi.fn(() => "blob:capture");
    URL.revokeObjectURL = vi.fn();
  });

  it("shows the capture with its saved annotations and numbered steps", async () => {
    mockEditor();
    await ready();
    expect(screen.getByText("shot.png")).toBeInTheDocument();
    expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);
    expect(document.querySelector('[data-text="Click here"]')).toBeInTheDocument();
    const badges = Array.from(document.querySelectorAll('[data-konva="Group"] [data-text]')).map((element) =>
      element.getAttribute("data-text"),
    );
    expect(badges).toEqual(["1", "2"]);
  });

  it("offers every tool and switches tools by key", async () => {
    mockEditor();
    await ready();
    for (const name of ["Arrow", "Rectangle", "Ellipse", "Line", "Freehand", "Text", "Highlighter", "Blur", "Step", "Crop", "Select"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Arrow" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(window, { key: "b" });
    expect(screen.getByRole("button", { name: "Blur" })).toHaveAttribute("aria-pressed", "true");
  });

  it("selects, deletes and undoes, saving the sidecar each time", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="a1"]') as Element);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();

    fireEvent.keyDown(window, { key: "Delete" });
    expect(shapeIds()).toEqual(["t1", "s1", "s2"]);
    await waitFor(() => expect(saved.at(-1)?.shapes.map((shape) => shape.id)).toEqual(["t1", "s1", "s2"]));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(shapeIds()).toEqual(["a1", "t1", "s1", "s2"]);
    await waitFor(() => expect(saved.at(-1)?.shapes.map((shape) => shape.id)).toEqual(["a1", "t1", "s1", "s2"]));

    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(shapeIds()).toEqual(["t1", "s1", "s2"]);
  });

  it("recolours the selected shape", async () => {
    const saved = mockEditor();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.mouseDown(document.querySelector('[data-id="t1"]') as Element);
    fireEvent.click(screen.getByRole("button", { name: "Colour #0090ff" }));
    await waitFor(() => expect(saved.at(-1)?.shapes.find((shape) => shape.id === "t1")).toMatchObject({ color: "#0090ff" }));
  });
});
