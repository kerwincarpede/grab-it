import { render } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import * as icons from "./icons";

const ICONS = Object.entries(icons).filter(([name]) => name.endsWith("Icon")) as [string, ComponentType<{ size?: number }>][];

describe("icons", () => {
  it("finds the icons", () => {
    expect(ICONS.map(([name]) => name)).toContain("ScrollIcon");
  });

  // An unsized svg fills its container, as ScrollIcon once covered the
  // Library's New capture menu.
  it.each(ICONS)("%s is sized and styled like the others", (_, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveClass("icon");
    expect(svg).toHaveAttribute("width", "16");
    expect(svg).toHaveAttribute("height", "16");
  });

  it("takes a size", () => {
    const { container } = render(<icons.ScrollIcon size={13} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "13");
  });
});
