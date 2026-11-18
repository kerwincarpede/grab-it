import { describe, expect, it } from "vitest";
import { ARROW_STYLES, arrowGeometry, bendElbow, elbowMidpoint } from "./arrowStyles";
import { STROKE_WIDTHS, type LineShape } from "./model";
import { moveShape } from "./tools";

const arrow: LineShape = {
  id: "a",
  type: "arrow",
  color: "#e5484d",
  strokeWidth: 4,
  points: [10, 20, 130, 80],
};

describe("arrow geometry", () => {
  it("draws twelve distinct silhouettes, with a hollow Outline", () => {
    const shapes = ARROW_STYLES.map(({ id: arrowStyle }) => arrowGeometry({ ...arrow, arrowStyle }));
    expect(shapes).toHaveLength(12);
    expect(new Set(shapes.map(({ parts }) => JSON.stringify(parts))).size).toBe(12);
    const { parts } = arrowGeometry({ ...arrow, arrowStyle: "outline" });
    expect(parts).toHaveLength(1);
    expect(parts[0].strokeWidth).toBeGreaterThan(0);
    expect(parts[0].path).toMatch(/ Z$/);
  });

  it.each(ARROW_STYLES)("fits $label on a very short arrow at every supported width", ({ id: arrowStyle }) => {
    for (const strokeWidth of STROKE_WIDTHS) {
      const { parts } = arrowGeometry({ ...arrow, arrowStyle, strokeWidth, points: [0, 0, 3, 0] });
      expect(parts.length).toBeGreaterThan(0);
      for (const part of parts) {
        expect(part.path).not.toMatch(/NaN|Infinity/);
        expect(part.strokeWidth ?? 0).toBeLessThan(1);
      }
    }
  });

  it("aligns both heads to the curve's endpoint tangents", () => {
    const { parts, centreline } = arrowGeometry({
      ...arrow, arrowStyle: "double-ended", points: [0, 0, 100, 0], control: [0, 80],
    });
    // Tail points straight up, because the path runs straight down from it.
    expect(parts[1].path).toBe("M 9 18 L 0 0 L -9 18 Z");
    expect(parts[2].path).toContain(" L 100 0 L ");
    expect(centreline).toBe("M 0 0 Q 0 80 100 0");
  });

  it("keeps the shaft attached when a curved arrow doubles back at the tip", () => {
    const { parts } = arrowGeometry({ ...arrow, points: [0, 0, 100, 0], control: [110, 0] });
    expect(parts[0].path).toBe("M 0 0 Q 110 0 100 0");
    expect(parts[1].path).toBe("M 118 -9 L 100 0 L 118 9 Z");
  });

  it("keeps the shaft's width when a short Elbow leg limits only the head", () => {
    const { parts } = arrowGeometry({
      ...arrow, strokeWidth: 12, arrowStyle: "elbow", points: [0, 0, 200, 50], elbow: { axis: "y", at: 49.9 },
    });
    expect(parts[0].strokeWidth).toBe(12);
    expect(parts[1].path).toContain(" L 200 50 L ");
  });

  it("slides the middle segment off a straight baseline and translates the whole route", () => {
    const line: LineShape = { ...arrow, arrowStyle: "elbow", points: [10, 20, 120, 20] };
    const bent = bendElbow(line, { x: 70, y: 49 });
    expect(bent.elbow).toEqual({ axis: "y", at: 49 });
    expect(bent.points).toEqual(line.points);
    expect(elbowMidpoint(bent)).toEqual({ x: 65, y: 49 });
    expect(arrowGeometry(bent).centreline).toBe("M 10 20 L 10 49 L 120 49 L 120 20");
    const shifted = moveShape(bent, 4, 5) as LineShape;
    expect(elbowMidpoint(shifted)).toEqual({ x: 69, y: 54 });
    expect(arrowGeometry(shifted).centreline).toBe("M 14 25 L 14 54 L 124 54 L 124 25");
  });
});
