import { useEffect, useRef } from "react";
import { floatingPosition, imagePixelAt, toHex, type Point, type Size } from "./geometry";

/** Image pixels across the loupe; odd, so one pixel sits exactly in the centre. */
const GRID = 15;
/** CSS pixels each image pixel is drawn at. */
const ZOOM = 8;
const LENS = GRID * ZOOM;
/** The lens plus the readout under it; must match overlay.css. */
const PANEL: Size = { width: LENS, height: LENS + 46 };
/** Gap between the cursor and the loupe. */
const OFFSET = 20;
const CENTRE = (GRID - 1) / 2;
const UNKNOWN_COLOUR = "—";

/** A 2D context, or null where canvas is unavailable (jsdom, a lost context). */
function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d", { willReadFrequently: true });
  } catch {
    return null;
  }
}

/**
 * Draws the pixels around `centre` one-to-one onto the tiny canvas (CSS scales
 * it up with crisp pixels) and returns the centre pixel's colour.
 */
function drawLens(canvas: HTMLCanvasElement, image: HTMLImageElement, centre: Point) {
  const context = context2d(canvas);
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  // Past the image's edge there is nothing to draw, so show it as black.
  context.fillStyle = "#000";
  context.fillRect(0, 0, GRID, GRID);
  context.drawImage(image, centre.x - CENTRE, centre.y - CENTRE, GRID, GRID, 0, 0, GRID, GRID);
  try {
    const [red, green, blue] = context.getImageData(CENTRE, CENTRE, 1, 1).data;
    return toHex(red, green, blue);
  } catch {
    // A tainted canvas cannot be read; the magnified view still works.
    return null;
  }
}

interface LoupeProps {
  /** The frozen monitor, once loaded. */
  image: HTMLImageElement | null;
  /** The cursor, in CSS pixels. */
  pointer: Point;
  /** Image pixels per CSS pixel. */
  scale: number;
  viewport: Size;
}

/**
 * A magnifier that trails the cursor: the frozen image at pixel level, the
 * colour of the pixel under the cursor and the cursor's position in image
 * pixels.
 */
function Loupe({ image, pointer, scale, viewport }: LoupeProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const swatch = useRef<HTMLSpanElement>(null);
  const colour = useRef<HTMLSpanElement>(null);

  const size = image
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: viewport.width * scale, height: viewport.height * scale };
  const pixel = imagePixelAt(pointer, scale, size);
  const position = floatingPosition(pointer, PANEL, viewport, OFFSET);

  useEffect(() => {
    if (!canvas.current || !image) return;
    const hex = drawLens(canvas.current, image, { x: pixel.x, y: pixel.y });
    // Written straight to the DOM: the colour is only known after drawing, and
    // putting it in state would render the overlay twice per pointer move.
    if (colour.current) colour.current.textContent = hex ?? UNKNOWN_COLOUR;
    if (swatch.current) swatch.current.style.backgroundColor = hex ?? "transparent";
  }, [image, pixel.x, pixel.y]);

  return (
    <div
      className="overlay-loupe"
      data-testid="overlay-loupe"
      // A transform, not left/top, so following the cursor never causes layout.
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
    >
      <div className="overlay-loupe-lens">
        <canvas ref={canvas} className="overlay-loupe-canvas" width={GRID} height={GRID} />
        <span className="overlay-loupe-pixel" />
      </div>
      <div className="overlay-loupe-readout">
        <span className="overlay-loupe-colour">
          <span ref={swatch} className="overlay-loupe-swatch" />
          <span ref={colour} data-testid="overlay-colour">
            {UNKNOWN_COLOUR}
          </span>
        </span>
        <span data-testid="overlay-position">
          {pixel.x}, {pixel.y}
        </span>
      </div>
    </div>
  );
}

export default Loupe;
