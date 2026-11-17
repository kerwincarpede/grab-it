import type Konva from "konva";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Group, Image as KonvaImage, Layer, Stage } from "react-konva";
import { backdropImage } from "./api";
import { flatten, measureBorders } from "./flatten";
import { groupTransform, orientedCanvas } from "./orient";
import { renderPlan } from "./render";
import { parseAnnotations } from "./sidecar";
import ShapeNode, { SpotlightDim } from "./ShapeNode";
import { spotlightDim, stepNumbers } from "./tools";

const noop = () => {};

/** Loads PNG or other image bytes as an image element. */
function loadImage(bytes: ArrayBuffer): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes]));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not load the capture"));
    };
    img.src = url;
  });
}

/** Waits for the next frame, so a freshly mounted stage has drawn. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Draws a capture with its saved edits as a PNG, the way the editor's Copy
 * and Export draw it: shapes and blurs, then crop, rotation and flips, the
 * backdrop (with its image fill), then the output scale. `png` is the
 * original's bytes and `annotations` its sidecar, as saved. The drawing
 * happens on a hidden stage that is removed afterwards. An unknown sidecar
 * version rejects, so the original is never passed off as the edited one.
 */
export async function renderCapture(png: ArrayBuffer, annotations: unknown, scaleFactor?: number | null): Promise<Uint8Array> {
  const doc = parseAnnotations(annotations);
  const image = await loadImage(png);
  const size = { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
  const plan = renderPlan(doc, size, scaleFactor);
  // A moved or unreadable backdrop image leaves the plain underlay showing, as in the editor.
  const fill = plan.backdropImage ? await backdropImage(plan.backdropImage).then(loadImage, () => null) : null;
  const borders = plan.measureBorders ? measureBorders(image, plan.crop, size, plan.orientation) : null;
  const shown = plan.blurredFill && plan.oriented ? (orientedCanvas(image, { x: 0, y: 0, ...size }, size, plan.orientation) ?? image) : image;
  const badges = stepNumbers(doc.shapes);
  const spotlights = doc.shapes.filter((shape) => shape.type === "spotlight");
  const dim = spotlightDim({ x: 0, y: 0, ...size }, spotlights);

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.position = "fixed";
  host.style.left = "-100000px";
  host.style.top = "0";
  host.style.pointerEvents = "none";
  document.body.appendChild(host);
  const root = createRoot(host);
  let layer: Konva.Layer | null = null;
  try {
    flushSync(() =>
      root.render(
        <Stage width={plan.stage.width} height={plan.stage.height} listening={false}>
          <Layer
            ref={(node) => {
              layer = node;
            }}
          >
            <Group {...groupTransform(size, plan.orientation)}>
              <KonvaImage image={image} />
              {spotlights.length > 0 && <SpotlightDim dim={dim} />}
              {doc.shapes.map((shape) => (
                <ShapeNode
                  key={shape.id}
                  shape={shape}
                  image={image}
                  step={badges.get(shape.id)}
                  editable={false}
                  orientation={plan.oriented ? plan.orientation : undefined}
                  onSelect={noop}
                  onChange={noop}
                  onEditText={noop}
                />
              ))}
            </Group>
          </Layer>
        </Stage>,
      ),
    );
    await nextFrame();
    const drawn = layer as Konva.Layer | null;
    if (!drawn) throw new Error("could not draw the capture");
    drawn.draw();
    return await flatten(drawn, doc, size, { scale: 1, x: 0, y: 0 }, "png", {
      scale: plan.captureScale,
      capture: { image: shown, area: shown === image ? plan.crop : plan.shownCrop },
      image: fill,
      borders,
    });
  } finally {
    root.unmount();
    host.remove();
  }
}
