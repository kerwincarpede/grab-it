/** Mirrors `Shape` in src-tauri/src/record_frame.rs. */
export type FrameShape = "region" | "window" | "screen";

/** How the outline is drawn, as record_frame.rs puts it in the hash (`#/recordframe?shape=window&margin=6&protected=1`). */
export interface FrameOptions {
  shape: FrameShape;
  /** The room around the recorded area that the outline is drawn in, in CSS px. */
  margin: number;
  /** Whether the window is left out of the recording, so it may draw on the area itself. */
  protected: boolean;
}

const SHAPES: readonly FrameShape[] = ["region", "window", "screen"];

export function frameOptions(hash: string): FrameOptions {
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  const shape = SHAPES.find((each) => each === query.get("shape")) ?? "region";
  const margin = Number.parseFloat(query.get("margin") ?? "");
  return {
    shape,
    margin: Number.isFinite(margin) && margin >= 0 ? margin : 0,
    protected: query.get("protected") === "1",
  };
}
