import { describe, expect, it } from "vitest";
import { TAG_HUES, tagHue, tagStyle } from "./tagColor";

describe("tag colours", () => {
  it("gives a tag the same hue every time, whatever its case or spacing", () => {
    expect(tagHue("github")).toBe(tagHue("github"));
    expect(tagHue("GitHub")).toBe(tagHue("github"));
    expect(tagHue(" github ")).toBe(tagHue("github"));
  });

  it("picks from the palette and spreads tags across it", () => {
    const tags = ["grab-it", "macos", "github", "xattr", "claude", "gatekeeper", "ollama", "settings", "code review", "privacy"];
    const hues = tags.map(tagHue);
    for (const hue of hues) expect(TAG_HUES).toContain(hue);
    expect(new Set(hues).size).toBeGreaterThanOrEqual(4);
  });

  it("sets the hue as a CSS variable", () => {
    expect(tagStyle("macos")).toEqual({ "--tag-hue": tagHue("macos") });
  });
});
