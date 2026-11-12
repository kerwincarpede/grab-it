import { describe, expect, it } from "vitest";
import { exportArea, exportTarget } from "./flatten";

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
