import { useEffect, useRef } from "react";
import Konva from "konva";
import { Arrow, Circle, Ellipse, Group, Image as KonvaImage, Label, Line, Rect, Shape as KonvaShape, Tag, Text } from "react-konva";
import { FILL_OPACITY, SPOTLIGHT_DIM, type BlurShape, type CalloutShape, type Rect as Box, type Shape, type TextShape, type TextStyle } from "./model";
import { calloutBubble, calloutOutline, calloutWedge, labelPadding, labelRadius } from "./callout";
import { roundedRectPath } from "./flatten";
import type { CaptureImage } from "./cut";
import { lensPath, magnifyLinePoints, magnifyScene } from "./magnify";
import { isIdentity, textSize, uprightTransform, type Orientation } from "./orient";
import { contrastColor, curvePoints, normalizeRect, textLook, textShadowColor, withAlpha, type NodeTransform } from "./tools";

interface ShapeNodeProps {
  shape: Shape;
  image: CaptureImage | null;
  /** The badge number for step shapes. */
  step?: number;
  /** Selectable and draggable (Select or a drawing tool is active). */
  editable: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, transform: NodeTransform) => void;
  /** Reports a drag in progress, so handles drawn elsewhere can follow the shape. */
  onMove?: (id: string, transform: NodeTransform) => void;
  onEditText: (id: string) => void;
  /**
   * How the capture is turned and mirrored. Text and step numbers undo it
   * about their centres, so they read upright on the same spot.
   */
  orientation?: Orientation;
}

/**
 * Reads a drag or resize off the node, then resets what the shape absorbs:
 * scale always, and position for point shapes, which are drawn at 0, 0 and
 * whose unchanged x/y props react-konva would not re-apply.
 */
function takeTransform(node: Konva.Node, shape: Shape): NodeTransform {
  const transform = { x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY() };
  node.scale({ x: 1, y: 1 });
  if ("points" in shape) node.position({ x: 0, y: 0 });
  return transform;
}

/**
 * The Konva props that draw Outline text (a contrasting stroke behind the
 * fill) and Shadow text (a soft drop shadow); none for Plain or Pill. Neither
 * moves the text, so x, y stay its corner whatever the style.
 */
function textLookProps(shape: Pick<TextShape, "color" | "fontSize" | "background" | "textStyle">): Partial<Konva.TextConfig> {
  switch (textLook(shape)) {
    case "outline":
      return {
        stroke: contrastColor(shape.color),
        strokeWidth: Math.max(2, shape.fontSize * 0.12),
        lineJoin: "round",
        fillAfterStrokeEnabled: true,
      };
    case "shadow":
      return {
        shadowColor: textShadowColor(shape.color),
        shadowOpacity: 0.6,
        shadowBlur: shape.fontSize * 0.3,
        shadowOffsetX: 0,
        shadowOffsetY: shape.fontSize * 0.08,
      };
    default:
      return {};
  }
}

function BlurNode({ shape, image, common }: { shape: BlurShape; image: CaptureImage | null; common: object }) {
  const ref = useRef<Konva.Image>(null);
  const rect = normalizeRect(shape);
  const smooth = shape.mode === "blur";
  useEffect(() => {
    const node = ref.current;
    if (!node || !image || rect.width < 1 || rect.height < 1) return;
    node.cache({ pixelRatio: 1 });
    node.getLayer()?.batchDraw();
  }, [image, rect.x, rect.y, rect.width, rect.height, shape.pixelSize, smooth]);
  if (!image) return null;
  return (
    <KonvaImage
      ref={ref}
      {...common}
      image={image}
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      crop={rect}
      filters={[smooth ? Konva.Filters.Blur : Konva.Filters.Pixelate]}
      pixelSize={shape.pixelSize}
      blurRadius={shape.pixelSize}
    />
  );
}

/**
 * The shade outside the spotlights. `dim` holds rectangles that do not
 * overlap, filled as one path so shared edges leave no seams.
 */
export function SpotlightDim({ dim }: { dim: Box[] }) {
  if (dim.length === 0) return null;
  return (
    <KonvaShape
      name="spotlight-dim"
      listening={false}
      fill={`rgba(0, 0, 0, ${SPOTLIGHT_DIM})`}
      sceneFunc={(ctx, node) => {
        ctx.beginPath();
        for (const rect of dim) ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.fillShape(node);
      }}
    />
  );
}

/** One line of annotation text, as Text and Callout draw it. */
interface LabelText {
  text: string;
  fontSize: number;
  color: string;
  /** On a rounded pill of the colour, in a contrasting text colour. */
  background?: boolean;
  /** Outlined or shadowed when there is no pill; only Text sets it. */
  textStyle?: TextStyle;
}

/**
 * Bold annotation text, in the colour (outlined or shadowed by its text
 * style) or on a pill. `props` go on the outer node. The pill is offset by its padding, so x, y stays the text's corner
 * and toggling the background does not move it.
 */
function labelNode(label: LabelText, props: object = {}) {
  const { text, fontSize, color, background } = label;
  if (background) {
    const padding = labelPadding(fontSize);
    return (
      <Label {...props} offsetX={padding} offsetY={padding}>
        <Tag fill={color} cornerRadius={labelRadius(fontSize)} />
        <Text text={text} fontSize={fontSize} fontStyle="bold" fill={contrastColor(color)} padding={padding} />
      </Label>
    );
  }
  return <Text {...props} text={text} fontSize={fontSize} fontStyle="bold" fill={color} {...textLookProps(label)} />;
}

/** Text that turns back about its centre, so it reads upright on the same spot; unchanged when nothing is turned. */
function uprightLabel(label: LabelText, upright: ReturnType<typeof uprightTransform> | null) {
  if (!upright) return labelNode(label);
  const box = textSize(label.text, label.fontSize);
  return (
    <Group x={box.width / 2} y={box.height / 2} offsetX={box.width / 2} offsetY={box.height / 2} {...upright}>
      {labelNode(label)}
    </Group>
  );
}

/**
 * Draws a callout's bubble and tail as one shape, in the bubble's own
 * pixels. Stroked first and filled over, the outline shows around both but
 * not where they join. While the callout is resized (its group scaled), the
 * tip stays on what it points at, as it will once the resize ends.
 */
function calloutScene(shape: CalloutShape, bubble: Box) {
  return (ctx: Konva.Context, node: Konva.Shape) => {
    const group = node.getParent();
    const sx = group?.scaleX() || 1;
    const sy = group?.scaleY() || 1;
    const origin = group && (sx !== 1 || sy !== 1) ? { x: group.x(), y: group.y() } : shape;
    const tip = { x: (shape.tail.x - origin.x) / sx - bubble.x, y: (shape.tail.y - origin.y) / sy - bubble.y };
    const own = { x: 0, y: 0, width: bubble.width, height: bubble.height };
    ctx.beginPath();
    roundedRectPath(ctx, own, labelRadius(shape.fontSize));
    const wedge = calloutWedge(own, tip, shape.fontSize);
    if (wedge.length > 0) {
      ctx.moveTo(wedge[0], wedge[1]);
      ctx.lineTo(wedge[2], wedge[3]);
      ctx.lineTo(wedge[4], wedge[5]);
      ctx.closePath();
    }
    ctx.strokeShape(node);
    ctx.fillShape(node);
  };
}

/** One annotation as a Konva node, named by its id so the transformer can find it. */
export default function ShapeNode({ shape, image, step, editable, onSelect, onChange, onMove, onEditText, orientation }: ShapeNodeProps) {
  const upright = orientation && !isIdentity(orientation) ? uprightTransform(orientation) : null;
  const common = {
    id: shape.id,
    name: "annotation",
    draggable: editable,
    listening: editable,
    onMouseDown: () => onSelect(shape.id),
    onTap: () => onSelect(shape.id),
    onDragMove: (event: Konva.KonvaEventObject<DragEvent>) => {
      const node = event.target;
      onMove?.(shape.id, { x: node.x(), y: node.y(), scaleX: 1, scaleY: 1 });
    },
    onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => {
      event.cancelBubble = true;
      onChange(shape.id, takeTransform(event.target, shape));
    },
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => onChange(shape.id, takeTransform(event.target, shape)),
  };

  switch (shape.type) {
    case "arrow":
      // A curve is one cubic segment; Konva aims the head along its last control point, the end tangent.
      return (
        <Arrow
          {...common}
          points={curvePoints(shape)}
          bezier={Boolean(shape.control)}
          stroke={shape.color}
          fill={shape.color}
          strokeWidth={shape.strokeWidth}
          pointerLength={shape.strokeWidth * 3 + 6}
          pointerWidth={shape.strokeWidth * 3 + 6}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(12, shape.strokeWidth)}
        />
      );
    case "line":
      return (
        <Line
          {...common}
          points={curvePoints(shape)}
          bezier={Boolean(shape.control)}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(12, shape.strokeWidth)}
        />
      );
    case "freehand":
      return (
        <Line
          {...common}
          points={shape.points}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          lineCap="round"
          lineJoin="round"
          tension={0.4}
          hitStrokeWidth={Math.max(12, shape.strokeWidth)}
        />
      );
    case "highlighter":
      return (
        <Line
          {...common}
          points={shape.points}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          opacity={0.4}
          lineCap="round"
          lineJoin="round"
          tension={0.4}
          globalCompositeOperation="multiply"
        />
      );
    case "rect": {
      const rect = normalizeRect(shape);
      return (
        <Rect
          {...common}
          {...rect}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          fill={shape.fill ? withAlpha(shape.color, FILL_OPACITY) : undefined}
        />
      );
    }
    case "ellipse": {
      const rect = normalizeRect(shape);
      // Drawn from the top-left corner so x/y/scale map like a rectangle.
      return (
        <Ellipse
          {...common}
          x={rect.x}
          y={rect.y}
          radiusX={rect.width / 2}
          radiusY={rect.height / 2}
          offsetX={-rect.width / 2}
          offsetY={-rect.height / 2}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          fill={shape.fill ? withAlpha(shape.color, FILL_OPACITY) : undefined}
        />
      );
    }
    case "magnify": {
      const rect = normalizeRect(shape);
      return (
        <>
          {shape.line && <Line name="magnify-line" points={magnifyLinePoints({ ...shape, ...rect })}
            stroke={shape.color} strokeWidth={shape.strokeWidth} lineCap="round" listening={false} />}
          <KonvaShape {...common} {...rect} fill="#ffffff" stroke={shape.color} strokeWidth={shape.strokeWidth}
            sceneFunc={magnifyScene(shape, image)}
            hitFunc={(ctx, node) => { lensPath(ctx, shape); ctx.fillStrokeShape(node); }} />
        </>
      );
    }
    case "blur":
      return <BlurNode shape={shape} image={image} common={common} />;
    case "spotlight":
      // Draws nothing itself (SpotlightDim shades around it); the clear fill takes clicks.
      return <Rect {...common} {...normalizeRect(shape)} fill="transparent" />;
    case "text":
      if (upright) {
        // The draggable group keeps x, y as the text's corner in capture
        // pixels; inside, the text turns back about its centre.
        return (
          <Group {...common} x={shape.x} y={shape.y} onDblClick={() => onEditText(shape.id)}>
            {uprightLabel(shape, upright)}
          </Group>
        );
      }
      return labelNode(shape, { ...common, x: shape.x, y: shape.y, onDblClick: () => onEditText(shape.id) });
    case "callout": {
      // Like text, x, y is the text's corner; the bubble sits around the
      // text as it shows, and the tail points at the tip in capture pixels.
      const bubble = calloutBubble(shape, upright ? (orientation?.rotation ?? 0) : 0);
      const filled = Boolean(shape.background);
      return (
        <Group {...common} x={shape.x} y={shape.y} onDblClick={() => onEditText(shape.id)}>
          <KonvaShape
            name="callout-bubble"
            {...bubble}
            fill={filled ? shape.color : "#ffffff"}
            stroke={filled ? undefined : shape.color}
            strokeWidth={calloutOutline(shape.fontSize)}
            sceneFunc={calloutScene(shape, bubble)}
          />
          {uprightLabel({ text: shape.text, fontSize: shape.fontSize, color: filled ? contrastColor(shape.color) : shape.color }, upright)}
        </Group>
      );
    }
    case "step": {
      const label = String(step ?? "");
      // The badge is centred on x, y, so turning it back about 0, 0 keeps it in place.
      return (
        <Group {...common} x={shape.x} y={shape.y}>
          <Group {...(upright ?? {})}>
            <Circle radius={shape.radius} fill={shape.color} stroke="#ffffff" strokeWidth={2} />
            <Text
              text={label}
              fontSize={shape.radius * 1.1}
              fontStyle="bold"
              fill="#ffffff"
              width={shape.radius * 2}
              height={shape.radius * 2}
              offsetX={shape.radius}
              offsetY={shape.radius}
              align="center"
              verticalAlign="middle"
            />
          </Group>
        </Group>
      );
    }
  }
}
