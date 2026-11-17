import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GuideWindow from "./GuideWindow";

// The window draws steps on a canvas only once their image loads, which
// jsdom never does; the stand-ins keep Konva out of the test.
vi.mock("react-konva", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Stage: Box, Layer: Box, Group: Box, Image: () => null, Rect: () => null, Circle: () => null, Line: () => null, Text: () => null, Arrow: () => null, Ellipse: () => null, Shape: () => null, Label: Box, Tag: () => null, Transformer: () => null, Path: () => null };
});

const info = {
  path: "/pictures/Grab-it/guides/Grab-it Guide 2026-01-02 03-04-05.guide.json",
  title: "Grab-it Guide 2026-01-02 03-04-05",
  steps: [
    { capture: "originals/a.png", description: "Open the File menu", annotations: null, exists: true },
    { capture: "originals/b.png", description: "Click Save", annotations: null, exists: true },
    { capture: "originals/c.png", description: "Click Close", annotations: null, exists: false },
  ],
};

function mockGuide() {
  const saved: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "guide_info") return info;
    if (cmd === "guide_image") return new ArrayBuffer(0);
    if (cmd === "guide_save") saved.push((args as { steps: unknown }).steps);
    return null;
  });
  return saved;
}

afterEach(() => clearMocks());

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

  it("offers the four export formats", async () => {
    mockGuide();
    render(<GuideWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "Export" }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Markdown .md", "HTML .html", "Word document .docx", "PowerPoint deck .pptx"]);
  });
});
