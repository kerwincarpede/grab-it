import { useEffect, useState, type KeyboardEvent } from 'react';
import { sx } from './sx';

// The Capture tour's demo: All-in-one's mode toolbar over a frozen desktop.
// Click a mode, or press its number while the toolbar has focus.
type Mode = 'region' | 'window' | 'screen' | 'text' | 'colour' | 'record' | 'timer';

const modes: { id: Mode; key: string; label: string; hint: string }[] = [
	{ id: 'region', key: '1', label: 'Region', hint: 'Drag a region, or click a window.' },
	{ id: 'window', key: '2', label: 'Window', hint: 'Click a window to capture it.' },
	{ id: 'screen', key: '3', label: 'Screen', hint: 'Captures every monitor, just as it was frozen.' },
	{ id: 'text', key: '4', label: 'Text', hint: 'Drag over text or a code to copy it.' },
	{ id: 'colour', key: '5', label: 'Colour', hint: 'Click a pixel to copy its colour.' },
	{ id: 'record', key: '6', label: 'Record', hint: 'Choose what to record, then start recording.' },
	{ id: 'timer', key: '7', label: 'Timer', hint: 'Timer 5 s: pick the area, then wait for the count.' },
];

const reducedMotion = () =>
	typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function CaptureDemo() {
	const [mode, setMode] = useState<Mode>('region');
	const [count, setCount] = useState(5);
	const current = modes.find((m) => m.id === mode) ?? modes[0];

	// The Timer counts down from 5 and starts again, unless motion is reduced.
	useEffect(() => {
		setCount(5);
		if (mode !== 'timer' || reducedMotion()) return;
		const id = window.setInterval(() => setCount((c) => (c <= 1 ? 5 : c - 1)), 1000);
		return () => window.clearInterval(id);
	}, [mode]);

	const onToolbarKey = (event: KeyboardEvent) => {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const picked = modes.find((m) => m.key === event.key);
		if (!picked) return;
		event.preventDefault();
		setMode(picked.id);
		const button = event.currentTarget.querySelectorAll('button')[modes.indexOf(picked)];
		(button as HTMLButtonElement | undefined)?.focus();
	};

	return (
		<div style={sx('border-radius: 16px; border: 1px solid var(--gi-hair); background: var(--gi-panel-2); box-shadow: 0 30px 60px rgb(0 0 0 / 25%); overflow: hidden')}>
			<div role="toolbar" onKeyDown={onToolbarKey} aria-label="All-in-one modes" style={sx('display: flex; flex-wrap: wrap; gap: 4px; padding: 8px; border-bottom: 1px solid var(--gi-hair)')}>
				{modes.map((m) => (
					<button key={m.id} type="button" className="gi-chip" aria-pressed={m.id === mode} onClick={() => setMode(m.id)} aria-keyshortcuts={m.key} style={sx('padding: 0 12px')}>
						<span className="gi-chip-key">{m.key}</span>{m.label}
					</button>
				))}
			</div>
			<div style={sx('position: relative; aspect-ratio: 16 / 8.5; background: radial-gradient(90% 80% at 10% 0%, var(--gi-wall-a), transparent 60%), var(--gi-wall); overflow: hidden')}>
				<div style={sx('position: absolute; left: 8%; top: 12%; width: 50%; height: 66%; border-radius: 9px; background: var(--gi-pop); border: 1px solid var(--gi-border); box-shadow: 0 16px 30px rgb(0 0 0 / 25%)')}>
					<div style={sx('height: 18px; border-bottom: 1px solid var(--gi-border); background: var(--gi-chrome); border-radius: 9px 9px 0 0')}></div>
					<div style={sx('padding: 14px; display: flex; flex-direction: column; gap: 8px')}>
						<div style={sx('height: 9px; width: 60%; border-radius: 3px; background: var(--gi-text); opacity: .8')}></div>
						<div style={sx('height: 6px; width: 85%; border-radius: 3px; background: var(--gi-border-strong)')}></div>
						<div style={sx('height: 6px; width: 70%; border-radius: 3px; background: var(--gi-border-strong)')}></div>
						<div style={sx('height: 6px; width: 78%; border-radius: 3px; background: var(--gi-border-strong)')}></div>
					</div>
				</div>
				<div style={sx('position: absolute; left: 62%; top: 26%; width: 30%; height: 56%; border-radius: 9px; background: var(--gi-pop); border: 1px solid var(--gi-border); box-shadow: 0 16px 30px rgb(0 0 0 / 25%)')}>
					<div style={sx('height: 18px; border-bottom: 1px solid var(--gi-border); background: var(--gi-chrome); border-radius: 9px 9px 0 0')}></div>
					<div style={sx('margin: 14px; height: 50%; border-radius: 6px; background: linear-gradient(135deg, var(--gi-accent-soft), transparent), var(--gi-surface)')}></div>
				</div>
				<div style={sx('position: absolute; inset: 0; background: rgb(5 6 10 / 30%)')}></div>
				{mode === 'region' && (
					<div style={sx('position: absolute; left: 14%; top: 22%; width: 38%; height: 44%; border: 1.5px solid #97a9ff; box-shadow: 0 0 0 9999px rgb(5 6 10 / 30%), 0 0 28px rgb(130 151 255 / 45%); background: rgb(255 255 255 / 4%)')}>
						<span style={sx('position: absolute; left: 0; top: -26px; font-family: var(--gi-font-mono); font-size: 10.5px; background: #97a9ff; color: #0b0c10; padding: 2px 7px; border-radius: 5px')}>640 × 360</span>
					</div>
				)}
				{mode === 'window' && (
					<div style={sx('position: absolute; left: 62%; top: 26%; width: 30%; height: 56%; border: 2px solid #97a9ff; border-radius: 10px; box-sizing: border-box; background: rgb(130 151 255 / 12%); box-shadow: 0 0 30px rgb(130 151 255 / 45%)')}></div>
				)}
				{mode === 'screen' && (
					<div style={sx('position: absolute; inset: 6px; border: 2px solid #97a9ff; border-radius: 8px; box-shadow: inset 0 0 40px rgb(130 151 255 / 30%)')}></div>
				)}
				{mode === 'text' && (
					<div style={sx('position: absolute; left: 10%; top: 34%; width: 44%; height: 28%; border: 1.5px dashed #97a9ff; background: rgb(130 151 255 / 14%)')}>
						<span style={sx('position: absolute; left: 0; bottom: -32px; font-family: var(--gi-font-mono); font-size: 11px; background: var(--gi-float); color: #f1f2f5; padding: 4px 8px; border-radius: 6px')}>Copied 3 lines of text</span>
					</div>
				)}
				{mode === 'colour' && (
					<div style={sx('position: absolute; left: 68%; top: 38%; display: flex; align-items: center; gap: 10px')}>
						<div style={sx('width: 68px; height: 68px; border-radius: 50%; border: 3px solid #ffffff; box-shadow: 0 10px 30px rgb(0 0 0 / 45%), 0 0 30px var(--gi-glow); background: var(--gi-accent)')}></div>
						<span style={sx('font-family: var(--gi-font-mono); font-size: 12px; background: var(--gi-float); color: #f1f2f5; padding: 4px 8px; border-radius: 6px')}><span className="gi-only-dark">#8297FF</span><span className="gi-only-light">#4B62E3</span></span>
					</div>
				)}
				{mode === 'record' && (
					<div style={sx('position: absolute; left: 8%; top: 12%; width: 50%; height: 66%; border: 2px solid #ff5f57; border-radius: 9px; box-shadow: 0 0 30px rgb(255 95 87 / 40%)')}>
						<span style={sx('position: absolute; right: 8px; top: -30px; display: flex; align-items: center; gap: 6px; font-family: var(--gi-font-mono); font-size: 11px; background: var(--gi-float); color: #f1f2f5; padding: 4px 8px; border-radius: 6px')}><span className="gi-pulse" style={sx('width: 8px; height: 8px; border-radius: 50%; background: #ff5f57')}></span>REC 0:04</span>
					</div>
				)}
				{mode === 'timer' && (
					<div style={sx('position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 104px; height: 104px; border-radius: 50%; background: var(--gi-float); color: #f1f2f5; border: 2px solid #97a9ff; box-shadow: 0 0 40px rgb(130 151 255 / 45%); display: flex; align-items: center; justify-content: center; font-size: 44px; font-weight: 650')} aria-hidden="true">{count}</div>
				)}
				<p aria-live="polite" style={sx('position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); margin: 0; white-space: nowrap; font-size: 12.5px; background: var(--gi-float); color: #f1f2f5; padding: 6px 12px; border-radius: 8px; border: 1px solid rgb(255 255 255 / 10%)')}>{current.hint}</p>
			</div>
		</div>
	);
}
