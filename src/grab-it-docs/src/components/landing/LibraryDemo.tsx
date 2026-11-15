import { useId, useState } from 'react';
import { sx } from './sx';

// The Library and AI tour's demo: a mock library of sample captures, searched
// by the words inside each picture, its app and its tags, as the app does.
interface Sample {
	title: string;
	app: string;
	when: string;
	desc: string;
	tags: string[];
	// The text recognised inside the capture.
	text: string;
	thumb: string;
}

const samples: Sample[] = [
	{ title: 'Checkout error', app: 'Firefox', when: 'Today', desc: 'A checkout form showing a declined card error.', tags: ['bug', 'payments'], text: 'payment failed card declined error', thumb: 'linear-gradient(135deg, #f36b6b, #f0a05a)' },
	{ title: 'Q3 revenue chart', app: 'Sheets', when: 'Today', desc: 'A bar chart of revenue by month for July to September.', tags: ['report'], text: 'revenue q3 july august september', thumb: 'linear-gradient(135deg, #4b62e3, #6fb4f5)' },
	{ title: 'Build log', app: 'Terminal', when: 'Yesterday', desc: 'A failed build with a missing module error.', tags: ['bug', 'code'], text: 'error cannot find module build failed', thumb: 'linear-gradient(135deg, #2a2d34, #4a4f5a)' },
	{ title: 'Invoice #1042', app: 'Mail', when: 'Mon', desc: 'An invoice email with the amount due and a due date.', tags: ['finance'], text: 'invoice amount due 1042', thumb: 'linear-gradient(135deg, #2fb36f, #7bd3a4)' },
	{ title: 'Onboarding flow', app: 'Figma', when: 'Mon', desc: 'Three onboarding screens side by side.', tags: ['design'], text: 'welcome get started onboarding', thumb: 'linear-gradient(135deg, #a36bf2, #e07bd0)' },
	{ title: 'Router settings', app: 'Settings', when: 'Last week', desc: 'Wi-Fi settings with the network name and channel.', tags: ['home'], text: 'wifi network channel router', thumb: 'linear-gradient(135deg, #e0a73a, #f2d06b)' },
];

const suggestions = ['error', 'invoice', 'Figma', 'design'];

export default function LibraryDemo() {
	const inputId = useId();
	const [query, setQuery] = useState('');
	const q = query.trim().toLowerCase();
	const results = samples.filter(
		(s) => !q || `${s.title} ${s.app} ${s.text} ${s.tags.join(' ')}`.toLowerCase().includes(q),
	);

	return (
		<div style={sx('border-radius: 16px; border: 1px solid var(--gi-hair); background: var(--gi-panel-2); box-shadow: 0 30px 60px rgb(0 0 0 / 25%); overflow: hidden')}>
			<div role="search" style={sx('padding: 12px; border-bottom: 1px solid var(--gi-hair)')}>
				<label htmlFor={inputId} className="gi-sr-only">
					Search sample captures
				</label>
				<div
					className="gi-search"
					style={sx('display: flex; align-items: center; gap: 10px; border: 1px solid var(--gi-hair-strong); border-radius: 10px; background: var(--gi-panel); padding: 0 14px; min-height: 46px; box-shadow: 0 0 0 4px var(--gi-hue-library-soft)')}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--gi-hue-library)" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
						<circle cx="11" cy="11" r="7" />
						<path d="M20 20l-4-4" />
					</svg>
					<input
						id={inputId}
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search by the words inside a capture, app or tag"
						autoComplete="off"
						style={sx('flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--gi-text); font: inherit; font-size: 15px')}
					/>
				</div>
				<div style={sx('display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px')}>
					{suggestions.map((label) => (
						<button
							key={label}
							type="button"
							onClick={() => setQuery(label)}
							style={sx('font: inherit; font-size: 12.5px; border: 1px solid var(--gi-hair); background: transparent; color: var(--gi-muted); border-radius: 999px; padding: 0 12px; min-height: 32px; cursor: pointer')}
						>
							{label}
						</button>
					))}
				</div>
			</div>
			<p className="gi-sr-only" aria-live="polite">
				{results.length === 1 ? '1 capture' : `${results.length} captures`}
			</p>
			<div style={sx('padding: 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; min-height: 300px; align-content: start')}>
				{results.map((r) => (
					<article key={r.title} className="gi-lift" style={sx('border: 1px solid var(--gi-hair); border-radius: 12px; overflow: hidden; background: var(--gi-panel)')}>
						<div aria-hidden="true" style={{ ...sx('height: 84px; display: flex; align-items: flex-end; padding: 8px; box-sizing: border-box'), background: r.thumb }}>
							<div style={sx('height: 6px; width: 60%; border-radius: 3px; background: rgb(255 255 255 / 70%)')}></div>
						</div>
						<div style={sx('padding: 10px 11px 12px')}>
							<h4 style={sx('margin: 0; font-size: 14px; font-weight: 650; line-height: 1.3')}>{r.title}</h4>
							<p style={sx('margin: 3px 0 0; font-size: 12px; color: var(--gi-muted)')}>
								{r.app} · {r.when}
							</p>
							<p style={sx('margin: 8px 0 0; font-size: 12px; line-height: 1.45; color: var(--gi-muted)')}>
								<span style={sx('font-family: var(--gi-font-mono); font-size: 10px; font-weight: 600; color: var(--gi-hue-library); border: 1px solid var(--gi-hue-library); border-radius: 4px; padding: 0 4px; margin-right: 4px')}>
									AI
								</span>
								{r.desc}
							</p>
							<div style={sx('display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px')}>
								{r.tags.map((tag) => (
									<span key={tag} style={sx('font-size: 11px; background: var(--gi-fill); color: var(--gi-muted); border-radius: 5px; padding: 1px 6px')}>
										{tag}
									</span>
								))}
							</div>
						</div>
					</article>
				))}
				{results.length === 0 && (
					<p style={sx('grid-column: 1 / -1; margin: 40px 0; text-align: center; color: var(--gi-muted)')}>
						No captures match “{query.trim()}”.
					</p>
				)}
			</div>
		</div>
	);
}
