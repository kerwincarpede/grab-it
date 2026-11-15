/**
 * The screen around a hovered window: the frozen image blurred and darkened
 * once, when it arrives, into a small canvas that CSS stretches over the
 * screen.
 *
 * A CSS `filter: blur()` on the full-resolution image looks the same, but the
 * browser blurs millions of pixels again every time the window cut out of it
 * moves, so hovering from window to window stuttered. Blurring a quarter-size
 * copy once costs a few milliseconds, and stretching it back up smooths it as
 * much as the filter did.
 */

/** CSS pixels per backdrop pixel. */
export const BACKDROP_SCALE = 4;
/**
 * Box blur radius in backdrop pixels. Three passes of a 5 px box at quarter
 * size come close to the 10 px Gaussian blur the overlay used to draw.
 */
export const BLUR_RADIUS = 2;
const BLUR_PASSES = 3;
/** Matches the old `saturate(0.9)` on the blur. */
const SATURATION = 0.9;
/** Laid over the blur, as `--overlay-around` was: near black at 52%. */
const AROUND = { red: 8, green: 9, blue: 12, alpha: 0.52 };

/**
 * One horizontal or vertical pass of a box blur over RGBA `data`, from `src`
 * into `dst`. Pixels past the edge repeat the edge pixel.
 */
function boxPass(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
) {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const step = horizontal ? 4 : width * 4;
  const span = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    const start = horizontal ? line * width * 4 : line * 4;
    const at = (i: number) => start + Math.min(Math.max(i, 0), length - 1) * step;
    for (let channel = 0; channel < 3; channel++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += src[at(i) + channel];
      for (let i = 0; i < length; i++) {
        dst[start + i * step + channel] = sum / span;
        sum += src[at(i + radius + 1) + channel] - src[at(i - radius) + channel];
      }
    }
    for (let i = 0; i < length; i++) dst[start + i * step + 3] = src[start + i * step + 3];
  }
}

/** Blurs RGBA `data` in place with repeated box blurs, a close stand-in for a Gaussian. */
export function blurPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number = BLUR_RADIUS,
  passes: number = BLUR_PASSES,
) {
  if (width <= 0 || height <= 0 || radius <= 0 || data.length < width * height * 4) return;
  const scratch = new Uint8ClampedArray(data.length);
  for (let pass = 0; pass < passes; pass++) {
    boxPass(data, scratch, width, height, radius, true);
    boxPass(scratch, data, width, height, radius, false);
  }
}

/** Desaturates RGBA `data` a little and lays the dark wash over it, in place. */
export function shadePixels(data: Uint8ClampedArray) {
  const keep = 1 - AROUND.alpha;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    // Rec. 709 luma, as CSS saturate() uses.
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const saturate = (value: number) => luma + (value - luma) * SATURATION;
    data[i] = saturate(red) * keep + AROUND.red * AROUND.alpha;
    data[i + 1] = saturate(green) * keep + AROUND.green * AROUND.alpha;
    data[i + 2] = saturate(blue) * keep + AROUND.blue * AROUND.alpha;
    data[i + 3] = 255;
  }
}

/**
 * Draws the blurred, darkened backdrop of `image` onto `canvas`, sized for a
 * viewport of `width` by `height` CSS pixels. False where there is no canvas
 * to draw with (jsdom, a lost context), so the caller can do without it.
 */
export function drawBackdrop(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  width: number,
  height: number,
): boolean {
  const w = Math.max(1, Math.ceil(width / BACKDROP_SCALE));
  const h = Math.max(1, Math.ceil(height / BACKDROP_SCALE));
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    canvas.width = w;
    canvas.height = h;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, w, h);
    const pixels = context.getImageData(0, 0, w, h);
    if (pixels.data.length !== w * h * 4) return false;
    blurPixels(pixels.data, w, h);
    shadePixels(pixels.data);
    context.putImageData(pixels, 0, 0);
    return true;
  } catch {
    // A tainted or lost canvas: no backdrop, the plain dim is shown instead.
    return false;
  }
}
