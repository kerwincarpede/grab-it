import { describe, expect, it } from "vitest";
import type { Annotations } from "./model";
import { parseAnnotations, parseBackdrop, serializeAnnotations, SidecarError } from "./sidecar";

const doc: Annotations = {
  version: 1,
  shapes: [
    { id: "a", type: "arrow", color: "#e5484d", strokeWidth: 4, points: [1, 2, 3, 4] },
    { id: "l", type: "line", color: "#e5484d", strokeWidth: 2, points: [1, 2, 3, 4] },
    { id: "f", type: "freehand", color: "#0090ff", strokeWidth: 2, points: [1, 2, 3, 4, 5, 6] },
    { id: "h", type: "highlighter", color: "#f5a524", strokeWidth: 18, points: [0, 0, 9, 0] },
    { id: "r", type: "rect", color: "#30a46c", strokeWidth: 4, x: 5, y: 6, width: 7, height: 8 },
    { id: "e", type: "ellipse", color: "#30a46c", strokeWidth: 4, x: 5, y: 6, width: 7, height: 8 },
    { id: "b", type: "blur", x: 10, y: 10, width: 40, height: 20, pixelSize: 12 },
    { id: "t", type: "text", color: "#1f2328", x: 3, y: 4, text: "Look here", fontSize: 30 },
    { id: "s", type: "step", color: "#e5484d", x: 50, y: 50, radius: 20 },
  ],
  crop: { x: 1, y: 2, width: 300, height: 200 },
};

describe("annotations sidecar", () => {
  it("round-trips every shape and the crop through JSON", () => {
    const json = JSON.stringify(serializeAnnotations(doc));
    expect(parseAnnotations(JSON.parse(json))).toEqual(doc);
  });

  it("writes the documented {version: 1, shapes: [...]} shape", () => {
    const written = JSON.parse(JSON.stringify(serializeAnnotations({ version: 1, shapes: [] })));
    expect(written).toEqual({ version: 1, shapes: [], crop: null });
  });

  it("starts empty when there is no sidecar", () => {
    expect(parseAnnotations(null)).toEqual({ version: 1, shapes: [], crop: null });
  });

  it("refuses an unknown version rather than discarding it", () => {
    expect(() => parseAnnotations({ version: 2, shapes: [] })).toThrow(SidecarError);
    expect(() => parseAnnotations({ version: 1 })).toThrow(SidecarError);
    expect(() => parseAnnotations("nope")).toThrow(SidecarError);
  });

  it("skips malformed or unknown shapes", () => {
    const parsed = parseAnnotations({
      version: 1,
      shapes: [doc.shapes[0], { id: "x", type: "sparkle" }, { id: "y", type: "rect", x: "1" }, null],
      crop: { x: "bad" },
    });
    expect(parsed).toEqual({ version: 1, shapes: [doc.shapes[0]], crop: null });
  });

  it("round-trips a curved arrow and line, and loads straight ones from before curves", () => {
    const curved: Annotations = {
      version: 1,
      shapes: [
        { id: "a", type: "arrow", color: "#e5484d", strokeWidth: 4, points: [0, 0, 100, 0], control: [50, -40] },
        { id: "l", type: "line", color: "#e5484d", strokeWidth: 2, points: [0, 0, 100, 0], control: [50, 40] },
      ],
      crop: null,
    };
    expect(parseAnnotations(JSON.parse(JSON.stringify(serializeAnnotations(curved))))).toEqual(curved);
    expect(parseAnnotations({ version: 1, shapes: [doc.shapes[0]] }).shapes[0]).not.toHaveProperty("control");
  });

  it("skips a line whose control point is malformed", () => {
    const arrow = { id: "a", type: "arrow", color: "#e5484d", strokeWidth: 4, points: [0, 0, 100, 0] };
    const parsed = parseAnnotations({
      version: 1,
      shapes: [
        { ...arrow, id: "short", control: [50] },
        { ...arrow, id: "long", control: [50, 40, 60, 70] },
        { ...arrow, id: "text", control: ["50", 40] },
        { ...arrow, id: "object", control: { x: 50, y: 40 } },
        { ...arrow, id: "nan", control: [Number.NaN, 40] },
        { ...arrow, id: "good", control: [50, 40] },
      ],
    });
    expect(parsed.shapes.map((shape) => shape.id)).toEqual(["good"]);
  });

  it("round-trips the newer optional fields and the backdrop", () => {
    const styled: Annotations = {
      version: 1,
      shapes: [
        { id: "r", type: "rect", color: "#30a46c", strokeWidth: 4, x: 5, y: 6, width: 7, height: 8, fill: true },
        { id: "b", type: "blur", x: 10, y: 10, width: 40, height: 20, pixelSize: 12, mode: "blur" },
        { id: "t", type: "text", color: "#1f2328", x: 3, y: 4, text: "Look here", fontSize: 30, background: true },
        { id: "s", type: "spotlight", x: 10, y: 10, width: 40, height: 20 },
      ],
      crop: null,
      backdrop: { fill: "ocean", padding: 64, radius: 12, shadow: true },
    };
    const json = JSON.stringify(serializeAnnotations(styled));
    expect(parseAnnotations(JSON.parse(json))).toEqual(styled);
  });

  it("round-trips the rotation, flips and scale", () => {
    const turned: Annotations = { ...doc, rotation: 270, flipX: true, flipY: true, scale: 0.5 };
    expect(parseAnnotations(JSON.parse(JSON.stringify(serializeAnnotations(turned))))).toEqual(turned);
  });

  it("loads a sidecar from before rotation unchanged, and writes none of it back", () => {
    const parsed = parseAnnotations({ version: 1, shapes: doc.shapes, crop: null });
    for (const field of ["rotation", "flipX", "flipY", "scale"]) {
      expect(parsed).not.toHaveProperty(field);
      expect(serializeAnnotations(parsed)).not.toHaveProperty(field);
    }
    // Unchanged values are not written either.
    const plain = serializeAnnotations({ ...parsed, rotation: 0, flipX: false, flipY: false, scale: 1 });
    expect(plain).toEqual({ version: 1, shapes: doc.shapes, crop: null });
  });

  it("drops a malformed rotation, flip or scale on its own and clamps the scale", () => {
    expect(parseAnnotations({ version: 1, shapes: [], rotation: 45, flipX: "yes", flipY: 1, scale: "big" })).toEqual({
      version: 1,
      shapes: [],
      crop: null,
    });
    expect(parseAnnotations({ version: 1, shapes: [], rotation: -90, scale: 20 })).toEqual({
      version: 1,
      shapes: [],
      crop: null,
      rotation: 270,
      scale: 4,
    });
    expect(parseAnnotations({ version: 1, shapes: [], rotation: 360, scale: 0.01 })).toEqual({ version: 1, shapes: [], crop: null, scale: 0.1 });
    expect(parseAnnotations({ version: 1, shapes: [], scale: -2 })).not.toHaveProperty("scale");
  });

  it("loads a sidecar written before backdrops, and writes none back", () => {
    const parsed = parseAnnotations({ version: 1, shapes: doc.shapes, crop: null });
    expect(parsed.backdrop ?? null).toBeNull();
    expect(serializeAnnotations(parsed)).not.toHaveProperty("backdrop");
    expect(serializeAnnotations({ ...parsed, backdrop: null })).not.toHaveProperty("backdrop");
  });

  it("skips shapes whose optional fields are malformed", () => {
    const parsed = parseAnnotations({
      version: 1,
      shapes: [
        { id: "r", type: "rect", color: "#30a46c", strokeWidth: 4, x: 5, y: 6, width: 7, height: 8, fill: "yes" },
        { id: "b", type: "blur", x: 10, y: 10, width: 40, height: 20, pixelSize: 12, mode: "smear" },
        { id: "t", type: "text", color: "#1f2328", x: 3, y: 4, text: "Look", fontSize: 30, background: 1 },
        { id: "s", type: "spotlight", x: 10, y: 10, width: "wide", height: 20 },
      ],
    });
    expect(parsed.shapes).toEqual([]);
  });

  it("keeps a backdrop's sizes in range and drops a malformed one", () => {
    expect(parseBackdrop({ fill: "#ffffff", padding: 999, radius: -5, shadow: false })).toEqual({
      fill: "#ffffff",
      padding: 200,
      radius: 0,
      shadow: false,
    });
    expect(parseBackdrop({ fill: "ocean", padding: 10, radius: 4 })).toBeNull();
    expect(parseBackdrop({ fill: 7, padding: 10, radius: 4, shadow: true })).toBeNull();
    expect(parseBackdrop("ocean")).toBeNull();
    expect(parseAnnotations({ version: 1, shapes: [], backdrop: { fill: "ocean" } })).toEqual({ version: 1, shapes: [], crop: null });
  });

  it("keeps the newer backdrop fields, each checked on its own", () => {
    const backdrop = {
      fill: "custom",
      padding: 40,
      radius: 36,
      radiusUnit: "pt",
      shadow: true,
      shadowSize: 70,
      shadowStrength: 50,
      aspect: "4:3",
      gradient: { from: "#112233", to: "#445566", angle: 90 },
      image: "/home/me/beach.jpg",
    };
    expect(parseBackdrop(backdrop)).toEqual(backdrop);
    expect(
      parseBackdrop({
        ...backdrop,
        radius: 120,
        radiusUnit: "em",
        shadowSize: 400,
        shadowStrength: "strong",
        aspect: "21:9",
        gradient: { from: "red", to: "#445566", angle: 90 },
        image: 3,
      }),
    ).toEqual({ fill: "custom", padding: 40, radius: 80, shadow: true, shadowSize: 100 });
    expect(parseBackdrop({ ...backdrop, gradient: { from: "#112233", to: "#445566", angle: -90 } })?.gradient?.angle).toBe(270);
  });

  it("keeps the 9:16 shape", () => {
    const backdrop = { fill: "ocean", padding: 64, radius: 12, shadow: true, aspect: "9:16" };
    expect(parseBackdrop(backdrop)).toEqual(backdrop);
  });

  it("keeps balance only when it is on", () => {
    const backdrop = { fill: "ocean", padding: 64, radius: 12, shadow: true };
    expect(parseBackdrop({ ...backdrop, balance: true })).toEqual({ ...backdrop, balance: true });
    expect(parseBackdrop({ ...backdrop, balance: false })).toEqual(backdrop);
    expect(parseBackdrop({ ...backdrop, balance: "yes" })).toEqual(backdrop);
    const doc: Annotations = { version: 1, shapes: [], crop: null, backdrop: { ...backdrop, balance: true } };
    expect(parseAnnotations(JSON.parse(JSON.stringify(serializeAnnotations(doc))))).toEqual(doc);
  });

  it("loads a backdrop from before the shadow sliders as it was", () => {
    expect(parseBackdrop({ fill: "ocean", padding: 64, radius: 12, shadow: true })).toEqual({
      fill: "ocean",
      padding: 64,
      radius: 12,
      shadow: true,
    });
  });
});
