import { describe, expect, it } from "vitest";
import { applySuggestions, fitLabel, pendingSuggestions, pointThroughCuts, suggestedMessage, suggestionShapes, type AiSuggestion, type SuggestionStyles } from "./aiAnnotate";
import { commit, initHistory, undo } from "./history";
import { emptyAnnotations, type Cut } from "./model";
import { parseAnnotations, serializeAnnotations } from "./sidecar";

const STYLES: SuggestionStyles = {
  rect: { color: "#e5484d", strokeWidth: 4 },
  arrow: { color: "#0090ff", strokeWidth: 6, arrowStyle: "classic" },
  text: { color: "#30a46c", strokeWidth: 4, fontSize: 20, background: true },
};

const SUGGESTIONS: AiSuggestion[] = [
  { kind: "rect", x: 394, y: 594, width: 252.4, height: 52 },
  { kind: "arrow", x1: 304, y1: 504, x2: 520, y2: 592 },
  { kind: "text", x: 100, y: 138, text: "Test connection" },
];

/** A horizontal strip cut out between y 300 and 400, joined straight. */
const CUT: Cut = { axis: "y", start: 300, end: 400, edge: "straight" };

describe("suggestionShapes", () => {
  it("draws each suggestion with the matching tool's style", () => {
    const [rect, arrow, text] = suggestionShapes(pendingSuggestions(SUGGESTIONS), STYLES, undefined, { width: 1200, height: 1000 });
    expect(rect).toEqual(expect.objectContaining({ type: "rect", color: "#e5484d", strokeWidth: 4, x: 394, y: 594, width: 252, height: 52 }));
    expect(arrow).toEqual(expect.objectContaining({ type: "arrow", color: "#0090ff", strokeWidth: 6, points: [304, 504, 520, 592] }));
    expect(arrow).not.toHaveProperty("arrowStyle");
    expect(text).toEqual(expect.objectContaining({ type: "text", color: "#30a46c", fontSize: 20, x: 100, y: 138, text: "Test connection", background: true }));
    expect(new Set([rect.id, arrow.id, text.id]).size).toBe(3);
  });

  it("moves suggestions on the original capture through its cuts", () => {
    const [rect, arrow, text] = suggestionShapes(pendingSuggestions(SUGGESTIONS), STYLES, [CUT], { width: 1200, height: 900 });
    expect(rect).toEqual(expect.objectContaining({ y: 494 }));
    expect(arrow).toEqual(expect.objectContaining({ points: [304, 404, 520, 492] }));
    expect(text).toEqual(expect.objectContaining({ y: 138 }));
  });

  it("drops a box the cut took away and coordinates that are not numbers", () => {
    const inside: AiSuggestion[] = [
      { kind: "rect", x: 10, y: 320, width: 50, height: 40 },
      { kind: "rect", x: null, y: 10, width: 50, height: 40 },
      { kind: "arrow", x1: 10, y1: 320, x2: 12, y2: 380 },
    ];
    expect(suggestionShapes(pendingSuggestions(inside), STYLES, [CUT], { width: 1200, height: 900 })).toEqual([]);
  });
});

describe("fitLabel", () => {
  it("keeps a label inside the capture by its estimated size", () => {
    // 10 characters at 20px: about 120 by 26.
    expect(fitLabel({ x: 1150, y: 990 }, "0123456789", 20, { width: 1200, height: 1000 })).toEqual({ x: 1080, y: 974 });
    expect(fitLabel({ x: 5, y: 5 }, "Hi", 20, { width: 1200, height: 1000 })).toEqual({ x: 5, y: 5 });
    expect(fitLabel({ x: 5, y: 5 }, "Hi", 20, null)).toEqual({ x: 5, y: 5 });
  });
});

describe("pointThroughCuts", () => {
  it("moves a point past a strip back by the strip's height", () => {
    expect(pointThroughCuts({ x: 5, y: 450 }, [CUT])).toEqual({ x: 5, y: 350 });
    expect(pointThroughCuts({ x: 5, y: 200 }, [CUT])).toEqual({ x: 5, y: 200 });
  });
});

describe("applySuggestions", () => {
  it("adds every shape as one undo step, and reopens them from the sidecar", () => {
    const shapes = suggestionShapes(pendingSuggestions(SUGGESTIONS), STYLES, undefined, { width: 1200, height: 1000 });
    const start = emptyAnnotations();
    const history = commit(initHistory(start), applySuggestions(start, shapes));
    expect(history.present.shapes).toHaveLength(3);
    expect(undo(history).present.shapes).toHaveLength(0);

    // Accepted suggestions are ordinary shapes: saved and read back unchanged.
    const reopened = parseAnnotations(JSON.parse(JSON.stringify(serializeAnnotations(history.present))));
    expect(reopened.shapes).toEqual(history.present.shapes);
  });

  it("leaves the document alone with nothing to add", () => {
    const doc = emptyAnnotations();
    expect(applySuggestions(doc, [])).toBe(doc);
  });
});

describe("suggestedMessage", () => {
  it("says how many were found and left out", () => {
    expect(suggestedMessage(1, 0, "Codex")).toBe("Codex suggested 1 shape.");
    expect(suggestedMessage(0, 0, "qwen3-vl:4b")).toBe("qwen3-vl:4b suggested nothing to add.");
    expect(suggestedMessage(2, 3, "Codex")).toBe("Codex suggested 2 shapes. 3 more could not be placed, so they were left out.");
  });
});
