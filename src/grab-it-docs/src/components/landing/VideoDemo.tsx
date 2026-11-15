import { useState } from 'react';
import { sx } from './sx';

// The Recording and Video editor tour's demo: a looping preview that zooms in
// with easing, above a timeline with both ends trimmed and the zoom segment.
// The button pauses and plays it; under reduced motion it stays still.
export default function VideoDemo() {
	const [playing, setPlaying] = useState(true);
	const play = sx(`animation-play-state: ${playing ? 'running' : 'paused'}`);

	return (
		<div style={sx('border-radius: 16px; border: 1px solid var(--gi-hair); background: var(--gi-panel-2); box-shadow: 0 30px 60px rgb(0 0 0 / 25%); overflow: hidden')}>
			<div style={sx('padding: 28px; background: linear-gradient(135deg, #5b6cf0, #a36bf2 60%, #e07bd0)')}>
				<div
					role="img"
					aria-label="A recording plays, zooming in on a button with smooth easing and back out."
					style={sx('aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden; background: var(--gi-pop); box-shadow: 0 24px 50px rgb(0 0 0 / 35%)')}
				>
					<div
						className="gi-zoom"
						style={{ ...sx('height: 100%; padding: 5% 6%; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px'), ...play }}
					>
						<div style={sx('height: 10px; width: 40%; border-radius: 3px; background: var(--gi-text); opacity: .8')}></div>
						<div style={sx('display: flex; gap: 10px; flex: 1')}>
							<div style={sx('flex: 2; border-radius: 7px; background: var(--gi-surface); border: 1px solid var(--gi-border)')}></div>
							<div style={sx('flex: 1; display: flex; flex-direction: column; gap: 8px')}>
								<div style={sx('height: 7px; border-radius: 3px; background: var(--gi-border-strong)')}></div>
								<div style={sx('height: 7px; width: 70%; border-radius: 3px; background: var(--gi-border-strong)')}></div>
								<div style={sx('height: 24px; width: 64%; border-radius: 6px; background: var(--gi-accent); margin-top: 6px')}></div>
							</div>
						</div>
					</div>
				</div>
			</div>
			<div style={sx('padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 12px')}>
				<div style={sx('display: flex; align-items: center; gap: 12px')}>
					<button
						type="button"
						onClick={() => setPlaying((p) => !p)}
						aria-label={playing ? 'Pause' : 'Play'}
						style={sx('width: 44px; height: 44px; border-radius: 50%; border: 0; background: var(--gi-hue-video); color: #0b0c10; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-shadow: 0 0 24px var(--gi-hue-video-glow)')}
					>
						{playing ? (
							<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
								<rect x="6" y="5" width="4" height="14" rx="1" />
								<rect x="14" y="5" width="4" height="14" rx="1" />
							</svg>
						) : (
							<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
								<path d="M8 5v14l11-7z" />
							</svg>
						)}
					</button>
					<span style={sx('font-family: var(--gi-font-mono); font-size: 12px; color: var(--gi-muted)')}>
						<span className="gi-sr-only">Trimmed to </span>0:00.8 – 0:07.4 · 6.6 s
					</span>
				</div>
				<div
					aria-hidden="true"
					style={sx('position: relative; height: 36px; border-radius: 8px; background: repeating-linear-gradient(45deg, transparent, transparent 6px, var(--gi-hair) 6px, var(--gi-hair) 8px), var(--gi-panel)')}
				>
					<div style={sx('position: absolute; left: 10%; right: 12%; top: 0; bottom: 0; border-radius: 7px; background: linear-gradient(90deg, rgb(177 140 255 / 22%), rgb(177 140 255 / 10%)); border: 2px solid var(--gi-hue-video); box-sizing: border-box')}>
						<span style={sx('position: absolute; left: -2px; top: -2px; bottom: -2px; width: 9px; border-radius: 7px 0 0 7px; background: var(--gi-hue-video)')}></span>
						<span style={sx('position: absolute; right: -2px; top: -2px; bottom: -2px; width: 9px; border-radius: 0 7px 7px 0; background: var(--gi-hue-video)')}></span>
					</div>
					<div
						className="gi-head"
						style={{ ...sx('position: absolute; left: 12%; top: -6px; bottom: -6px; width: 2px; background: var(--gi-text); box-shadow: 0 0 10px var(--gi-text)'), ...play }}
					></div>
				</div>
				<div style={sx('position: relative; height: 32px')}>
					<div style={sx('position: absolute; left: 38%; width: 34%; top: 0; bottom: 0; border-radius: 8px; background: var(--gi-panel); border: 1px solid var(--gi-hue-video); display: flex; align-items: center; gap: 8px; padding: 0 9px; box-sizing: border-box; font-size: 12px; font-weight: 600; overflow: hidden; white-space: nowrap')}>
						<svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
							<path d="M1 13 C 12 13, 10 1, 17 1 S 22 13, 33 13" fill="none" stroke="var(--gi-hue-video)" strokeWidth="2" />
						</svg>
						Zoom 1.7× · ease in-out
					</div>
				</div>
			</div>
		</div>
	);
}
