import { describe, expect, it } from "vitest";
import type { Annotations } from "../editor/model";
import {
  EXPORT_FORMATS,
  exportName,
  insertStep,
  mergeDescriptions,
  moveStep,
  numbered,
  readAnnotations,
  removeStep,
  savedSteps,
  toBase64,
  type GuideStep,
} from "./model";

const step = (capture: string, description = capture): GuideStep => ({
  capture,
  description,
  annotations: { version: 1, shapes: [], crop: null },
  exists: true,
});

describe("guide steps", () => {
  it("move up and down, ignoring moves out of range", () => {
    expect(moveStep(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveStep(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveStep(["a", "b"], 1, 2)).toEqual(["a", "b"]);
    expect(moveStep(["a", "b"], -1, 0)).toEqual(["a", "b"]);
  });

  it("delete one step from the guide only", () => {
    expect(removeStep(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });

  it("put a deleted step back in its place", () => {
    const steps = ["a", "b", "c"];
    for (let index = 0; index < steps.length; index++) {
      expect(insertStep(removeStep(steps, index), index, steps[index])).toEqual(steps);
    }
    expect(insertStep(["a"], 5, "b")).toEqual(["a", "b"]);
    expect(insertStep(["a"], -1, "b")).toEqual(["b", "a"]);
    expect(insertStep([], 0, "a")).toEqual(["a"]);
  });

  it("save each capture and its trimmed description in order", () => {
    expect(savedSteps([step("originals/b.png", " Click Save "), step("originals/a.png")])).toEqual([
      { capture: "originals/b.png", description: "Click Save" },
      { capture: "originals/a.png", description: "originals/a.png" },
    ]);
  });
});

describe("guide badges", () => {
  const doc: Annotations = {
    version: 1,
    shapes: [
      { id: "guide-step", type: "step", color: "#e5484d", x: 5, y: 5, radius: 20, number: 3 },
      { id: "mine", type: "step", color: "#e5484d", x: 9, y: 9, radius: 20 },
    ],
    crop: null,
  };

  it("take the step's place in the guide, leaving the user's own badges", () => {
    const shapes = numbered(doc, 1).shapes;
    expect(shapes[0]).toMatchObject({ number: 1 });
    expect(shapes[1]).not.toHaveProperty("number");
    expect(numbered(doc, 3)).toBe(doc);
  });

  it("read a sidecar, or start empty when it cannot be read", () => {
    expect(readAnnotations({ version: 1, shapes: doc.shapes }).shapes).toHaveLength(2);
    expect(readAnnotations(null).shapes).toEqual([]);
    expect(readAnnotations({ version: 9, shapes: [] }).shapes).toEqual([]);
  });
});

describe("descriptions arriving from the AI", () => {
  it("replace only those the user has not edited", () => {
    const steps = [step("a", "Click in Firefox"), step("b", "Click in Firefox")];
    const merged = mergeDescriptions(
      steps,
      [
        { capture: "a", description: "Click Save." },
        { capture: "b", description: "Open the menu." },
      ],
      new Set(["b"]),
    );
    expect(merged.map((entry) => entry.description)).toEqual(["Click Save.", "Click in Firefox"]);
  });
});

describe("exports", () => {
  it("offer the four formats with their extensions", () => {
    expect(EXPORT_FORMATS.map((entry) => entry.extension)).toEqual(["md", "html", "docx", "pptx"]);
    expect(exportName("Grab-it Guide 2026-01-02 03-04-05", "docx")).toBe("Grab-it Guide 2026-01-02 03-04-05.docx");
    expect(exportName("", "md" as never)).toBe("Grab-it Guide.md");
  });

  it("send images as base64", () => {
    expect(toBase64(new Uint8Array([137, 80, 78, 71]))).toBe("iVBORw==");
    expect(toBase64(new Uint8Array(0))).toBe("");
  });
});
