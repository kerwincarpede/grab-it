import { describe, expect, it } from "vitest";
import { calloutBubble, calloutWedge, defaultTailOffset, labelPadding } from "./callout";
import { textSize } from "./orient";

/** Twice the signed area of a polygon given as `[x1, y1, x2, y2, ...]`, y down. */
function area(points: number[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    sum += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  return sum;
}

describe("callout bubble", () => {
  const label = { text: "Look here", fontSize: 20 };
  const box = textSize(label.text, label.fontSize);
  const padding = labelPadding(label.fontSize);

  it("pads the text's box, its corner staying the text's corner", () => {
    expect(calloutBubble(label)).toEqual({ x: -padding, y: -padding, width: box.width + padding * 2, height: box.height + padding * 2 });
  });

  it("swaps its sides about the text's centre for a quarter turn", () => {
    const flat = calloutBubble(label, 180);
    const turned = calloutBubble(label, 90);
    expect(flat).toEqual(calloutBubble(label));
    expect(turned.width).toBeCloseTo(flat.height);
    expect(turned.height).toBeCloseTo(flat.width);
    expect(turned.x + turned.width / 2).toBeCloseTo(box.width / 2);
    expect(turned.y + turned.height / 2).toBeCloseTo(box.height / 2);
  });
});

describe("callout tail", () => {
  const bubble = { x: 0, y: 0, width: 100, height: 40 };

  it("runs from a base across the bubble's centre to the tip", () => {
    const wedge = calloutWedge(bubble, { x: 50, y: 120 }, 20);
    expect(wedge.slice(2, 4)).toEqual([50, 120]);
    // Straight down: the base is level, centred on the bubble, 9px each side.
    expect(wedge[1]).toBeCloseTo(20);
    expect(wedge[5]).toBeCloseTo(20);
    expect(Math.abs(wedge[0] - wedge[4])).toBeCloseTo(18);
    expect((wedge[0] + wedge[4]) / 2).toBeCloseTo(50);
  });

  it("winds clockwise whichever way it points, as the bubble does", () => {
    for (const tip of [{ x: 50, y: 120 }, { x: -60, y: 20 }, { x: 200, y: -80 }, { x: 50, y: -90 }]) {
      expect(area(calloutWedge(bubble, tip, 20))).toBeGreaterThan(0);
    }
  });

  it("keeps the base inside a small bubble", () => {
    const wedge = calloutWedge({ x: 0, y: 0, width: 20, height: 10 }, { x: 10, y: 60 }, 40);
    expect(Math.abs(wedge[0] - wedge[4])).toBeLessThanOrEqual(10);
  });

  it("draws nothing for a tip on the centre", () => {
    expect(calloutWedge(bubble, { x: 50, y: 20 }, 20)).toEqual([]);
  });

  it("points a plain click's tail down and to the left", () => {
    const offset = defaultTailOffset(30);
    expect(offset.x).toBeLessThan(0);
    expect(offset.y).toBeGreaterThan(30);
  });
});
