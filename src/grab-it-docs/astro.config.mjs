// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import starlight from '@astrojs/starlight';

// Served from GitHub Pages at https://kerwincarpede.github.io/grab-it/, so
// every link inside the site starts with the /grab-it base.
const section = (label, directory) => ({ label, items: [{ autogenerate: { directory } }] });

export default defineConfig({
	site: 'https://kerwincarpede.github.io',
	base: '/grab-it',
	// three.js, for the landing page's 3D field, is one ~550 kB chunk (~140 kB
	// gzipped). It loads only after the page is idle, so it never blocks.
	vite: { build: { chunkSizeWarningLimit: 600 } },
	integrations: [
		starlight({
			title: 'Grab-it',
			description: 'Screenshot it. Mark it up. Paste it anywhere. The fast, free screenshot tool for Windows, macOS and Linux.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/kerwincarpede/grab-it' },
			],
			editLink: {
				baseUrl: 'https://github.com/kerwincarpede/grab-it/edit/main/src/grab-it-docs/',
			},
			// The app's fonts and the site's colours, shared with the landing page.
			customCss: [
				'@fontsource-variable/instrument-sans',
				'@fontsource-variable/geist-mono',
				'./src/styles/tokens.css',
				'./src/styles/theme.css',
			],
			components: {
				SiteTitle: './src/components/starlight/SiteTitle.astro',
			},
			expressiveCode: {
				styleOverrides: {
					borderRadius: '0.75rem',
					borderColor: 'var(--gi-hair)',
					codeBackground: 'var(--gi-code-bg)',
				},
			},
			sidebar: [
				section('Get started', 'get-started'),
				section('Capture', 'capture'),
				section('Image editor', 'image-editor'),
				section('Recording', 'recording'),
				section('Video editor', 'video-editor'),
				section('Library', 'library'),
				section('AI', 'ai'),
				section('Reference', 'reference'),
				section('Contribute', 'contribute'),
			],
		}),
		react(),
	],
});
