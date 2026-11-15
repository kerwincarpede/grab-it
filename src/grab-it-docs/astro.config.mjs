// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Served from GitHub Pages at https://kerwincarpede.github.io/grab-it/, so
// every link inside the site starts with the /grab-it base.
const section = (label, directory) => ({ label, autogenerate: { directory } });

export default defineConfig({
	site: 'https://kerwincarpede.github.io',
	base: '/grab-it',
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
	],
});
