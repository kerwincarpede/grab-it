---
title: Contribute
description: Report a bug, build Grab-it from source, improve these docs and send a pull request.
sidebar:
  label: Overview
  order: 0
---

Bug reports, ideas and pull requests are all welcome. Grab-it is made with Rust and [Tauri 2](https://tauri.app/), with a React + TypeScript frontend, and is [MIT licensed](https://github.com/kerwincarpede/grab-it/blob/main/LICENSE). The text-recognition models it ships come from [ocrs](https://github.com/robertknight/ocrs-models) and are under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (see [their notice](https://github.com/kerwincarpede/grab-it/blob/main/src/grab-it/src-tauri/ocr-models/LICENSE.md)). The face-detection model behind Blur private details is [UltraFace](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) RFB-320, under the MIT licence (see [its notice](https://github.com/kerwincarpede/grab-it/blob/main/src/grab-it/src-tauri/face-models/LICENSE.md)). The emoji stamps are from [Noto Emoji](https://github.com/googlefonts/noto-emoji), under the Apache License 2.0 (see [its notice](https://github.com/kerwincarpede/grab-it/blob/main/src/grab-it/src/editor/stamps/LICENSE)).

## Report a bug or suggest an idea

[Open an issue](https://github.com/kerwincarpede/grab-it/issues/new). For a bug, say which system you're on (Windows, macOS, or Linux with X11 or Wayland), which Grab-it version (it's at the bottom of the Grab-it window's sidebar), what you did, and what happened. Starting Grab-it from a terminal shows its messages, which help too.

## Build Grab-it

[Developing Grab-it](https://github.com/kerwincarpede/grab-it/blob/main/docs/development.md) covers building it from source, running the checks, and how releases are made. In short, from the repository root:

```sh
npm ci
cd src/grab-it
npm run tauri dev
```

The repository is an npm workspace:

| Folder | What's in it |
| --- | --- |
| `src/grab-it/` | The app: the Tauri project, with the frontend in `src/` and the Rust backend in `src-tauri/` |
| `src/grab-it-docs/` | This site |
| `docs/` | Developer docs, including `development.md` |

## Improve these docs

This site lives in [`src/grab-it-docs`](https://github.com/kerwincarpede/grab-it/tree/main/src/grab-it-docs) and is built with [Starlight](https://starlight.astro.build/). Every page has an **Edit page** link at the bottom.

- Pages are Markdown in `src/content/docs/`, one folder per sidebar section. A page's `sidebar.order` sets its place.
- Links between pages start with the site's base: `/grab-it/library/find-it-again/`.
- Screenshots go in `src/assets/`, in the section's folder.
- Describe what Grab-it does today, in plain words, and check it against the code.

To preview your changes, run this from the repository root:

```sh
npm ci
cd src/grab-it-docs
npm run dev
```

Merges that change only the docs publish the site without cutting a new Grab-it release.
