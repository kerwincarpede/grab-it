// The hero demo's timeline: when each step happens, where the pointer is at
// any moment, and where the phone-sized camera looks. Everything here is pure,
// so the scene can be drawn at any second, in any order. The selection, the
// arrow and the slab all read the pointer from pointerAt(), which is why the
// pointer can never drift away from what it is doing.

export const W = 1280;
export const H = 720;

export type Point = readonly [number, number];

/** The region dragged around the chart card, in the 1280×720 world. */
export const SEL = { x: 160, y: 282, w: 960, h: 324 } as const;
/** Where the capture sits in the editor, at 100%. */
export const IMG = { x: 186, y: 225 } as const;
/** The editor window's top-left corner. */
export const ED = { x: 40, y: 28 } as const;
/** The Quick Access card and its thumbnail. */
export const QA = { x: 944, y: 484 } as const;
export const THUMB = { x: QA.x + 14, y: QA.y + 14, s: 284 / 960 } as const;

/** The arrow runs from empty space above the bars to this week's bar. */
export const ARROW_FROM: Point = [IMG.x + 442, IMG.y + 82];
export const ARROW_TO: Point = [IMG.x + 812, IMG.y + 130];

const ANNOTATE: Point = [QA.x + 139, QA.y + 182];
const ARROW_TOOL: Point = [66, 220];
const COPY: Point = [988, 86];
const IDLE: Point = [720, 430];

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** How far t is through [a, b], from 0 to 1. */
export const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
export const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const out = (t: number) => 1 - Math.pow(1 - t, 3);
/** 0 at a, 1 halfway, 0 again at b. */
export const bump = (t: number, a: number, b: number) => Math.sin(Math.PI * seg(t, a, b));

/** The moments of the workflow, in seconds. */
export interface Timeline {
	key: number; // PrtSc goes down
	ov: number; // the screen freezes and dims
	corner: [number, number]; // pointer moves to the chart's corner
	drag: [number, number];
	release: number; // let go: captured
	card: [number, number]; // Quick Access card arrives
	toAnnotate: [number, number];
	clickAnnotate: number;
	editor: [number, number]; // the capture flies into the editor
	toTool: [number, number];
	clickTool: number;
	toStart: [number, number];
	draw: [number, number];
	up: number; // the arrow is let go
	toCopy: [number, number];
	clickCopy: number;
	end: number; // the loop starts again
}

export function buildTimeline(): Timeline {
	const release = 3.6;
	const card: [number, number] = [release + 0.62, release + 0.94];
	const clickAnnotate = card[1] + 0.95;
	const editor: [number, number] = [clickAnnotate + 0.05, clickAnnotate + 1.3];
	const c = editor[1];
	const clickCopy = c + 3.75;
	return {
		key: 0.7,
		ov: 0.8,
		corner: [1.0, 1.7],
		drag: [1.85, 3.35],
		release,
		card,
		toAnnotate: [card[1] + 0.3, card[1] + 0.9],
		clickAnnotate,
		editor,
		toTool: [c + 0.2, c + 0.7],
		clickTool: c + 0.75,
		toStart: [c + 0.9, c + 1.35],
		draw: [c + 1.45, c + 2.65],
		up: c + 2.7,
		toCopy: [c + 3.15, c + 3.7],
		clickCopy,
		end: clickCopy + 3.4,
	};
}

interface PointerKey {
	t: number;
	p: Point;
	/** How far the path bows to one side, in pixels, like a hand moving a mouse. */
	arc?: number;
}

export function pointerKeys(T: Timeline): PointerKey[] {
	const corner: Point = [SEL.x, SEL.y];
	const far: Point = [SEL.x + SEL.w, SEL.y + SEL.h];
	return [
		{ t: 0, p: IDLE },
		{ t: T.corner[0], p: IDLE },
		{ t: T.corner[1], p: corner, arc: 40 },
		{ t: T.drag[0], p: corner },
		{ t: T.drag[1], p: far },
		{ t: T.toAnnotate[0], p: far },
		{ t: T.toAnnotate[1], p: ANNOTATE, arc: 18 },
		{ t: T.toTool[0], p: ANNOTATE },
		{ t: T.toTool[1], p: ARROW_TOOL, arc: -60 },
		{ t: T.toStart[0], p: ARROW_TOOL },
		{ t: T.toStart[1], p: ARROW_FROM, arc: 30 },
		{ t: T.draw[0], p: ARROW_FROM },
		{ t: T.draw[1], p: ARROW_TO, arc: -22 },
		{ t: T.toCopy[0], p: ARROW_TO },
		{ t: T.toCopy[1], p: COPY, arc: 30 },
		{ t: T.end - 0.9, p: COPY },
		{ t: T.end, p: IDLE },
	];
}

export function pointerAt(keys: PointerKey[], t: number): { x: number; y: number } {
	if (t <= keys[0].t) return { x: keys[0].p[0], y: keys[0].p[1] };
	for (let i = 1; i < keys.length; i++) {
		const a = keys[i - 1];
		const b = keys[i];
		if (t <= b.t) {
			const u = inOut(seg(t, a.t, b.t));
			const dx = b.p[0] - a.p[0];
			const dy = b.p[1] - a.p[1];
			const len = Math.hypot(dx, dy) || 1;
			const off = Math.sin(Math.PI * u) * (b.arc ?? 0);
			return { x: a.p[0] + dx * u - (dy / len) * off, y: a.p[1] + dy * u + (dx / len) * off };
		}
	}
	const last = keys[keys.length - 1].p;
	return { x: last[0], y: last[1] };
}

/** The selection while dragging: from the corner to wherever the pointer is. */
export function selectionAt(T: Timeline, p: { x: number; y: number }, t: number) {
	if (t < T.drag[0]) return { x: p.x, y: p.y, w: 0, h: 0 };
	if (t < T.drag[1]) return { x: Math.min(SEL.x, p.x), y: Math.min(SEL.y, p.y), w: Math.abs(p.x - SEL.x), h: Math.abs(p.y - SEL.y) };
	return { ...SEL };
}

interface FocusKey {
	t: number;
	x: number;
	y: number;
	z: number;
}

/** On a narrow stage the camera follows the action: the point to centre and how far to zoom. */
export function focusKeys(T: Timeline): FocusKey[] {
	return [
		{ t: 0, x: 640, y: 360, z: 1 },
		{ t: T.ov, x: 640, y: 360, z: 1 },
		{ t: T.corner[1], x: 640, y: 444, z: 1.3 },
		{ t: T.release, x: 640, y: 444, z: 1.3 },
		{ t: T.card[1], x: 1090, y: 586, z: 2.2 },
		{ t: T.clickAnnotate + 0.1, x: 1090, y: 586, z: 2.2 },
		{ t: T.editor[1], x: 640, y: 360, z: 1.2 },
		{ t: T.toTool[1], x: 300, y: 270, z: 1.9 },
		{ t: T.clickTool + 0.2, x: 300, y: 270, z: 1.9 },
		{ t: T.toStart[1], x: 760, y: 330, z: 1.55 },
		{ t: T.draw[1], x: 800, y: 330, z: 1.55 },
		{ t: T.toCopy[1], x: 900, y: 230, z: 1.8 },
		{ t: T.clickCopy + 0.6, x: 900, y: 230, z: 1.8 },
		{ t: T.clickCopy + 1.4, x: 640, y: 360, z: 1.1 },
		{ t: T.end - 0.9, x: 640, y: 360, z: 1.1 },
		{ t: T.end, x: 640, y: 360, z: 1 },
	];
}

export function focusAt(keys: FocusKey[], t: number): FocusKey {
	if (t <= keys[0].t) return keys[0];
	for (let i = 1; i < keys.length; i++) {
		const a = keys[i - 1];
		const b = keys[i];
		if (t <= b.t) {
			const u = inOut(seg(t, a.t, b.t));
			return { t, x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) };
		}
	}
	return keys[keys.length - 1];
}

/** The steps shown under the stage: when each starts and ends, and the frame it holds when paused. */
export function steps(T: Timeline, poster: number) {
	return [
		{ from: 0, to: T.release, still: T.drag[1] + 0.12 },
		{ from: T.release, to: T.clickAnnotate, still: T.clickAnnotate - 0.25 },
		{ from: T.clickAnnotate, to: T.clickCopy, still: T.up + 0.4 },
		{ from: T.clickCopy, to: T.end, still: poster },
	];
}
