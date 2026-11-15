---
title: Contribute
description: Build Grab-it from source, improve these docs and send a pull request.
sidebar:
  label: Overview
  order: 0
---

Bug reports, ideas and pull requests are all welcome. [Open an issue](https://github.com/kerwincarpede/grab-it/issues) to get started. Grab-it is made with Rust and [Tauri](https://tauri.app/), with a React + TypeScript frontend.

## Build Grab-it

[Developing Grab-it](https://github.com/kerwincarpede/grab-it/blob/main/docs/development.md) covers building it from source, running the checks, and how releases are made.

## Improve these docs

This site lives in [`src/grab-it-docs`](https://github.com/kerwincarpede/grab-it/tree/main/src/grab-it-docs) and is built with [Starlight](https://starlight.astro.build/). Every page has an **Edit page** link at the bottom. To preview your changes, run this from the repository root:

```sh
npm ci
cd src/grab-it-docs
npm run dev
```
