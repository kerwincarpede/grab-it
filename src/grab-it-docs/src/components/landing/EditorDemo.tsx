import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { sx } from './sx';

// The Image editor tour's demo: pick Arrow, Box or Blur and drag on the
// picture to draw it, with a mouse, a pen or a finger. From the keyboard,
// focus the picture, move with the arrow keys and press Enter to start and
// again to finish. A, R and B pick the tools, Delete removes the last shape.
type Tool = 'arrow' | 'box' | 'blur';

interface Shape {
	tool: Tool;
	// Corners as fractions of the picture, so shapes keep their place at any width.
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

interface Point {
	x: number;
	y: number;
}

const tools: { id: Tool; label: string; key: string; name: string }[] = [
	{ id: 'arrow', label: 'Arrow', key: 'A', name: 'an arrow' },
	{ id: 'box', label: 'Box', key: 'R', name: 'a box' },
	{ id: 'blur', label: 'Blur', key: 'B', name: 'a blur' },
];

// The picture starts marked up as in the design: the API key blurred, the
// buttons boxed and an arrow pointing at them.
const starter: Shape[] = [
	{ tool: 'blur', x1: 0.3, y1: 0.41, x2: 0.6, y2: 0.52 },
	{ tool: 'box', x1: 0.04, y1: 0.74, x2: 0.34, y2: 0.92 },
	{ tool: 'arrow', x1: 0.59, y1: 0.61, x2: 0.384, y2: 0.832 },
];

const red = '#ff5a4a';
// The arrow layer's units: the picture is 16:9, so these keep the arrow's shape.
const W = 1600;
const H = 900;
const STEP = 0.02;
const BIG_STEP = 0.08;

const clamp = (n: number) => Math.min(1, Math.max(0, n));

function bigEnough(s: Shape) {
	const w = Math.abs(s.x2 - s.x1);
	const h = Math.abs(s.y2 - s.y1);
	return s.tool === 'arrow' ? Math.hypot(w * W, h * H) > 40 : w > 0.02 && h > 0.02;
}

function rect(s: Shape) {
	return {
		left: `${Math.min(s.x1, s.x2) * 100}%`,
		top: `${Math.min(s.y1, s.y2) * 100}%`,
		width: `${Math.abs(s.x2 - s.x1) * 100}%`,
		height: `${Math.abs(s.y2 - s.y1) * 100}%`,
	};
}

// A gently curved shaft with an open head, like the app's arrow.
function arrowPaths(s: Shape) {
	const ax = s.x1 * W;
	const ay = s.y1 * H;
	const bx = s.x2 * W;
	const by = s.y2 * H;
	const dx = bx - ax;
	const dy = by - ay;
	const cx = (ax + bx) / 2 - dy * 0.18;
	const cy = (ay + by) / 2 + dx * 0.18;
	const len = Math.hypot(dx, dy);
	const angle = Math.atan2(by - cy, bx - cx);
	const head = Math.min(70, Math.max(34, len * 0.3));
	const wing = (turn: number) =>
		`${bx - head * Math.cos(angle + turn)} ${by - head * Math.sin(angle + turn)}`;
	return {
		shaft: `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`,
		head: `M ${wing(0.5)} L ${bx} ${by} L ${wing(-0.5)}`,
	};
}

function ShapeView({ shape, draft = false }: { shape: Shape; draft?: boolean }) {
	if (shape.tool === 'box') {
		return (
			<div
				style={{
					...sx('position: absolute; box-sizing: border-box; border: 3px solid #ff5a4a; border-radius: 8px; pointer-events: none'),
					...rect(shape),
					opacity: draft ? 0.8 : 1,
				}}
			/>
		);
	}
	if (shape.tool === 'blur') {
		return (
			<div
				style={{
					...sx('position: absolute; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); background: rgb(140 140 160 / 20%); border-radius: 5px; pointer-events: none'),
					...rect(shape),
					outline: draft ? '1px dashed rgb(140 140 160 / 70%)' : undefined,
				}}
			/>
		);
	}
	const { shaft, head } = arrowPaths(shape);
	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			preserveAspectRatio="none"
			aria-hidden="true"
			style={sx('position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none')}
			opacity={draft ? 0.8 : 1}
		>
			<path d={shaft} fill="none" stroke={red} strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
			<path
				d={head}
				fill="none"
				stroke={red}
				strokeWidth="6"
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

export default function EditorDemo() {
	const hintId = useId();
	const [tool, setTool] = useState<Tool>('arrow');
	const [shapes, setShapes] = useState<Shape[]>(starter);
	const [draft, setDraft] = useState<Shape | null>(null);
	// The keyboard cursor, shown while the picture has keyboard focus.
	const [cursor, setCursor] = useState<Point | null>(null);
	const draftRef = useRef<Shape | null>(null);
	const current = tools.find((t) => t.id === tool) ?? tools[0];

	const updateDraft = (next: Shape | null) => {
		draftRef.current = next;
		setDraft(next);
	};

	const commit = () => {
		const done = draftRef.current;
		if (done && bigEnough(done)) setShapes((list) => [...list, done]);
		updateDraft(null);
	};

	const pointFrom = (event: PointerEvent<HTMLDivElement>): Point => {
		const box = event.currentTarget.getBoundingClientRect();
		return {
			x: clamp((event.clientX - box.left) / box.width),
			y: clamp((event.clientY - box.top) / box.height),
		};
	};

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		event.currentTarget.focus({ preventScroll: true });
		setCursor(null);
		const p = pointFrom(event);
		updateDraft({ tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y });
	};

	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const d = draftRef.current;
		if (!d || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
		const p = pointFrom(event);
		updateDraft({ ...d, x2: p.x, y2: p.y });
	};

	const onStageKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const moves: Record<string, [number, number]> = {
			ArrowLeft: [-1, 0],
			ArrowRight: [1, 0],
			ArrowUp: [0, -1],
			ArrowDown: [0, 1],
		};
		const here = cursor ?? { x: 0.5, y: 0.5 };
		if (event.key in moves) {
			event.preventDefault();
			const [mx, my] = moves[event.key];
			const step = event.shiftKey ? BIG_STEP : STEP;
			const next = { x: clamp(here.x + mx * step), y: clamp(here.y + my * step) };
			setCursor(next);
			const d = draftRef.current;
			if (d) updateDraft({ ...d, x2: next.x, y2: next.y });
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			setCursor(here);
			if (draftRef.current) commit();
			else updateDraft({ tool, x1: here.x, y1: here.y, x2: here.x, y2: here.y });
		} else if (event.key === 'Escape') {
			if (draftRef.current) {
				event.preventDefault();
				updateDraft(null);
			}
		} else if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			setShapes((list) => list.slice(0, -1));
		}
	};

	// A, R and B pick a tool anywhere in the demo.
	const onDemoKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const picked = tools.find((t) => t.key === event.key.toUpperCase());
		if (!picked) return;
		event.preventDefault();
		setTool(picked.id);
		const d = draftRef.current;
		if (d) updateDraft({ ...d, tool: picked.id });
	};

	const hint = draft && cursor
		? `Move with the arrow keys, then press Enter to finish ${current.name}.`
		: cursor
			? `Press Enter to start ${current.name}, move with the arrow keys, then press Enter again.`
			: `Drag on the picture to draw ${current.name}.`;

	return (
		<div
			onKeyDown={onDemoKey}
			style={sx('border-radius: 16px; border: 1px solid var(--gi-hair); background: var(--gi-panel-2); box-shadow: 0 30px 60px rgb(0 0 0 / 25%); overflow: hidden')}
		>
			<div
				role="toolbar"
				aria-label="Annotation tools"
				style={sx('display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 8px; border-bottom: 1px solid var(--gi-hair)')}
			>
				{tools.map((t) => (
					<button
						key={t.id}
						type="button"
						className="gi-chip gi-chip--editor"
						aria-pressed={t.id === tool}
						aria-keyshortcuts={t.key}
						onClick={() => setTool(t.id)}
						style={sx('padding: 0 14px')}
					>
						{t.label}
						<span className="gi-chip-key">{t.key}</span>
					</button>
				))}
				<span style={sx('flex: 1')}></span>
				<button
					type="button"
					onClick={() => {
						updateDraft(null);
						setShapes([]);
					}}
					style={sx('font: inherit; font-size: 13.5px; font-weight: 600; border-radius: 9px; padding: 0 14px; min-height: 44px; cursor: pointer; border: 1px solid var(--gi-hair); background: transparent; color: var(--gi-muted)')}
				>
					Clear
				</button>
			</div>
			<div style={sx('padding: 28px; background: linear-gradient(135deg, #ff8a7a, #f2b45a 55%, #f472b6)')}>
				<div
					className="gi-stage"
					role="application"
					tabIndex={0}
					aria-roledescription="drawing area"
					aria-label={`Account settings screenshot with ${shapes.length} ${shapes.length === 1 ? 'annotation' : 'annotations'}`}
					aria-describedby={hintId}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={commit}
					onPointerCancel={() => updateDraft(null)}
					onKeyDown={onStageKey}
					onKeyUp={(event) => {
						if (event.key === 'Tab' && !cursor) setCursor({ x: 0.5, y: 0.5 });
					}}
					onBlur={() => {
						setCursor(null);
						if (draftRef.current) updateDraft(null);
					}}
					style={sx('position: relative; aspect-ratio: 16 / 9; border-radius: 10px; background: var(--gi-pop); box-shadow: 0 24px 50px rgb(0 0 0 / 30%); overflow: hidden; cursor: crosshair')}
				>
					<div aria-hidden="true" style={sx('padding: 5% 6%; display: flex; flex-direction: column; gap: 12px')}>
						<div style={sx('font-weight: 650; font-size: 15px')}>Account settings</div>
						<div style={sx('display: flex; align-items: center; gap: 12px')}>
							<span style={sx('font-size: 12px; color: var(--gi-muted); width: 70px')}>Email</span>
							<span style={sx('font-family: var(--gi-font-mono); font-size: 12px; border: 1px solid var(--gi-border); border-radius: 6px; padding: 4px 8px')}>jane@example.com</span>
						</div>
						<div style={sx('display: flex; align-items: center; gap: 12px')}>
							<span style={sx('font-size: 12px; color: var(--gi-muted); width: 70px')}>API key</span>
							<span style={sx('font-family: var(--gi-font-mono); font-size: 12px; border: 1px solid var(--gi-border); border-radius: 6px; padding: 4px 8px')}>sk-live-7f3a92c1e04b</span>
						</div>
						<div style={sx('display: flex; align-items: center; gap: 12px')}>
							<span style={sx('font-size: 12px; color: var(--gi-muted); width: 70px')}>Plan</span>
							<span style={sx('font-size: 12px')}>Team · 5 seats</span>
						</div>
						<div style={sx('display: flex; gap: 8px; margin-top: 6px')}>
							<span style={sx('font-size: 12px; font-weight: 600; background: var(--gi-accent); color: var(--gi-on-accent); border-radius: 7px; padding: 7px 12px')}>Save changes</span>
							<span style={sx('font-size: 12px; border: 1px solid var(--gi-border); border-radius: 7px; padding: 7px 12px')}>Cancel</span>
						</div>
					</div>
					{shapes.map((shape, i) => (
						<ShapeView key={i} shape={shape} />
					))}
					{draft && <ShapeView shape={draft} draft />}
					{cursor && (
						<span
							aria-hidden="true"
							style={{
								...sx('position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; border: 2px solid #ffffff; box-shadow: 0 0 0 2px #ff5a4a, 0 2px 6px rgb(0 0 0 / 40%); pointer-events: none'),
								left: `${cursor.x * 100}%`,
								top: `${cursor.y * 100}%`,
							}}
						/>
					)}
				</div>
			</div>
			<p
				id={hintId}
				aria-live="polite"
				style={sx('margin: 0; padding: 11px 16px; font-size: 13px; color: var(--gi-muted); border-top: 1px solid var(--gi-hair)')}
			>
				{hint}
			</p>
		</div>
	);
}
