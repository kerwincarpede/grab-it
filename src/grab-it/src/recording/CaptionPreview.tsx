import { useLayoutEffect, useRef, useState } from "react";
import { paintCue, type CaptionStyle, type CueBox } from "./captions";

interface CaptionPreviewProps {
  text: string;
  style: CaptionStyle;
  /** The video box's size in output pixels, which the export paints the cue at. */
  width: number;
  height: number;
}

const share = (part: number, whole: number) => `${whole > 0 ? (part / whole) * 100 : 0}%`;

/**
 * The playhead's caption over the preview, painted as the export burns it
 * in and placed by the same shares of the video's box.
 */
export default function CaptionPreview({ text, style, width, height }: CaptionPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<CueBox | null>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    setBox(canvas ? paintCue(text, style, width, height, canvas) : null);
  }, [text, style, width, height]);
  return (
    <canvas
      ref={canvasRef}
      className="caption-preview"
      data-testid="caption-preview"
      role="img"
      aria-label={text}
      style={box ? { left: share(box.x, width), top: share(box.y, height), width: share(box.width, width), height: share(box.height, height) } : { visibility: "hidden" }}
    />
  );
}
