import { useEffect, useState } from 'react';
import { detectOs, type DesktopOs } from './os';
import { sx } from './sx';

// The download panel. Every card links to the latest release; the card for
// the visitor's OS gets the gradient border and a "Your computer" badge once
// the page has loaded and detected it.
const release = 'https://github.com/kerwincarpede/grab-it/releases/latest';

const systems: { id: DesktopOs; name: string; files: string }[] = [
	{ id: 'windows', name: 'Windows', files: 'Installer (.exe) and MSI · Windows 10 and 11' },
	{ id: 'macos', name: 'macOS', files: 'Disk image (.dmg) · Apple silicon and Intel' },
	{ id: 'linux', name: 'Linux', files: 'AppImage, .deb and .rpm · X11 and Wayland' },
];

const detectedCard = sx('color: var(--gi-text); border: 1px solid transparent; background: linear-gradient(var(--gi-panel-2), var(--gi-panel-2)) padding-box, linear-gradient(160deg, var(--gi-h1a), var(--gi-h1b), var(--gi-h1c)) border-box; box-shadow: 0 20px 50px var(--gi-glow)');
const otherCard = sx('color: var(--gi-text); border: 1px solid var(--gi-hair); background: var(--gi-glass)');

export default function Download() {
	const [os, setOs] = useState<DesktopOs | null>(null);
	useEffect(() => setOs(detectOs()), []);

	return (
		<section id="download" aria-labelledby="t-download" style={sx('max-width: 1200px; margin: 0 auto; padding: clamp(96px, 11vw, 160px) clamp(16px, 4vw, 40px) 0')}>
			<div style={sx('position: relative; border-radius: 30px; padding: 1px; background: linear-gradient(180deg, var(--gi-hair-strong), var(--gi-hair) 50%, var(--gi-hair-strong))')}>
				<div style={sx('position: relative; border-radius: 29px; overflow: hidden; background: radial-gradient(80% 90% at 50% 110%, var(--gi-glow), transparent 70%), var(--gi-panel); padding: clamp(48px, 7vw, 88px) clamp(20px, 5vw, 64px)')}>
					<div aria-hidden="true" style={sx('position: absolute; inset: 0; background-image: radial-gradient(var(--gi-dot) 1px, transparent 1px); background-size: 24px 24px; -webkit-mask-image: radial-gradient(ellipse 60% 70% at 50% 100%, #000, transparent 70%); mask-image: radial-gradient(ellipse 60% 70% at 50% 100%, #000, transparent 70%)')}></div>
					<div style={sx('position: relative; text-align: center; max-width: 680px; margin: 0 auto')}>
						<h2 id="t-download" style={sx('margin: 0; font-size: clamp(36px, 5.4vw, 68px); line-height: 1.02; letter-spacing: -0.04em; font-weight: 650')}>
							Your next screenshot is{' '}
							<span style={sx('background: linear-gradient(92deg, var(--gi-h1a), var(--gi-h1b), var(--gi-h1c)); -webkit-background-clip: text; background-clip: text; color: transparent')}>one key away.</span>
						</h2>
						<p style={sx('margin: 18px 0 0; color: var(--gi-muted); font-size: 18px')}>Free and open source. Pick the installer for your computer.</p>
					</div>
					<div style={sx('position: relative; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; margin-top: 48px')}>
						{systems.map((system) => {
							const detected = system.id === os;
							return (
								<a
									key={system.id}
									className="gi-lift"
									href={release}
									style={{ ...(detected ? detectedCard : otherCard), ...sx('text-decoration: none; border-radius: 18px; padding: 22px; display: flex; flex-direction: column; gap: 6px; min-height: 168px; box-sizing: border-box') }}
								>
									<span style={sx('display: flex; align-items: center; justify-content: space-between; gap: 8px')}>
										<span style={sx('font-size: 21px; font-weight: 650; letter-spacing: -0.01em')}>{system.name}</span>
										{detected && (
											<span style={sx('font-size: 11.5px; font-weight: 650; background: var(--gi-cta); color: var(--gi-on-cta); border-radius: 999px; padding: 3px 10px')}>Your computer</span>
										)}
									</span>
									<span style={sx('font-size: 14px; color: var(--gi-muted)')}>{system.files}</span>
									<span style={sx('margin-top: auto; padding-top: 14px; font-weight: 650; display: inline-flex; align-items: center; gap: 6px')}>
										Download{' '}
										<span aria-hidden="true" style={sx('color: var(--gi-accent)')}>→</span>
									</span>
								</a>
							);
						})}
					</div>
					<p style={sx('position: relative; margin: 28px 0 0; text-align: center; font-size: 14px; color: var(--gi-muted)')}>
						Then follow <a href="/grab-it/get-started/install/" style={sx('color: var(--gi-text)')}>Install</a>. Grab-it checks for updates by itself.
					</p>
				</div>
			</div>
		</section>
	);
}
