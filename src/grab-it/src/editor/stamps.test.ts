import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAMP,
  isStampName,
  KEYCAP_PRESETS,
  keycapRatio,
  PICKER_SECTIONS,
  pickId,
  pickLabel,
  stampBox,
  stampDef,
  stampPick,
  STAMPS,
  takesColor,
} from "./stamps";

describe("stamp catalogue", () => {
  it("bundles the icons, pointers, keycap and about 30 emoji by name", () => {
    const names = STAMPS.map((stamp) => stamp.name);
    expect(names).toEqual(expect.arrayContaining(["check", "cross", "warning", "question", "star", "cursor-arrow", "cursor-hand", "cursor-text", "keycap"]));
    expect(names.filter((name) => name.startsWith("emoji-"))).toHaveLength(30);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names emoji after Noto's files and finds an SVG for every cursor and emoji", () => {
    expect(stampDef("emoji-1f44d")?.label).toBe("Thumbs up");
    for (const stamp of STAMPS) {
      if (stamp.kind === "cursor" || stamp.kind === "emoji") expect(stamp.url, stamp.name).toMatch(/\.svg/);
      if (stamp.kind === "icon") expect(stamp.parts?.length, stamp.name).toBeGreaterThan(0);
    }
    expect(stampDef("emoji-1f44d")?.url).toMatch(/emoji_u1f44d\.svg/);
  });

  it("knows only the stamps it bundles", () => {
    expect(isStampName("check")).toBe(true);
    expect(isStampName("sparkle")).toBe(false);
    expect(isStampName(3)).toBe(false);
    expect(stampDef("sparkle")).toBeUndefined();
  });

  it("recolours icons and the keycap, but not cursors or emoji", () => {
    expect(takesColor("check")).toBe(true);
    expect(takesColor("keycap")).toBe(true);
    expect(takesColor("cursor-hand")).toBe(false);
    expect(takesColor("emoji-1f525")).toBe(false);
  });
});

describe("stamp picks", () => {
  it("writes a keycap preset with its label and reads it back", () => {
    expect(pickId({ name: "check" })).toBe("check");
    expect(pickId({ name: "keycap" })).toBe("keycap");
    expect(pickId({ name: "keycap", label: "Ctrl" })).toBe("keycap:Ctrl");
    expect(stampPick("keycap:Ctrl")).toEqual({ name: "keycap", label: "Ctrl" });
    expect(stampPick("keycap")).toEqual({ name: "keycap" });
    expect(stampPick(DEFAULT_STAMP)).toEqual({ name: "check" });
  });

  it("rejects picks that name nothing bundled", () => {
    expect(stampPick("sparkle")).toBeNull();
    expect(stampPick("keycap:")).toBeNull();
    expect(stampPick("keycap:  ")).toBeNull();
    expect(stampPick(null)).toBeNull();
  });

  it("offers every stamp and the keycap presets in the picker", () => {
    const ids = PICKER_SECTIONS.flatMap((section) => section.ids);
    for (const stamp of STAMPS) expect(ids).toContain(stamp.name);
    for (const label of KEYCAP_PRESETS) expect(ids).toContain(`keycap:${label}`);
    for (const id of ids) expect(stampPick(id), id).not.toBeNull();
  });
});

describe("picker labels", () => {
  it("names every entry, telling icons, keys and emoji apart", () => {
    expect(pickLabel("star")).toBe("Star");
    expect(pickLabel("emoji-2b50")).toBe("Star emoji");
    expect(pickLabel("keycap")).toBe("Blank key");
    expect(pickLabel("keycap:Ctrl")).toBe("Ctrl key");
    const labels = PICKER_SECTIONS.flatMap((section) => section.ids.map(pickLabel));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("stamp box", () => {
  it("makes size the longer side", () => {
    expect(stampBox({ name: "check", size: 48 })).toEqual({ width: 48, height: 48 });
    const arrow = stampBox({ name: "cursor-arrow", size: 64 });
    expect(arrow.height).toBe(64);
    expect(arrow.width).toBeCloseTo(44);
  });

  it("widens a keycap for a longer label, and keeps a short one square", () => {
    expect(keycapRatio("")).toBe(1);
    expect(keycapRatio("⌘")).toBe(1);
    expect(keycapRatio("Space")).toBeGreaterThan(1);
    const cap = stampBox({ name: "keycap", size: 80, label: "Enter" });
    expect(cap.width).toBe(80);
    expect(cap.height).toBeLessThan(80);
  });
});
