// The landing page's background: a slow field of glass "captures" in WebGL.
// Each one is a rounded frame with faint UI lines; some carry the logo's crop
// corners, and some a mark from the app (an arrow, a numbered step, a
// highlight, a recording dot or the Library's search loupe). The camera glides
// down the field as the page scrolls and leans a little with the pointer.
// Frames and corners take the colour of the section on screen; the marks keep
// their feature's colour. Reduce Motion keeps the slow drift but drops the
// scroll and pointer camera moves.
import {
	AdditiveBlending,
	BufferGeometry,
	CatmullRomCurve3,
	CircleGeometry,
	Color,
	ConeGeometry,
	Fog,
	Group,
	Mesh,
	MeshBasicMaterial,
	NormalBlending,
	PerspectiveCamera,
	PlaneGeometry,
	RingGeometry,
	Scene,
	Shape,
	ShapeGeometry,
	TubeGeometry,
	Vector3,
	WebGLRenderer,
} from 'three';

type Hue = 'capture' | 'editor' | 'video' | 'library';
const HUES: Record<Hue, string> = { capture: '#8297ff', editor: '#ff8a7a', video: '#b18cff', library: '#4fd1c5' };
const HUES_LIGHT: Record<Hue, string> = { capture: '#4b62e3', editor: '#d9473a', video: '#7c4fe0', library: '#0d8f84' };

// A seeded random, so the field is the same on every visit.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const range = (a: number, b: number) => a + rand() * (b - a);

function roundedRect(w: number, h: number, r: number) {
	const s = new Shape();
	const x = -w / 2;
	const y = -h / 2;
	s.moveTo(x + r, y);
	s.lineTo(x + w - r, y);
	s.quadraticCurveTo(x + w, y, x + w, y + r);
	s.lineTo(x + w, y + h - r);
	s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	s.lineTo(x + r, y + h);
	s.quadraticCurveTo(x, y + h, x, y + h - r);
	s.lineTo(x, y + r);
	s.quadraticCurveTo(x, y, x + r, y);
	return s;
}

/** A rounded-rectangle outline `t` thick. */
function frameGeometry(w: number, h: number, r: number, t: number): BufferGeometry {
	const outer = roundedRect(w, h, r);
	outer.holes.push(roundedRect(w - 2 * t, h - 2 * t, Math.max(0.001, r - t)));
	return new ShapeGeometry(outer, 6);
}

/** One L-shaped crop corner, its corner at the origin, arms along +x and +y. */
function cornerGeometry(arm: number, t: number): BufferGeometry {
	const s = new Shape();
	s.moveTo(0, 0);
	s.lineTo(arm, 0);
	s.lineTo(arm, t);
	s.lineTo(t, t);
	s.lineTo(t, arm);
	s.lineTo(0, arm);
	s.lineTo(0, 0);
	return new ShapeGeometry(s);
}

const smoothstep = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

export function startField(canvas: HTMLCanvasElement) {
	let renderer: WebGLRenderer;
	try {
		renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
	} catch {
		canvas.remove();
		return;
	}
	const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const light = () => document.documentElement.dataset.theme === 'light';
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
	renderer.setClearColor(0x000000, 0);

	const scene = new Scene();
	const camera = new PerspectiveCamera(48, 1, 0.1, 140);
	camera.position.set(0, 0, 12);

	// Shared materials: the frame parts follow the section's colour, the marks keep their own.
	// Templates: every capture clones them, so each can fade on its own as the camera nears it.
	const mat = (dark: number, light: number, hue: Hue | null) => {
		const m = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: dark, depthWrite: false, blending: AdditiveBlending, fog: true });
		m.userData = { dark, light, hue };
		return m;
	};
	const frameMat = mat(0.26, 0.2, null);
	const cornerMat = mat(0.95, 0.8, null);
	const glassMat = mat(0.035, 0.05, null);
	const uiMat = mat(0.075, 0.08, null);
	const markMats: Record<Hue, MeshBasicMaterial> = {
		capture: mat(0.9, 0.8, 'capture'),
		editor: mat(0.85, 0.8, 'editor'),
		video: mat(0.9, 0.8, 'video'),
		library: mat(0.85, 0.8, 'library'),
	};
	const highlightMat = mat(0.26, 0.22, 'capture');

	const field = new Group();
	scene.add(field);
	const DEPTH = 96;
	const COUNT = 46;
	const items: { g: Group; spin: Vector3; phase: number; base: Vector3; mats: MeshBasicMaterial[] }[] = [];

	for (let i = 0; i < COUNT; i++) {
		const g = new Group();
		const w = range(1.5, 3.6);
		const h = w * range(0.56, 0.7);
		g.add(new Mesh(frameGeometry(w, h, 0.12, 0.016), frameMat));
		g.add(new Mesh(new ShapeGeometry(roundedRect(w, h, 0.12), 4), glassMat));
		// A title bar and a few lines of "content"
		const bar = new Mesh(new PlaneGeometry(w * 0.32, 0.05), uiMat);
		bar.position.set(-w * 0.28, h * 0.32, 0.001);
		g.add(bar);
		for (let l = 0; l < 3; l++) {
			const line = new Mesh(new PlaneGeometry(w * range(0.3, 0.7), 0.035), uiMat);
			line.position.set(-w * 0.12, h * (0.08 - l * 0.13), 0.001);
			g.add(line);
		}
		if (rand() < 0.42) {
			const arm = Math.min(w, h) * 0.2;
			const geo = cornerGeometry(arm, 0.035);
			const pad = 0.12;
			for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
				const c = new Mesh(geo, cornerMat);
				c.position.set(sx * (w / 2 + pad), sy * (h / 2 + pad), 0.01);
				c.scale.set(-sx, -sy, 1);
				g.add(c);
			}
		}
		const kind = rand();
		if (kind < 0.16) {
			// An arrow
			const curve = new CatmullRomCurve3([new Vector3(-w * 0.35, h * 0.3, 0.02), new Vector3(-w * 0.05, h * 0.22, 0.05), new Vector3(w * 0.18, -h * 0.05, 0.02)]);
			g.add(new Mesh(new TubeGeometry(curve, 24, 0.022, 6), markMats.editor));
			const head = new Mesh(new ConeGeometry(0.08, 0.2, 12), markMats.editor);
			const end = curve.getPoint(1);
			const dir = curve.getTangent(1);
			head.position.copy(end);
			head.rotation.z = Math.atan2(dir.y, dir.x) - Math.PI / 2;
			g.add(head);
		} else if (kind < 0.3) {
			// Numbered steps
			for (let s = 0; s < 2; s++) {
				const disc = new Mesh(new CircleGeometry(0.11, 24), markMats.editor);
				disc.position.set(w * (s ? 0.28 : -0.34), h * (s ? -0.2 : 0.18), 0.02);
				g.add(disc);
			}
		} else if (kind < 0.4) {
			// A highlight over a line
			const hl = new Mesh(new PlaneGeometry(w * 0.42, 0.11), highlightMat);
			hl.position.set(-w * 0.1, h * 0.08, 0.015);
			g.add(hl);
		} else if (kind < 0.52) {
			// A recording: a ring and a dot
			const ring = new Mesh(new RingGeometry(0.15, 0.18, 32), markMats.video);
			const dot = new Mesh(new CircleGeometry(0.08, 24), markMats.video);
			ring.position.set(w * 0.36, h * 0.3, 0.02);
			dot.position.copy(ring.position);
			g.add(ring, dot);
		} else if (kind < 0.62) {
			// The Library's search loupe
			const lens = new Mesh(new RingGeometry(0.14, 0.17, 32), markMats.library);
			const handle = new Mesh(new PlaneGeometry(0.035, 0.16), markMats.library);
			lens.position.set(w * 0.3, -h * 0.18, 0.02);
			handle.position.set(w * 0.3 + 0.16, -h * 0.18 - 0.16, 0.02);
			handle.rotation.z = Math.PI / 4;
			g.add(lens, handle);
		}

		// Keep a clear lane down the middle, where the text is.
		const side = rand() < 0.5 ? -1 : 1;
		const x = side * range(4.2, 12.5);
		const y = range(-6, 6);
		const z = 6 - (i / COUNT) * DEPTH + range(-1.5, 1.5);
		g.position.set(x, y, z);
		g.rotation.set(range(-0.25, 0.25), -side * range(0.15, 0.6), range(-0.12, 0.12));
		const mats: MeshBasicMaterial[] = [];
		const clones = new Map<MeshBasicMaterial, MeshBasicMaterial>();
		g.traverse((o) => {
			if (!(o instanceof Mesh)) return;
			const from = o.material as MeshBasicMaterial;
			let m = clones.get(from);
			if (!m) {
				m = from.clone();
				clones.set(from, m);
				mats.push(m);
			}
			o.material = m;
		});
		items.push({ g, spin: new Vector3(range(-1, 1), range(-1, 1), range(-1, 1)).multiplyScalar(0.06), phase: range(0, Math.PI * 2), base: g.position.clone(), mats });
		field.add(g);
	}

	// Colour: each section with data-hue sets the target as it crosses the middle of the screen.
	const target = new Color(HUES.capture);
	const current = new Color(HUES.capture);
	let hue: Hue = 'capture';
	const sections = [...document.querySelectorAll<HTMLElement>('[data-hue]')];
	const pickHue = () => {
		const mid = window.innerHeight / 2;
		for (const s of sections) {
			const r = s.getBoundingClientRect();
			if (r.top <= mid && r.bottom >= mid) {
				hue = s.dataset.hue as Hue;
				break;
			}
		}
	};

	const applyTheme = () => {
		const isLight = light();
		scene.fog = new Fog(isLight ? 0xffffff : 0x0c0d0f, 10, 46);
		for (const it of items)
			for (const m of it.mats) {
				m.blending = isLight ? NormalBlending : AdditiveBlending;
				if (m.userData.hue) m.color.set((isLight ? HUES_LIGHT : HUES)[m.userData.hue as Hue]);
				m.needsUpdate = true;
			}
	};
	applyTheme();
	new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

	const resize = () => {
		const w = window.innerWidth;
		const h = window.innerHeight;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		// Narrow screens see the field from further back, so the lane stays clear.
		camera.position.z = w < 760 ? 16 : 12;
		camera.updateProjectionMatrix();
	};
	resize();
	window.addEventListener('resize', resize);

	const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
	window.addEventListener('pointermove', (e) => {
		pointer.x = e.clientX / window.innerWidth - 0.5;
		pointer.y = e.clientY / window.innerHeight - 0.5;
	});

	let scrollP = 0;
	let smooth = 0;
	const onScroll = () => {
		const max = document.documentElement.scrollHeight - window.innerHeight;
		scrollP = max > 0 ? window.scrollY / max : 0;
		pickHue();
	};
	window.addEventListener('scroll', onScroll, { passive: true });
	onScroll();
	smooth = scrollP;

	let last = performance.now();
	let time = 0;
	const frame = (now: number) => {
		requestAnimationFrame(frame);
		if (document.hidden) return;
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		const still = motion.matches;
		time += dt;

		target.set((light() ? HUES_LIGHT : HUES)[hue]);
		current.lerp(target, 1 - Math.exp(-dt * 2.2));

		smooth += (scrollP - smooth) * (1 - Math.exp(-dt * 4));
		pointer.sx += (pointer.x - pointer.sx) * (1 - Math.exp(-dt * 2.5));
		pointer.sy += (pointer.y - pointer.sy) * (1 - Math.exp(-dt * 2.5));
		const travel = still ? 0 : smooth * (DEPTH - 30);
		camera.position.x = still ? 0 : pointer.sx * 1.2;
		camera.position.y = still ? 0 : -pointer.sy * 0.8;
		camera.position.z = (window.innerWidth < 760 ? 16 : 12) - travel;
		camera.lookAt(camera.position.x * 0.4, camera.position.y * 0.4, camera.position.z - 20);

		const isLight = light();
		for (const it of items) {
			// Fade out as the camera comes close, so nothing big sweeps over the text.
			const dz = camera.position.z - it.g.position.z;
			const fade = smoothstep(2.5, 10, dz);
			it.g.visible = fade > 0.01 && dz > 0;
			for (const m of it.mats) {
				m.opacity = (isLight ? m.userData.light : m.userData.dark) * fade;
				if (!m.userData.hue) m.color.copy(current);
			}
			it.g.position.y = it.base.y + Math.sin(time * 0.35 + it.phase) * 0.25;
			it.g.rotation.x += it.spin.x * dt * 0.3;
			it.g.rotation.y += Math.sin(time * 0.2 + it.phase) * it.spin.y * dt;
		}
		renderer.render(scene, camera);
	};
	requestAnimationFrame(frame);
	canvas.classList.add('is-on');
}
