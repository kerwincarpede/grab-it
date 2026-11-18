import { describe, expect, it } from "vitest";
import { canSaveFavorite, DEFAULT_CHOICES, fromPreferences, parseBackdropPresets, parseFavoriteColors, toPreferences } from "./preferences";

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
      backdrop: null,
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

  it("remembers an Outline or Shadow text style, with Pill winning over it", () => {
    expect(fromPreferences({ textStyle: "outline" }).style).toEqual({ color: DEFAULT_CHOICES.style.color, textStyle: "outline" });
    expect(fromPreferences({ textBackground: true, textStyle: "shadow" }).style).toEqual({ color: DEFAULT_CHOICES.style.color, background: true });
    expect(fromPreferences({ textStyle: "neon" })).toEqual(DEFAULT_CHOICES);

    const shadowed = { ...DEFAULT_CHOICES, style: { color: "#ffffff", textStyle: "shadow" as const, blurMode: "pixelate" as const } };
    expect(toPreferences(shadowed)).toMatchObject({ textBackground: false, textStyle: "shadow" });
    expect(fromPreferences(toPreferences(shadowed))).toEqual(shadowed);
    // Pill and Plain store no text style.
    expect(toPreferences({ ...DEFAULT_CHOICES, style: { color: "#ffffff", background: true, textStyle: "outline" } })).toMatchObject({
      textBackground: true,
    });
    expect(toPreferences({ ...DEFAULT_CHOICES, style: { color: "#ffffff", background: true, textStyle: "outline" } })).not.toHaveProperty("textStyle");
    expect(toPreferences(DEFAULT_CHOICES)).not.toHaveProperty("textStyle");
  });

  it("remembers the last-picked stamp and its size", () => {
    const choices = { ...DEFAULT_CHOICES, tool: "stamp" as const, style: { color: "#e5484d", blurMode: "pixelate" as const, stamp: "keycap:Ctrl" }, widths: { stamp: 80 } };
    const stored = toPreferences(choices);
    expect(stored).toMatchObject({ tool: "stamp", stamp: "keycap:Ctrl", widths: { stamp: 80 } });
    expect(fromPreferences(stored)).toEqual(choices);
    expect(toPreferences(DEFAULT_CHOICES)).not.toHaveProperty("stamp");
  });

  it("keeps the default stamp for one this version does not bundle", () => {
    expect(fromPreferences({ stamp: "sparkle" }).style).not.toHaveProperty("stamp");
    expect(fromPreferences({ stamp: "emoji-1f44d" }).style.stamp).toBe("emoji-1f44d");
  });

  it("never reopens on the crop or cut out tool", () => {
    expect(fromPreferences({ tool: "crop" }).tool).toBe("arrow");
    expect(fromPreferences({ tool: "cut" }).tool).toBe("arrow");
    expect(fromPreferences({ tool: "select" }).tool).toBe("select");
  });

  it("round-trips through what is stored", () => {
    const choices = {
      tool: "highlighter" as const,
      style: { color: "#0090ff", fill: true, blurMode: "blur" as const },
      widths: { highlighter: 6, arrow: 12 },
      backdrop: null,
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

  it("remembers the last backdrop, checked like a sidecar's", () => {
    const backdrop = { fill: "mesh-bloom", padding: 48, radius: 36, shadow: true, shadowSize: 70, aspect: "16:9" as const };
    const choices = { ...DEFAULT_CHOICES, backdrop };
    expect(toPreferences(choices).backdrop).toEqual(backdrop);
    expect(fromPreferences(toPreferences(choices)).backdrop).toEqual(backdrop);
    // Out of range sizes are clamped; a malformed backdrop is dropped on its own.
    expect(fromPreferences({ backdrop: { ...backdrop, radius: 500 } }).backdrop?.radius).toBe(80);
    expect(fromPreferences({ color: "#0090ff", backdrop: { fill: "ocean" } })).toEqual({
      ...DEFAULT_CHOICES,
      style: { color: "#0090ff" },
    });
  });

  it("reads auto-apply but never writes it", () => {
    const backdrop = { fill: "ocean", padding: 64, radius: 36, shadow: true };
    expect(fromPreferences({ autoBackdrop: true, backdrop }).autoBackdrop).toBe(true);
    expect(fromPreferences({ autoBackdrop: "yes" as unknown as boolean }).autoBackdrop).toBeUndefined();
    expect(toPreferences({ ...DEFAULT_CHOICES, backdrop, autoBackdrop: true })).not.toHaveProperty("autoBackdrop");
    expect(toPreferences(DEFAULT_CHOICES)).not.toHaveProperty("backdrop");
  });
  it("reads backdrop presets, each checked like a sidecar's backdrop, but never writes them", () => {
    const backdrop = { fill: "ocean", padding: 64, radius: 36, shadow: true };
    const stored = [
      { id: "p1", name: "House", backdrop: { ...backdrop, radius: 500 } },
      { id: "p2", name: "Broken", backdrop: { fill: "ocean" } },
      { id: 3, name: "Bad id", backdrop },
      { id: "p4", backdrop },
      "junk",
      { id: "p5", name: "House", backdrop: { ...backdrop, balance: true } },
    ];
    const presets = [
      { id: "p1", name: "House", backdrop: { ...backdrop, radius: 80 } },
      { id: "p5", name: "House", backdrop: { ...backdrop, balance: true } },
    ];
    expect(parseBackdropPresets(stored)).toEqual(presets);
    expect(fromPreferences({ backdropPresets: stored as never }).backdropPresets).toEqual(presets);
    // None stored: the choices are today's defaults.
    expect(fromPreferences({ backdropPresets: [] })).toEqual(DEFAULT_CHOICES);
    expect(parseBackdropPresets({ id: "p1" })).toEqual([]);
    expect(toPreferences({ ...DEFAULT_CHOICES, backdropPresets: presets })).not.toHaveProperty("backdropPresets");
  });

  it("keeps at most 24 backdrop presets", () => {
    const backdrop = { fill: "ocean", padding: 64, radius: 36, shadow: true };
    const stored = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `Preset ${i}`, backdrop }));
    expect(parseBackdropPresets(stored)).toHaveLength(24);
  });

  it("reads favourite colours, lower-cased and each once, but never writes them", () => {
    const stored = ["#FF8800", 3, "red", "#ff8800", "#123abc"];
    expect(parseFavoriteColors(stored)).toEqual(["#ff8800", "#123abc"]);
    expect(fromPreferences({ favoriteColors: stored as never }).favoriteColors).toEqual(["#ff8800", "#123abc"]);
    expect(fromPreferences({ favoriteColors: [] })).toEqual(DEFAULT_CHOICES);
    expect(parseFavoriteColors("#ff8800")).toEqual([]);
    expect(toPreferences({ ...DEFAULT_CHOICES, favoriteColors: ["#ff8800"] })).not.toHaveProperty("favoriteColors");
  });

  it("keeps at most 8 favourite colours", () => {
    const stored = Array.from({ length: 12 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
    expect(parseFavoriteColors(stored)).toEqual(stored.slice(0, 8));
  });

  it("saves a favourite only when it is new, not built in, and there is room", () => {
    expect(canSaveFavorite([], "#FF8800")).toBe(true);
    expect(canSaveFavorite(["#ff8800"], "#FF8800")).toBe(false);
    // The built-in red.
    expect(canSaveFavorite([], "#E5484D")).toBe(false);
    const full = Array.from({ length: 8 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
    expect(canSaveFavorite(full, "#ff8800")).toBe(false);
  });
});
