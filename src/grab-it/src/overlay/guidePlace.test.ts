import { describe, expect, it } from "vitest";
import { nextGuideEdge, showsGuide } from "./guidePlace";

const bands = {
  top: { top: 80, bottom: 440, left: 300, right: 740 },
  bottom: { top: 380, bottom: 740, left: 300, right: 740 },
};

describe("nextGuideEdge", () => {
  it("stays put while nothing is held", () => {
    expect(nextGuideEdge("bottom", null, bands)).toBe("bottom");
    expect(nextGuideEdge("top", null, bands)).toBe("top");
  });

  it("stays put while the held area is clear of it", () => {
    expect(nextGuideEdge("bottom", { x: 0, y: 0, width: 200, height: 760 }, bands)).toBe("bottom");
    expect(nextGuideEdge("bottom", { x: 300, y: 100, width: 400, height: 200 }, bands)).toBe("bottom");
  });

  it("moves to the edge where less of the area lies under it", () => {
    expect(nextGuideEdge("bottom", { x: 300, y: 500, width: 400, height: 200 }, bands)).toBe("top");
    expect(nextGuideEdge("top", { x: 300, y: 100, width: 400, height: 200 }, bands)).toBe("bottom");
  });

  it("stays put when the other edge would cover as much of the area", () => {
    expect(nextGuideEdge("bottom", { x: 0, y: 0, width: 1000, height: 800 }, bands)).toBe("bottom");
  });
});

describe("showsGuide", () => {
  it("shows on the display holding the area held last, else where the pointer is", () => {
    expect(showsGuide(true, false, false)).toBe(true);
    expect(showsGuide(false, false, true)).toBe(true);
    expect(showsGuide(false, false, false)).toBe(false);
    expect(showsGuide(true, true, true)).toBe(false);
    expect(showsGuide(false, true, true)).toBe(false);
  });
});
