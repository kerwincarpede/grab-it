import type { CSSProperties } from 'react';

const cache = new Map<string, CSSProperties>();

// Turns a CSS declaration string into a React style object, so the demos can
// keep the design's declarations as written, like the Astro parts do. Each
// string is parsed once and the same object is returned after that.
export function sx(css: string): CSSProperties {
	const cached = cache.get(css);
	if (cached) return cached;
	const style: Record<string, string> = {};
	for (const declaration of css.split(';')) {
		const colon = declaration.indexOf(':');
		if (colon < 0) continue;
		const name = declaration.slice(0, colon).trim();
		const value = declaration.slice(colon + 1).trim();
		if (!name || !value) continue;
		const key = name.startsWith('--')
			? name
			: name.replace(/^-(webkit|moz|ms)-/, (_, vendor: string) => `${vendor[0].toUpperCase()}${vendor.slice(1)}-`).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
		style[key] = value;
	}
	cache.set(css, style as CSSProperties);
	return style as CSSProperties;
}
