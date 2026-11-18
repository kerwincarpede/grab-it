import { describe, expect, it } from "vitest";
import type { Annotations, Cut } from "./model";
import { parseAnnotations, parseBackdrop, parsePointer, serializeAnnotations, SidecarError } from "./sidecar";

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
    { id: "g", type: "step", color: "#e5484d", x: 60, y: 70, radius: 20, number: 3 },
    { id: "c", type: "stamp", name: "check", x: 80, y: 90, size: 48, color: "#30a46c" },
    { id: "k", type: "stamp", name: "keycap", x: 80, y: 90, size: 64, rotation: 15, color: "#1f2328", label: "Ctrl" },
    { id: "m", type: "stamp", name: "emoji-1f44d", x: 10, y: 20, size: 32 },
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

  it("keeps a guide step's number and drops a step whose number makes no sense", () => {
    const step = { id: "s", type: "step", color: "#e5484d", x: 1, y: 2, radius: 20 };
    const parsed = parseAnnotations({
      version: 1,
      shapes: [{ ...step, number: 2 }, { ...step, id: "z", number: 0 }, { ...step, id: "h", number: 1.5 }],
    });
    expect(parsed.shapes.map((shape) => shape.id)).toEqual(["s"]);
  });

  it("round-trips an added image and skips one whose file name is a path", () => {
    const image = { id: "i", type: "image", x: -20, y: 4, width: 320, height: 200, src: "added-1.png" };
    const parsed = parseAnnotations({
      version: 1,
      shapes: [
        image,
        { ...image, id: "up", src: "../shot.png" },
        { ...image, id: "abs", src: "/home/me/secret.png" },
        { ...image, id: "win", src: "C:\\x\\y.png" },
        { ...image, id: "empty", src: "" },
        { ...image, id: "flat", height: 0 },
        { ...image, id: "nosrc", src: undefined },
      ],
    });
    expect(parsed.shapes).toEqual([image]);
    expect(parseAnnotations(JSON.parse(JSON.stringify(serializeAnnotations(parsed))))).toEqual(parsed);
  });

  it("keeps stamps by name and skips one this version does not bundle", () => {
    const stamp = { id: "c", type: "stamp", name: "check", x: 1, y: 2, size: 48 };
    const parsed = parseAnnotations({
      version: 1,
      shapes: [
        stamp,
        { ...stamp, id: "new", name: "sparkle-from-a-newer-version" },
        { ...stamp, id: "nameless", name: undefined },
        { ...stamp, id: "flat", size: 0 },
        { ...stamp, id: "turned", rotation: "45" },
        { ...stamp, id: "label", name: "keycap", label: 3 },
        { ...stamp, id: "long", name: "keycap", label: "x".repeat(41) },
      ],
    });
    expect(parsed.shapes).toEqual([stamp]);
  });

  it("writes a stamp's optional fields only when set", () => {
    const stamp = { id: "c", type: "stamp" as const, name: "cursor-arrow", x: 1, y: 2, size: 48 };
    const written = JSON.parse(JSON.stringify(serializeAnnotations({ version: 1, shapes: [stamp] })));
    expect(written.shapes[0]).toEqual(stamp);
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
        { id: "o", type: "text", color: "#ffffff", x: 3, y: 40, text: "Outlined", fontSize: 30, textStyle: "outline" },
        { id: "d", type: "text", color: "#ffffff", x: 3, y: 80, text: "Shadowed", fontSize: 30, textStyle: "shadow" },
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
        { id: "o", type: "text", color: "#1f2328", x: 3, y: 4, text: "Look", fontSize: 30, textStyle: "neon" },
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


describe("magnify sidecars", () => {
  const lens = { id: "m", type: "magnify", x: 10, y: 20, width: 100, height: 100,
    color: "#0090ff", strokeWidth: 4, spot: [60, 70], zoom: 3 };
  it("round-trips round and square lenses with their spot and line", () => {
    const value = { version: 1, shapes: [lens, { ...lens, id: "square", lens: "square", line: true }], crop: null };
    expect(parseAnnotations(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
  it.each([
    { zoom: 1 }, { zoom: 7 }, { zoom: 2.5 }, { spot: [1] }, { spot: [NaN, 2] },
    { lens: "triangle" }, { line: "yes" }, { height: 50 }, { width: -100, height: -100 },
  ])("skips malformed magnify fields %j", (invalid) => {
    expect(parseAnnotations({ version: 1, shapes: [{ ...lens, ...invalid }] }).shapes).toEqual([]);
  });
});

describe("pointer sidecars", () => {
  it("keeps the pointer edits through a save and load", () => {
    const edited: Annotations = { version: 1, shapes: [], crop: null, pointer: { shown: false, x: 10, y: 20, scale: 1.5 } };
    const saved = serializeAnnotations(edited);
    expect(saved.pointer).toEqual({ shown: false, x: 10, y: 20, scale: 1.5 });
    expect(parseAnnotations(JSON.parse(JSON.stringify(saved)))).toEqual(edited);
  });

  it("leaves the pointer out until it is edited, so older sidecars still load", () => {
    const plain = parseAnnotations({ version: 1, shapes: [], crop: null });
    expect(plain).not.toHaveProperty("pointer");
    expect(serializeAnnotations(plain)).not.toHaveProperty("pointer");
  });

  it("drops a pointer it does not understand on its own", () => {
    expect(parsePointer({ shown: "yes", x: 1, y: 2, scale: 1 })).toBeNull();
    expect(parsePointer({ shown: true, x: 1, y: 2, scale: 0 })).toBeNull();
    expect(parsePointer({ shown: true, x: 1, y: 2 })).toBeNull();
    expect(parsePointer(null)).toBeNull();
    // Out of range sizes are brought into range.
    expect(parsePointer({ shown: true, x: 1, y: 2, scale: 100 })?.scale).toBe(8);
    const doc = parseAnnotations({ version: 1, shapes: [], crop: null, pointer: { shown: 1 } });
    expect(doc).not.toHaveProperty("pointer");
  });

  it("keeps a built-in look through a save and load", () => {
    const edited: Annotations = { version: 1, shapes: [], crop: null, pointer: { shown: true, x: 10, y: 20, scale: 1, look: "hand" } };
    const saved = serializeAnnotations(edited);
    expect(saved.pointer).toEqual({ shown: true, x: 10, y: 20, scale: 1, look: "hand" });
    expect(parseAnnotations(JSON.parse(JSON.stringify(saved)))).toEqual(edited);
  });

  it("shows the captured pointer when the look is absent or not one it knows", () => {
    expect(parsePointer({ shown: true, x: 1, y: 2, scale: 1 })).not.toHaveProperty("look");
    expect(parsePointer({ shown: true, x: 1, y: 2, scale: 1, look: "sparkle" })).toEqual({ shown: true, x: 1, y: 2, scale: 1 });
    expect(parsePointer({ shown: true, x: 1, y: 2, scale: 1, look: 3 })).toEqual({ shown: true, x: 1, y: 2, scale: 1 });
    for (const look of ["arrow", "hand", "text"]) expect(parsePointer({ shown: true, x: 1, y: 2, scale: 1, look })?.look).toBe(look);
  });
});

describe("callout sidecars", () => {
  const callout = { id: "c", type: "callout", color: "#e5484d", x: 40, y: 20, text: "Here", fontSize: 30, tail: { x: 10, y: 90 } };
  it("round-trips a callout, with and without a background", () => {
    const value = { version: 1, shapes: [callout, { ...callout, id: "filled", background: true }], crop: null };
    expect(parseAnnotations(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
  it.each([
    { tail: undefined }, { tail: [10, 90] }, { tail: { x: 10 } }, { tail: { x: "10", y: 90 } }, { tail: null },
    { text: 5 }, { fontSize: "30" }, { background: "yes" },
  ])("skips malformed callout fields %j", (invalid) => {
    expect(parseAnnotations({ version: 1, shapes: [{ ...callout, ...invalid }] }).shapes).toEqual([]);
  });
});

describe("cut sidecars", () => {
  const cuts: Cut[] = [
    { axis: "y", start: 100, end: 160, edge: "straight" },
    { axis: "x", start: 20, end: 40, edge: "torn", seed: 12345 },
    { axis: "y", start: 10, end: 30, edge: "zigzag" },
  ];

  it("round-trips the cuts in order", () => {
    const value: Annotations = { version: 1, shapes: [], cuts, crop: null };
    expect(parseAnnotations(JSON.parse(JSON.stringify(serializeAnnotations(value))))).toEqual(value);
  });

  it("loads a sidecar from before cuts without any, and writes none back", () => {
    const parsed = parseAnnotations({ version: 1, shapes: [], crop: null });
    expect(parsed).not.toHaveProperty("cuts");
    expect(serializeAnnotations({ ...parsed, cuts: [] })).not.toHaveProperty("cuts");
  });

  it.each([
    { axis: "z" }, { start: "1" }, { start: -5 }, { start: 0 }, { start: 100.5 }, { end: 159.5 }, { end: 100 }, { end: Number.NaN }, { edge: "wavy" }, { seed: 1.5 }, { seed: "x" },
  ])("drops a malformed cut %j on its own", (invalid) => {
    const parsed = parseAnnotations({ version: 1, shapes: [], cuts: [cuts[0], { ...cuts[0], ...invalid }, cuts[2]] });
    expect(parsed.cuts).toEqual([cuts[0], cuts[2]]);
  });

  it("ignores cuts that are not a list", () => {
    expect(parseAnnotations({ version: 1, shapes: [], cuts: "yes" })).not.toHaveProperty("cuts");
  });
});
