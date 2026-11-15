import { describe, expect, it } from "vitest";
import type { Backdrop, BackdropAspect } from "../editor/model";
import { MAX_EXPORT_SIDE, paintMask, recordingLayout } from "./layout";

const VIDEO = { width: 1920, height: 1080 };
const backdrop = (aspect: BackdropAspect): Backdrop => ({ fill: "ocean", padding: 64, radius: 36, radiusUnit: "pt", shadow: true, aspect });

describe("recordingLayout", () => {
  it("gives each shape its output size, at most full HD on the longer side", () => {
    const size = (aspect: BackdropAspect) => {
      const { width, height } = recordingLayout(VIDEO, backdrop(aspect));
      return [width, height];
    };
    expect(size("16:9")).toEqual([1920, 1080]);
    expect(size("1:1")).toEqual([1920, 1920]);
    expect(size("9:16")).toEqual([1080, 1920]);
    expect(size("4:3")).toEqual([1920, 1440]);
    // Auto pads evenly: 2048×1208 scaled to 1920 wide.
    expect(size("auto")).toEqual([1920, 1132]);
  });

  it("keeps every output even and the video inside it, centred", () => {
    for (const aspect of ["auto", "16:9", "4:3", "1:1", "9:16"] as const) {
      for (const video of [VIDEO, { width: 1000, height: 600 }, { width: 640, height: 1138 }]) {
        const layout = recordingLayout(video, backdrop(aspect));
        expect(layout.width % 2, `${aspect} ${video.width}`).toBe(0);
        expect(layout.height % 2).toBe(0);
        expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(MAX_EXPORT_SIDE);
        expect(layout.x + layout.videoWidth).toBeLessThanOrEqual(layout.width);
        expect(layout.y + layout.videoHeight).toBeLessThanOrEqual(layout.height);
        // Centred, give or take the rounding.
        expect(Math.abs(layout.x - (layout.width - layout.x - layout.videoWidth))).toBeLessThanOrEqual(4);
        expect(Math.abs(layout.y - (layout.height - layout.y - layout.videoHeight))).toBeLessThanOrEqual(4);
        // The video keeps its own shape.
        expect(layout.videoWidth / layout.videoHeight).toBeCloseTo(video.width / video.height, 1);
      }
    }
  });

  it("places a full-HD recording on 9:16 across the middle", () => {
    expect(recordingLayout(VIDEO, backdrop("9:16"))).toMatchObject({ width: 1080, height: 1920, x: 34, y: 676, videoWidth: 1012, videoHeight: 570 });
  });

  it("scales the corner radius and the shadow with the output", () => {
    const layout = recordingLayout(VIDEO, backdrop("9:16"));
    expect(layout.radius).toBeCloseTo(36 * (1920 / 3641), 3);
    expect(layout.shadow?.opacity).toBe(0.35);
    expect(recordingLayout(VIDEO, { ...backdrop("16:9"), shadow: false }).shadow).toBeNull();
  });

  it("leaves a recording without a backdrop as it is, unless it is too large", () => {
    expect(recordingLayout(VIDEO, null)).toEqual({ width: 1920, height: 1080, x: 0, y: 0, videoWidth: 1920, videoHeight: 1080, radius: 0, shadow: null });
    expect(recordingLayout({ width: 1280, height: 2560 }, null)).toMatchObject({ width: 960, height: 1920, videoWidth: 960, videoHeight: 1920 });
  });
});

describe("paintMask", () => {
  it("fills the video's rounded rectangle", () => {
    const calls: string[] = [];
    const ctx = {
      fillStyle: "",
      beginPath: () => calls.push("begin"),
      fill: () => calls.push("fill"),
      moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`),
      lineTo: () => undefined,
      arcTo: () => undefined,
      closePath: () => calls.push("close"),
    };
    paintMask(ctx, { width: 100, height: 100, x: 10, y: 20, videoWidth: 80, videoHeight: 60, radius: 8, shadow: null });
    expect(ctx.fillStyle).toBe("#ffffff");
    expect(calls).toEqual(["begin", "move 18,20", "close", "fill"]);
  });
});
