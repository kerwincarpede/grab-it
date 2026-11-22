import { useEffect, useRef, useState } from 'react';
import { sx } from './sx';

// One tour's animation: an SVG of the app at work, made by docs/assets/tours.py.
// It is shown as an <img>, so its ids and keyframes stay out of the page. To
// pause it, the SVG is shown again with every animation held at the current
// moment; to play, it carries on from there. The loop starts from the beginning
// when it first scrolls into view and waits while it is off screen. It plays
// even when motion is reduced; its pause button stays. The page frames it.

interface Props {
	src: string;
	alt: string;
}

export default function TourAnimation({ src, alt }: Props) {
	const box = useRef<HTMLDivElement>(null);
	const svg = useRef<{ text: string; loop: number } | null>(null);
	const [shown, setShown] = useState(src);
	const [playing, setPlaying] = useState(true);
	// Where the loop is: playing, the moment it was at second 0; paused, the second it is held at.
	const clock = useRef({ start: 0, held: 0 });
	const userPaused = useRef(false);
	const visible = useRef(false);

	const now = () => performance.now() / 1000;
	const position = () => {
		const s = svg.current;
		if (!s) return 0;
		return playing ? (now() - clock.current.start) % s.loop : clock.current.held;
	};

	// Shows the SVG at second `at`, running or held there.
	const show = async (at: number, running: boolean) => {
		const s = svg.current;
		if (!s) return;
		const style = `<style>*{animation-delay:-${at.toFixed(3)}s!important;animation-play-state:${running ? 'running' : 'paused'}!important}</style>`;
		const url = URL.createObjectURL(new Blob([s.text.replace('</svg>', `${style}</svg>`)], { type: 'image/svg+xml' }));
		// Decode before swapping, so the picture never blanks.
		const img = new Image();
		img.src = url;
		await img.decode().catch(() => undefined);
		if (running) clock.current.start = now() - at;
		else clock.current.held = at;
		setShown((old) => {
			if (old.startsWith('blob:')) URL.revokeObjectURL(old);
			return url;
		});
		setPlaying(running);
	};

	useEffect(() => {
		const el = box.current;
		if (!el) return;
		let cancelled = false;
		let started = false;
		const observer = new IntersectionObserver(async ([entry]) => {
			visible.current = entry.isIntersecting;
			if (!svg.current) {
				const text = await fetch(src).then((r) => r.text());
				if (cancelled) return;
				const num = (name: string) => Number(new RegExp(`data-${name}="([\\d.]+)"`).exec(text)?.[1] ?? 0);
				svg.current = { text, loop: num('loop') || 10 };
			}
			if (cancelled) return;
			if (!started) {
				started = true;
				if (entry.isIntersecting) await show(0, true);
				return;
			}
			if (userPaused.current) return;
			// Off screen it waits where it is, and carries on when it is back.
			if (entry.isIntersecting) await show(clock.current.held, true);
			else await show((now() - clock.current.start) % svg.current.loop, false);
		}, { threshold: 0.35 });
		observer.observe(el);
		return () => {
			cancelled = true;
			observer.disconnect();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [src]);

	const toggle = () => {
		const at = position();
		userPaused.current = playing;
		void show(at, !playing);
	};

	return (
		<div
			ref={box}
			style={sx('position: relative; border-radius: inherit; background: #0d1016; overflow: hidden; aspect-ratio: 720 / 450')}
		>
			<img src={shown} alt={alt} width={720} height={450} loading="lazy" decoding="async" style={sx('display: block; width: 100%; height: 100%')} />
			<button type="button" className="gi-tour-toggle" onClick={toggle} aria-label={playing ? 'Pause animation' : 'Play animation'}>
				{playing ? (
					<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<rect x="6" y="5" width="4" height="14" rx="1" />
						<rect x="14" y="5" width="4" height="14" rx="1" />
					</svg>
				) : (
					<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path d="M8 5v14l11-7z" />
					</svg>
				)}
			</button>
		</div>
	);
}
