import { describe, expect, it } from "vitest";
import { backdropLayout, exportArea, exportTarget, gradientStops } from "./flatten";
import { backdropColors, sameBackdrop, type Backdrop } from "./model";

describe("flatten", () => {
  it("maps the crop to stage pixels at capture resolution", () => {
    expect(exportArea({ x: 10, y: 20, width: 100, height: 50 }, { width: 400, height: 300 }, { scale: 0.5, x: 30, y: 40 })).toEqual({
      x: 35,
      y: 50,
      width: 50,
      height: 25,
      pixelRatio: 2,
    });
  });

  it("exports the whole capture without a crop", () => {
    expect(exportArea(null, { width: 400, height: 300 }, { scale: 2, x: -100, y: 0 })).toEqual({
      x: -100,
      y: 0,
      width: 800,
      height: 600,
      pixelRatio: 0.5,
    });
  });

  it("picks PNG or JPG from the file name", () => {
    expect(exportTarget("/tmp/a.JPG")).toEqual({ path: "/tmp/a.JPG", format: "jpg" });
    expect(exportTarget("/tmp/a.jpeg")).toEqual({ path: "/tmp/a.jpeg", format: "jpg" });
    expect(exportTarget("/tmp/a.png")).toEqual({ path: "/tmp/a.png", format: "png" });
    expect(exportTarget("/tmp/a")).toEqual({ path: "/tmp/a.png", format: "png" });
  });
});

describe("backdrop", () => {
  const backdrop: Backdrop = { fill: "ocean", padding: 64, radius: 12, shadow: true };
  const size = { width: 400, height: 300 };

  it("leaves the capture as the output without a backdrop", () => {
    expect(backdropLayout(size, null)).toEqual({ width: 400, height: 300, x: 0, y: 0, radius: 0, shadow: null });
  });

  it("grows the output by the padding on every side", () => {
    expect(backdropLayout(size, backdrop)).toMatchObject({ width: 528, height: 428, x: 64, y: 64, radius: 12 });
    expect(backdropLayout(size, { ...backdrop, padding: 0 })).toMatchObject({ width: 400, height: 300, x: 0, y: 0 });
  });

  it("lays out the cropped size, not the whole capture", () => {
    expect(backdropLayout({ width: 100, height: 50 }, { ...backdrop, padding: 20 })).toMatchObject({ width: 140, height: 90, x: 20, y: 20 });
  });

  it("keeps padding to whole pixels so the capture is not resampled", () => {
    expect(backdropLayout(size, { ...backdrop, padding: 10.6 })).toMatchObject({ width: 422, x: 11, y: 11 });
  });

  it("never rounds corners past half the shorter side", () => {
    expect(backdropLayout({ width: 200, height: 40 }, { ...backdrop, radius: 48 }).radius).toBe(20);
  });

  it("casts a shadow only when asked, scaled to the capture", () => {
    expect(backdropLayout(size, { ...backdrop, shadow: false }).shadow).toBeNull();
    expect(backdropLayout(size, backdrop).shadow).toEqual({ blur: 18, offsetY: 6, opacity: 0.35 });
    // Small captures still get a visible shadow.
    expect(backdropLayout({ width: 40, height: 40 }, backdrop).shadow?.blur).toBe(12);
  });

  it("paints presets as gradients and anything else as a solid colour", () => {
    expect(backdropColors("ocean").length).toBeGreaterThan(1);
    expect(backdropColors("#ffffff")).toEqual(["#ffffff"]);
    expect(gradientStops(["#000000", "#888888", "#ffffff"])).toEqual([0, "#000000", 0.5, "#888888", 1, "#ffffff"]);
    expect(gradientStops(["#000000"])).toEqual([0, "#000000"]);
  });

  it("compares backdrops by value", () => {
    expect(sameBackdrop(backdrop, { ...backdrop })).toBe(true);
    expect(sameBackdrop(backdrop, { ...backdrop, padding: 65 })).toBe(false);
    expect(sameBackdrop(null, undefined)).toBe(true);
    expect(sameBackdrop(backdrop, null)).toBe(false);
  });
});
