// Plays the hero demo. Each frame draws the whole scene for one second of the
// timeline, so pausing, replaying and jumping to a step are just "draw second
// t". The loop starts when the hero scrolls into view, waits while it is off
// screen, and holds the poster frame when motion is reduced. On a narrow stage
// the camera follows the action so the card and toolbar stay readable.
import { arrowGeometry, BARS } from './scene';
import {
	ARROW_FROM,
	ARROW_TO,
	bump,
	buildTimeline,
	clamp,
	ED,
	focusAt,
	focusKeys,
	H,
	IMG,
	inOut,
	lerp,
	out,
	pointerAt,
	pointerKeys,
	SEL,
	selectionAt,
	seg,
	steps,
	THUMB,
	type Timeline,
	W,
} from './timeline';

const T: Timeline = buildTimeline();
const KEYS = pointerKeys(T);
const FOCUS = focusKeys(T);
/** The reduced-motion poster: the marked-up image floating above the editor. */
const POSTER = T.clickCopy + 1.6;
const STEPS = steps(T, POSTER);

// The camera at rest (a three-quarter view) and after Copy.
const START = { rx: 16, ry: -20, tz: -460 };
const FINISH = { rx: 13, ry: 17, tz: -400 };
type Camera = typeof START;
const mix = (a: Camera, b: Camera, u: number): Camera => ({ rx: lerp(a.rx, b.rx, u), ry: lerp(a.ry, b.ry, u), tz: lerp(a.tz, b.tz, u) });

const px = (v: number) => `${Math.round(v * 10) / 10}px`;
const deg = (v: number) => `${v.toFixed(2)}deg`;

function setStyle(el: HTMLElement | SVGElement, key: 'opacity' | 'transform' | 'left' | 'top' | 'width' | 'height' | 'background', value: string) {
	if (el.style[key] !== value) el.style[key] = value;
}
const opacity = (el: HTMLElement | SVGElement, v: number) => setStyle(el, 'opacity', String(Math.round(clamp(v) * 1000) / 1000));
const transform = (el: HTMLElement | SVGElement, v: string) => setStyle(el, 'transform', v);
const toggle = (el: Element, name: string, on: boolean) => {
	if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
};

/** The colour under the pointer, for the magnifier's readout. */
function colourAt(x: number, y: number) {
	if (x < 140 || x > 1140 || y < 64 || y > 664) return '#3A3F74';
	if (y < 98) return '#2A2D35';
	const lx = x - 140;
	const ly = y - 98;
	if (lx >= 32 && lx <= 968 && ly >= 196 && ly <= 496) {
		const cx = lx - 32;
		const cy = ly - 196;
		for (let i = 0; i < BARS.length; i++) {
			const bx = 40 + i * 110;
			if (cx >= bx && cx <= bx + 86 && cy <= 262 && cy >= 262 - BARS[i] * 190) return i === 7 ? '#3B55E6' : '#B4C8FB';
		}
		return '#FFFFFF';
	}
	if (ly >= 84 && ly <= 180 && lx >= 32 && lx <= 968) return '#FFFFFF';
	if (ly >= 512 && ly <= 550) return '#E7E9EE';
	return '#F3F4F7';
}

function refs(stage: HTMLElement) {
	const one = <E extends Element = HTMLElement>(selector: string): E => {
		const el = stage.querySelector<E>(selector);
		if (!el) throw new Error(`Hero demo is missing ${selector}`);
		return el;
	};
	const all = <E extends Element = HTMLElement>(selector: string) => [...stage.querySelectorAll<E>(selector)];
	return {
		scaler: one('.scaler'),
		rig: one('.rig'),
		desk: one('.desk'),
		editorPlane: one('.edp'),
		pointer: one('.ptr'),
		ripple: one('.ripple'),
		hud: one('.hud'),
		overlay: one('.ov'),
		dims: all('.dim'),
		selection: one('.sel'),
		size: one('.size'),
		magnifier: one('.mag'),
		magnifierView: one('.mag-inner'),
		hex: one('.hex'),
		xy: one('.xy'),
		swatch: one('.mag-info i'),
		flash: one('.flash'),
		card: one('.qa'),
		thumb: one('.qa-thumb'),
		annotate: one('.qa-b.ann'),
		editorImage: one('.ed-img'),
		tools: all('.tl'),
		tip: one('.ed-tip'),
		toast: one('.ed-toast'),
		saved: one('.ed-status .saved'),
		copy: one('.ed-tb.copy'),
		arrow: one<SVGGElement>('.ed-svg .arw'),
		shaft: one<SVGPathElement>('.ed-svg .shaft'),
		head: one<SVGPolygonElement>('.ed-svg .head'),
		handles: one<SVGGElement>('.ed-svg .hdl'),
		handleDots: all<SVGCircleElement>('.ed-svg .hdl circle'),
		capSlab: one('.slab.cap'),
		capShadow: one('.cap-shadow'),
		finSlab: one('.slab.fin'),
		finShadow: one('.fin-shadow'),
	};
}
type Refs = ReturnType<typeof refs>;

/** Places a slab so its box covers (x, y) at scale s, raised z pixels towards the viewer. */
function placeSlab(el: HTMLElement, shadow: HTMLElement, x: number, y: number, s: number, z: number, rx: number, ry: number, o: number) {
	const dx = x + (960 * (s - 1)) / 2;
	const dy = y + (324 * (s - 1)) / 2;
	transform(el, `translate3d(${px(dx)},${px(dy)},${px(z)}) rotateX(${deg(rx)}) rotateY(${deg(ry)}) scale(${s.toFixed(4)})`);
	opacity(el, o);
	transform(shadow, `translate3d(${px(dx + z * 0.12)},${px(dy + z * 0.35)},1px) scale(${(s * (1 + z / 1400)).toFixed(4)})`);
	opacity(shadow, o * clamp(z / 160) * 0.6);
}

/** Draws the whole scene at second t. */
function draw(R: Refs, t: number) {
	const p = pointerAt(KEYS, t);

	// The pointer: a crosshair over the frozen screen and while drawing
	toggle(R.pointer, 'cross', (t >= T.ov && t < T.release) || (t >= T.clickTool + 0.25 && t < T.up + 0.25));
	transform(R.pointer, `translate3d(${px(p.x)},${px(p.y)},4px)`);
	opacity(R.pointer, 1);
	let ring = 0;
	for (const c of [T.drag[0], T.release, T.clickAnnotate, T.clickTool, T.draw[0], T.clickCopy]) {
		if (t >= c && t < c + 0.45) ring = seg(t, c, c + 0.45);
	}
	opacity(R.ripple, ring > 0 ? (1 - ring) * 0.9 : 0);
	transform(R.ripple, `translate3d(${px(p.x)},${px(p.y)},5px) scale(${(0.3 + ring * 0.9).toFixed(3)})`);

	// The key press
	opacity(R.hud, seg(t, T.key - 0.35, T.key - 0.15) * (1 - seg(t, T.key + 0.7, T.key + 0.95)));
	toggle(R.hud, 'down', t >= T.key && t < T.key + 0.22);

	// The frozen, dimmed screen. The selection is drawn from the pointer.
	const frozen = t >= T.ov && t < T.release;
	opacity(R.overlay, frozen ? out(seg(t, T.ov, T.ov + 0.18)) : 0);
	if (frozen) {
		const s = selectionAt(T, p, t);
		const box = (el: HTMLElement, x: number, y: number, w: number, h: number) => {
			setStyle(el, 'left', px(x));
			setStyle(el, 'top', px(y));
			setStyle(el, 'width', px(Math.max(0, w)));
			setStyle(el, 'height', px(Math.max(0, h)));
		};
		const [top, bottom, left, right] = R.dims;
		const dragging = t >= T.drag[0];
		if (!dragging) {
			box(top, 0, 0, W, H);
			for (const d of [bottom, left, right]) box(d, 0, 0, 0, 0);
		} else {
			box(top, 0, 0, W, s.y);
			box(bottom, 0, s.y + s.h, W, H - s.y - s.h);
			box(left, 0, s.y, s.x, s.h);
			box(right, s.x + s.w, s.y, W - s.x - s.w, s.h);
		}
		opacity(R.selection, dragging ? 1 : 0);
		opacity(R.size, dragging ? 1 : 0);
		box(R.selection, s.x, s.y, s.w, s.h);
		transform(R.size, `translate(${px(s.x)},${px(s.y - 28)})`);
		R.size.textContent = `${Math.round(s.w * 2)} × ${Math.round(s.h * 2)}`;
		// The magnifier sits below right of the pointer, or above it near the bottom
		const mx = p.x + 26 + 132 > W ? p.x - 26 - 132 : p.x + 26;
		const my = p.y + 26 + 160 > H - 6 ? p.y - 26 - 160 : p.y + 26;
		transform(R.magnifier, `translate(${px(mx)},${px(my)})`);
		transform(R.magnifierView, `translate(${px(66 - p.x * 8)},${px(66 - p.y * 8)}) scale(8)`);
		const hex = colourAt(p.x, p.y);
		if (R.hex.textContent !== hex) {
			R.hex.textContent = hex;
			setStyle(R.swatch, 'background', hex);
		}
		R.xy.textContent = `${Math.round(p.x * 2)}, ${Math.round(p.y * 2)}`;
	}
	opacity(R.flash, t >= T.release ? (1 - seg(t, T.release, T.release + 0.3)) * 0.45 : 0);

	// The Quick Access card
	const cardIn = out(seg(t, T.card[0], T.card[1]));
	opacity(R.card, cardIn * (1 - seg(t, T.editor[0], T.editor[0] + 0.22)));
	transform(R.card, `translateX(${px(lerp(40, 0, cardIn))})`);
	opacity(R.thumb, t >= T.card[1] && t < T.editor[0] ? 1 : 0);
	toggle(R.annotate, 'hot', t >= T.toAnnotate[1] - 0.08 && t < T.editor[0] + 0.2);
	transform(R.annotate, t >= T.clickAnnotate && t < T.clickAnnotate + 0.12 ? 'scale(.95)' : 'none');

	// The camera: three-quarter view, face-on for every drag and click, a lean
	// while the capture is in the air, and three-quarter again after Copy.
	let cam = mix(START, { rx: 0, ry: 0, tz: 0 }, inOut(seg(t, T.key - 0.1, T.corner[1])));
	cam.ry += Math.sin(t * 1.3) * 1.5 * (1 - seg(t, T.key - 0.1, T.corner[1]));
	const lean1 = bump(t, T.release - 0.05, T.card[1] + 0.35);
	const lean2 = bump(t, T.editor[0], T.editor[1] + 0.25);
	cam.rx += 7 * lean1 + 8 * lean2;
	cam.ry += -9 * lean1 + 16 * lean2;
	cam.tz += -120 * lean1 - 300 * lean2;
	if (t > T.clickCopy) cam = mix(mix(cam, FINISH, inOut(seg(t, T.clickCopy + 0.15, T.clickCopy + 1.3))), START, inOut(seg(t, T.end - 1, T.end)));
	transform(R.rig, `translate3d(0,0,${px(cam.tz)}) rotateX(${deg(cam.rx)}) rotateY(${deg(cam.ry)})`);

	// The capture lifts off the selection and lands in the card, then flies into the editor
	if (t >= T.release && t < T.card[1] + 0.02) {
		const lift = out(seg(t, T.release, T.release + 0.38));
		const fly = inOut(seg(t, T.release + 0.3, T.card[1]));
		const air = lift * (1 - fly);
		placeSlab(R.capSlab, R.capShadow, lerp(SEL.x, THUMB.x, fly), lerp(SEL.y, THUMB.y, fly), lerp(1, THUMB.s, fly), 170 * air + 2, -9 * air, 7 * air, 1);
	} else if (t >= T.editor[0] && t < T.editor[1] + 0.02) {
		const v = seg(t, T.editor[0], T.editor[1]);
		const fly = inOut(seg(v, 0.12, 1));
		const arc = Math.sin(Math.PI * fly);
		placeSlab(R.capSlab, R.capShadow, lerp(THUMB.x, IMG.x, fly), lerp(THUMB.y, IMG.y, fly) - 60 * arc, lerp(THUMB.s, 1, fly), 260 * arc + 70 * out(seg(v, 0, 0.2)) * (1 - fly) + 2, -10 * arc, 18 * arc, 1);
	} else {
		opacity(R.capSlab, 0);
		opacity(R.capShadow, 0);
	}

	// The desktop falls back and the editor swings in like a door
	const back = inOut(seg(t, T.editor[0], T.editor[1])) * (1 - inOut(seg(t, T.end - 1, T.end - 0.2)));
	transform(R.desk, `translateZ(${px(-380 * back)})`);
	opacity(R.desk, lerp(1, 0.3, back));
	const swing = out(seg(t, T.editor[0] + 0.15, T.editor[1] - 0.05));
	const reset = seg(t, T.end - 0.9, T.end - 0.35);
	transform(R.editorPlane, `translate3d(0,0,${px(lerp(-260, 1, swing))}) rotateY(${deg(lerp(70, 0, swing))})`);
	opacity(R.editorPlane, t < T.editor[0] + 0.15 ? 0 : seg(t, T.editor[0] + 0.15, T.editor[0] + 0.5) * (1 - reset));
	opacity(R.editorImage, t >= T.editor[1] ? 1 : 0);

	// The Arrow tool, and the arrow, whose head is the pointer while drawing
	const armed = t >= T.clickTool;
	R.tools.forEach((el, i) => {
		toggle(el, 'on', armed ? i === 2 : i === 0);
		toggle(el, 'hot', i === 2 && !armed && t >= T.toTool[1] - 0.1);
	});
	opacity(R.tip, seg(t, T.toTool[1] - 0.1, T.toTool[1] + 0.1) * (1 - seg(t, T.clickTool + 0.35, T.clickTool + 0.55)));
	const tip = t >= T.draw[1] ? ARROW_TO : t >= T.draw[0] ? ([p.x, p.y] as const) : null;
	if (tip && Math.hypot(tip[0] - ARROW_FROM[0], tip[1] - ARROW_FROM[1]) > 3) {
		const g = arrowGeometry(ARROW_FROM[0] - ED.x, ARROW_FROM[1] - ED.y, tip[0] - ED.x, tip[1] - ED.y);
		R.shaft.setAttribute('d', g.shaft);
		R.head.setAttribute('points', g.head);
		R.arrow.setAttribute('opacity', '1');
	} else R.arrow.setAttribute('opacity', '0');
	const selected = t >= T.up && t < T.clickCopy;
	R.handles.setAttribute('opacity', selected ? '1' : '0');
	if (selected) {
		const pts = [ARROW_FROM, [(ARROW_FROM[0] + ARROW_TO[0]) / 2, (ARROW_FROM[1] + ARROW_TO[1]) / 2], ARROW_TO];
		R.handleDots.forEach((d, i) => {
			d.setAttribute('cx', String(pts[i][0] - ED.x));
			d.setAttribute('cy', String(pts[i][1] - ED.y));
		});
	}
	opacity(R.saved, seg(t, T.up + 0.3, T.up + 0.5));

	// Copy, and the finished image floats free
	toggle(R.copy, 'hot', t >= T.toCopy[1] - 0.08);
	toggle(R.copy, 'press', t >= T.clickCopy && t < T.clickCopy + 0.14);
	opacity(R.toast, seg(t, T.clickCopy + 0.05, T.clickCopy + 0.25) * (1 - seg(t, T.clickCopy + 2.4, T.clickCopy + 2.7)));
	transform(R.toast, `translateX(-50%) translateY(${px(lerp(-8, 0, out(seg(t, T.clickCopy + 0.05, T.clickCopy + 0.3))))})`);
	if (t > T.clickCopy) {
		const up = out(seg(t, T.clickCopy + 0.1, T.clickCopy + 1.1));
		const down = inOut(seg(t, T.end - 1, T.end - 0.35));
		placeSlab(R.finSlab, R.finShadow, IMG.x, IMG.y, 1, 190 * up * (1 - down) + 2, -4 * up, -6 * up, 1 - down);
	} else {
		opacity(R.finSlab, 0);
		opacity(R.finShadow, 0);
	}
}

const PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

class HeroDemo {
	private R: Refs;
	private t = 0;
	private playing = false;
	private visible = false;
	private narrow = false;
	private stepButtons: HTMLButtonElement[];
	private stepBars: HTMLElement[];
	private playButton: HTMLButtonElement;

	constructor(
		root: HTMLElement,
		private stage: HTMLElement,
		reduced: boolean,
	) {
		this.R = refs(stage);
		const controls = root.querySelector<HTMLElement>('[data-hero-controls]');
		const play = root.querySelector<HTMLButtonElement>('[data-hero-play]');
		const replay = root.querySelector<HTMLButtonElement>('[data-hero-replay]');
		if (!controls || !play || !replay) throw new Error('Hero demo is missing its controls');
		this.playButton = play;
		this.stepButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-hero-step]')];
		this.stepBars = this.stepButtons.map((b) => b.querySelector<HTMLElement>('.gi-hd-bar') ?? b);
		controls.hidden = false;

		play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
		replay.addEventListener('click', () => {
			this.seek(0);
			this.play();
		});
		this.stepButtons.forEach((b, i) =>
			b.addEventListener('click', () => {
				// Playing, a step plays from its start; paused, it shows that step's frame.
				if (this.playing) this.seek(STEPS[i].from + 0.001);
				else this.seek(STEPS[i].still);
			}),
		);
		new ResizeObserver(() => this.layout()).observe(stage);
		new IntersectionObserver(([entry]) => (this.visible = entry.isIntersecting), { threshold: 0.2 }).observe(stage);
		this.layout();
		if (reduced) {
			this.pause();
			this.seek(POSTER);
		} else {
			this.seek(0);
			this.play();
		}
	}

	play() {
		this.playing = true;
		this.playButton.innerHTML = PAUSE;
		this.playButton.setAttribute('aria-label', 'Pause animation');
	}

	pause() {
		this.playing = false;
		this.playButton.innerHTML = PLAY;
		this.playButton.setAttribute('aria-label', 'Play animation');
	}

	seek(t: number) {
		this.t = clamp(t, 0, T.end - 0.001);
		this.render();
	}

	tick(dt: number) {
		if (!this.playing || !this.visible) return;
		this.t = (this.t + dt) % T.end;
		this.render();
	}

	private layout() {
		this.narrow = this.stage.clientWidth < 640;
		toggle(this.stage, 'is-narrow', this.narrow);
		this.render();
	}

	private render() {
		const cw = this.stage.clientWidth || 1;
		const ch = this.stage.clientHeight || 1;
		let k = cw / W;
		let x = 0;
		let y = (ch - H * k) / 2;
		if (this.narrow) {
			const f = focusAt(FOCUS, this.t);
			k *= f.z;
			x = clamp(cw / 2 - f.x * k, cw - W * k, 0);
			y = H * k > ch ? clamp(ch / 2 - f.y * k, ch - H * k, 0) : (ch - H * k) / 2;
		}
		transform(this.R.scaler, `translate(${px(x)},${px(y)}) scale(${k.toFixed(5)})`);
		draw(this.R, this.t);
		STEPS.forEach((s, i) => {
			const on = this.t >= s.from && this.t < s.to;
			const button = this.stepButtons[i];
			if (!button) return;
			toggle(button, 'is-on', on);
			if (on) button.setAttribute('aria-current', 'step');
			else button.removeAttribute('aria-current');
			transform(this.stepBars[i], `scaleX(${on ? seg(this.t, s.from, s.to).toFixed(4) : this.t >= s.to ? 1 : 0})`);
		});
	}
}

/** Starts every hero demo on the page. */
export function startHeroDemos() {
	const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const demos: HeroDemo[] = [];
	document.querySelectorAll<HTMLElement>('[data-hero-demo]').forEach((root) => {
		const stage = root.querySelector<HTMLElement>('[data-hero-stage]');
		if (stage) demos.push(new HeroDemo(root, stage, motion.matches));
	});
	if (!demos.length) return;
	motion.addEventListener('change', (e) =>
		demos.forEach((d) => {
			if (e.matches) {
				d.pause();
				d.seek(POSTER);
			} else d.play();
		}),
	);
	let last = performance.now();
	const frame = (now: number) => {
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		demos.forEach((d) => d.tick(dt));
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
}
