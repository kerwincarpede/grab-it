// Scroll reveals for the landing page. Each [data-reveal] element
// gets .is-in the first time a fifth of it is on screen; the page's CSS decides
// what that looks like. Children marked [data-reveal-child] get a --i index so
// they can stagger. Under Reduce Motion the CSS turns every reveal into a short
// fade, so nothing moves.
export function startReveals(root: ParentNode = document) {
	const items = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
	items.forEach((el) => {
		el.querySelectorAll<HTMLElement>('[data-reveal-child]').forEach((child, i) => child.style.setProperty('--i', String(i)));
	});
	if (!('IntersectionObserver' in window)) {
		items.forEach((el) => el.classList.add('is-in'));
		return;
	}
	const io = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add('is-in');
				io.unobserve(entry.target);
			}
		},
		{ threshold: 0.2, rootMargin: '0px 0px -6% 0px' },
	);
	items.forEach((el) => io.observe(el));
	document.documentElement.classList.add('gi-reveals');
}

/** Calls `fn` with how far (0 to 1) `el` has travelled through the viewport, on every scroll frame. */
export function onScrollProgress(el: HTMLElement, fn: (p: number) => void, { start = 1, end = 0.35 } = {}) {
	let queued = false;
	const update = () => {
		queued = false;
		const r = el.getBoundingClientRect();
		const vh = window.innerHeight || 1;
		// 0 when the top of el is at `start` of the viewport, 1 when it reaches `end`.
		const p = (start * vh - r.top) / ((start - end) * vh);
		fn(Math.min(1, Math.max(0, p)));
	};
	const queue = () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(update);
	};
	window.addEventListener('scroll', queue, { passive: true });
	window.addEventListener('resize', queue);
	update();
}
