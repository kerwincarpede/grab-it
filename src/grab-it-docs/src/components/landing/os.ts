// Which desktop OS the visitor is on, for the download links. Phones and
// tablets get null: there is no Grab-it for them, so nothing is highlighted.
export type DesktopOs = 'windows' | 'macos' | 'linux';

export const osNames: Record<DesktopOs, string> = {
	windows: 'Windows',
	macos: 'macOS',
	linux: 'Linux',
};

export function detectOs(): DesktopOs | null {
	if (typeof navigator === 'undefined') return null;
	const hints = (navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } })
		.userAgentData;
	if (hints?.mobile) return null;
	const platform = `${hints?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`;
	if (/android|iphone|ipad|ipod/i.test(platform)) return null;
	// An iPad asking for the desktop site reports a Mac with a touch screen.
	if (/mac/i.test(platform)) return navigator.maxTouchPoints > 1 ? null : 'macos';
	if (/win/i.test(platform)) return 'windows';
	if (/linux|x11|cros/i.test(platform)) return 'linux';
	return null;
}
