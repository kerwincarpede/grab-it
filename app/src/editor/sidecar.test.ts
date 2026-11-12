import { describe, expect, it } from "vitest";
import type { Annotations } from "./model";
import { parseAnnotations, serializeAnnotations, SidecarError } from "./sidecar";

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
});
