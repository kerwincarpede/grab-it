import { useEffect, useRef } from "react";
import Konva from "konva";
import { Arrow, Circle, Ellipse, Group, Image as KonvaImage, Label, Line, Rect, Shape as KonvaShape, Tag, Text } from "react-konva";
import { FILL_OPACITY, SPOTLIGHT_DIM, type BlurShape, type Rect as Box, type Shape } from "./model";
import { contrastColor, normalizeRect, withAlpha, type NodeTransform } from "./tools";

interface ShapeNodeProps {
  shape: Shape;
  image: HTMLImageElement | null;
  /** The badge number for step shapes. */
  step?: number;
  /** Selectable and draggable (Select or a drawing tool is active). */
  editable: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, transform: NodeTransform) => void;
  onEditText: (id: string) => void;
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

function BlurNode({ shape, image, common }: { shape: BlurShape; image: HTMLImageElement | null; common: object }) {
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

/** One annotation as a Konva node, named by its id so the transformer can find it. */
export default function ShapeNode({ shape, image, step, editable, onSelect, onChange, onEditText }: ShapeNodeProps) {
  const common = {
    id: shape.id,
    name: "annotation",
    draggable: editable,
    listening: editable,
    onMouseDown: () => onSelect(shape.id),
    onTap: () => onSelect(shape.id),
    onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => {
      event.cancelBubble = true;
      onChange(shape.id, takeTransform(event.target, shape));
    },
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => onChange(shape.id, takeTransform(event.target, shape)),
  };

  switch (shape.type) {
    case "arrow":
      return (
        <Arrow
          {...common}
          points={shape.points}
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
    case "freehand":
      return (
        <Line
          {...common}
          points={shape.points}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          lineCap="round"
          lineJoin="round"
          tension={shape.type === "freehand" ? 0.4 : 0}
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
    case "blur":
      return <BlurNode shape={shape} image={image} common={common} />;
    case "spotlight":
      // Draws nothing itself (SpotlightDim shades around it); the clear fill takes clicks.
      return <Rect {...common} {...normalizeRect(shape)} fill="transparent" />;
    case "text":
      if (shape.background) {
        const padding = shape.fontSize * 0.35;
        // The label sizes its pill to the text. Offset by the padding, so x, y
        // stay the text's corner and toggling the background does not move it.
        return (
          <Label {...common} x={shape.x} y={shape.y} offsetX={padding} offsetY={padding} onDblClick={() => onEditText(shape.id)}>
            <Tag fill={shape.color} cornerRadius={shape.fontSize * 0.4} />
            <Text text={shape.text} fontSize={shape.fontSize} fontStyle="bold" fill={contrastColor(shape.color)} padding={padding} />
          </Label>
        );
      }
      return (
        <Text
          {...common}
          x={shape.x}
          y={shape.y}
          text={shape.text}
          fontSize={shape.fontSize}
          fontStyle="bold"
          fill={shape.color}
          onDblClick={() => onEditText(shape.id)}
        />
      );
    case "step": {
      const label = String(step ?? "");
      return (
        <Group {...common} x={shape.x} y={shape.y}>
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
      );
    }
  }
}
