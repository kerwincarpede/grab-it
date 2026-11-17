import { describe, expect, it } from "vitest";
import { renderCapture } from "./renderCapture";

describe("renderCapture", () => {
  it("refuses a sidecar it cannot read rather than giving the original", async () => {
    await expect(renderCapture(new ArrayBuffer(0), { version: 99, shapes: [] }, 1)).rejects.toThrow(/version/);
  });
});
