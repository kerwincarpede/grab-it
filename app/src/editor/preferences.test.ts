import { describe, expect, it } from "vitest";
import { DEFAULT_CHOICES, fromPreferences, toPreferences } from "./preferences";

describe("editor preferences", () => {
  it("falls back to today's defaults when nothing is stored", () => {
    expect(fromPreferences(undefined)).toEqual(DEFAULT_CHOICES);
    expect(fromPreferences(null)).toEqual(DEFAULT_CHOICES);
    expect(fromPreferences({})).toEqual(DEFAULT_CHOICES);
  });

  it("restores the colour, tool, widths and options", () => {
    expect(
      fromPreferences({
        color: "#30A46C",
        tool: "rect",
        widths: { rect: 8, text: 48, step: 30 },
        fill: true,
        textBackground: true,
        blurMode: "blur",
      }),
    ).toEqual({
      tool: "rect",
      style: { color: "#30a46c", fill: true, background: true, blurMode: "blur" },
      widths: { rect: 8, text: 48, step: 30 },
    });
  });

  it("drops each value it does not understand on its own", () => {
    expect(
      fromPreferences({
        color: "red",
        tool: "lasso",
        widths: { arrow: 6, blur: 12, lasso: 3, line: 0, rect: 9999, ellipse: Number.NaN },
        blurMode: "swirl",
      }),
    ).toEqual({ ...DEFAULT_CHOICES, widths: { arrow: 6 } });
  });

  it("never reopens on the crop tool", () => {
    expect(fromPreferences({ tool: "crop" }).tool).toBe("arrow");
    expect(fromPreferences({ tool: "select" }).tool).toBe("select");
  });

  it("round-trips through what is stored", () => {
    const choices = {
      tool: "highlighter" as const,
      style: { color: "#0090ff", fill: true, blurMode: "blur" as const },
      widths: { highlighter: 6, arrow: 12 },
    };
    const stored = toPreferences(choices);
    expect(stored).toEqual({
      color: "#0090ff",
      tool: "highlighter",
      widths: { highlighter: 6, arrow: 12 },
      fill: true,
      textBackground: false,
      blurMode: "blur",
    });
    expect(fromPreferences(stored)).toEqual(choices);
  });
});
