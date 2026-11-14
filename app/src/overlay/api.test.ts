import { describe, expect, it } from "vitest";
import { imageType } from "./api";

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe("imageType", () => {
  it("reads a BMP, as macOS sends the frozen screen", () => {
    expect(imageType(bytes(0x42, 0x4d, 0, 0))).toBe("image/bmp");
  });

  it("reads anything else as the PNG other platforms send", () => {
    expect(imageType(bytes(0x89, 0x50, 0x4e, 0x47))).toBe("image/png");
    expect(imageType(bytes(0x42))).toBe("image/png");
    expect(imageType(bytes())).toBe("image/png");
  });
});
