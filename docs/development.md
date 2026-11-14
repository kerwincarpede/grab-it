# Developing Grab-it

Grab-it is built with Rust and [Tauri 2](https://tauri.app/), with a React + TypeScript frontend. This page covers building it from source, running the checks, and how releases are made. If you just want to use Grab-it, see [Getting started](getting-started.md).

## Layout

| Path | Contents |
| --- | --- |
| `app/` | The Tauri project |
| `app/src/` | Frontend: React + TypeScript + Vite |
| `app/src-tauri/` | Backend: Rust |
| `.github/workflows/ci.yml` | Checks plus installer builds on Linux, Windows and macOS |
| `.github/workflows/release.yml` | Manually triggered release from `main` |
| `docs/` | User and developer docs; `docs/assets/demo.gif` is the README animation |

## Setup

1. Install [Node.js 22](https://nodejs.org/) and the stable Rust toolchain via [rustup](https://rustup.rs/) (`rustup component add rustfmt clippy`).
2. Install the Tauri system dependencies for your OS, see [Tauri prerequisites](https://tauri.app/start/prerequisites/). On Debian/Ubuntu:

   ```sh
   sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
     librsvg2-dev libxdo-dev libssl-dev patchelf build-essential curl wget file
   ```

   Screen capture ([xcap](https://github.com/nashaofu/xcap)) also needs these on Debian/Ubuntu:

   ```sh
   sudo apt-get install -y pkg-config libclang-dev libxcb1-dev libxrandr-dev \
     libdbus-1-dev libpipewire-0.3-dev libwayland-dev libegl-dev libgbm-dev
   ```

3. Install the frontend dependencies:

   ```sh
   cd app
   npm ci
   ```

## Run

```sh
cd app
npm run tauri dev
```

Grab-it starts in the tray with no window open. Closing a window keeps the app running in the tray. The very first launch also opens a short welcome listing the hotkeys; the tray's **Shortcuts and tips…** shows it again.

To open a window or start a capture directly, for example on a desktop without a tray host, pass `--open` with one of `settings`, `library`, `welcome`, `region`, `repeat`, `text`, `colour`, `record`, `editor <file>`, `quick <file>` or `pin <file>`. npm, the Tauri CLI and cargo each consume one `--`, so three are needed:

```sh
npm run tauri dev -- -- -- --open settings
npm run tauri dev -- -- -- --open region
```

A built binary takes the argument directly, for example `src-tauri/target/release/grab-it --open settings`.

Only one Grab-it runs at a time. Starting it again hands the arguments to the running one, so `grab-it --open region` works as a desktop shortcut or from a script; with no arguments it opens the Library.

## How it works

### Captures on disk

Each capture is copied to the clipboard and saved to `<save folder>/originals/` as `Grab-it YYYY-MM-DD HH-MM-SS.png`, with `<name>.meta.json` beside it holding the time, mode, size, foreground app and window title. The PNG is never modified.

Annotations are saved in `<name>.annotations.json` beside the capture. Crop and backdrop are non-destructive and only applied on copy and export. GIF recordings go to `<save folder>/recordings/`.

Region and Window freeze every monitor and show it fullscreen. Each monitor is cropped at its own scale factor, so mixed-DPI setups capture sharp.

### Wayland and macOS

- **Wayland** (`WAYLAND_DISPLAY` set): captures go through the desktop's Screenshot portal, and Pick a colour uses the desktop's colour picker. Hotkeys are offered to the desktop through the GlobalShortcuts portal; where the desktop has no such portal, use the tray menu. Repeat last region and recording are not available, since only the desktop may read the screen there.
- **macOS**: Grab-it needs *Screen Recording* permission under System Settings → Privacy & Security, and offers to open that page when the permission is missing.

### Search and OCR

The text in each image is read by [ocrs](https://github.com/robertknight/ocrs) in the background, one capture at a time, newest first. Tags, notes, app and window title are searchable straight away.

The OCR models (about 12 MB) are not bundled: they are downloaded into `ocr-models/` in the app data directory the first time a capture needs reading, with progress shown in the Library. If the download fails, the Library offers **Retry**; the next capture also retries. Set `GRAB_IT_OCR_MODELS` to use another models directory.

The search index is a SQLite FTS5 table in `library.db`, kept in step with each capture's tags, notes, text and AI description as they change.

### AI descriptions (optional)

Grab-it can ask a vision model to describe each capture: a sentence or two, a category (`code`, `terminal`, `browser`, `chat`, `document`, `design`, `error`, `receipt`, `photo` or `other`) and a few tags. The description and AI tags are searchable, the Library can filter by category, and the tag filter matches AI tags as well as your own. AI tags are stored apart from your tags.

Who describes captures is picked under **AI descriptions** in Settings (`ai.provider` in `settings.json`):

- **Claude Code** (`claudeCode`): Grab-it runs the `claude` CLI you already have installed and signed in to, headlessly, with the `haiku` model, no tools, no MCP servers and no saved session, in an empty temporary folder (see `ai_cli.rs`). Nothing else to set up or download. Screenshots go to Anthropic under your Claude account. Each description records `claude-code/haiku` as its model.
- **OpenAI-compatible endpoint** (`endpoint`): any `/chat/completions` API: [Ollama](https://ollama.com), LM Studio, llama.cpp's server, or a cloud API such as OpenAI or OpenRouter.

Describing is otherwise **off by default**. When Grab-it starts and finds `claude`, it turns describing on with Claude Code, for new captures only, **once**, for a user who never turned it on: no `ai` in `settings.json`, or an `ai` with no `provider` and `enabled: false`. The Library then shows a one-time notice, and the welcome window mentions it. An `ai` with `enabled: true` and no `provider` is an endpoint user from before providers existed and is left alone. Once a provider is set, Grab-it never changes it again, so turning describing off keeps it off.

Grab-it looks for `claude` on its own PATH, then on your login shell's PATH (an app started from Finder or a launcher does not have it), then in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`. Installing or signing in to Claude Code is up to you: if it is missing, not signed in or fails, describing pauses and the Library shows its message. A run that takes longer than five minutes is stopped.

With Ollama as the endpoint, everything stays local:

```sh
ollama pull qwen2.5vl:7b   # about 6 GB; any vision model works
ollama serve               # if it is not already running
```

Then pick the endpoint in Settings, or set it under `ai` in `settings.json`. The defaults already point at Ollama:

```json
"ai": {
  "enabled": true,
  "provider": "endpoint",
  "endpoint": "http://localhost:11434/v1",
  "model": "qwen2.5vl:7b",
  "apiKey": null,
  "newCapturesOnly": true
}
```

For a cloud API, set `endpoint` (for example `https://api.openai.com/v1`), `model` and `apiKey`. The key is sent as `Authorization: Bearer …` and is stored in plain text in `settings.json`. With `newCapturesOnly`, captures that already existed when you turned describing on are skipped; set it to `false` before turning it on to describe the whole library. **Test connection** in Settings checks whichever provider is picked.

Captures are described in the background, one at a time and newest first, once OCR has read them. Each one is scaled down to at most 1568 px on its long edge and sent with its OCR text, app and window title. A model on a CPU can take a minute or more per capture. If the endpoint cannot be reached or refuses the request, or the CLI fails, describing pauses. It tries again when you change the settings or ask for a capture to be described again, or when a new capture arrives a minute or more later. Changing the model does not redo old captures: each one records the model that described it, and you can ask for one capture, or all of them, to be described again.

### Settings

`settings.json` lives in the app data directory (`com.kerwincarpede.grabit`):

- Linux: `~/.local/share/com.kerwincarpede.grabit/`
- macOS: `~/Library/Application Support/com.kerwincarpede.grabit/`
- Windows: `%APPDATA%\com.kerwincarpede.grabit\`

It holds the save folder (default `~/Pictures/Grab-it/`), the hotkeys, what happens after a capture, whether captures are copied to the clipboard, and the [AI description](#ai-descriptions-optional) settings. Changing the save folder only affects new captures.

**Start Grab-it when you sign in** is kept by the operating system rather than in `settings.json`: a login item on macOS, a registry entry on Windows, and an autostart entry on Linux.

## Checks

Run these from `app/`. CI runs the same commands.

```sh
npm ci
npm run lint        # eslint + tsc --noEmit
npm test            # vitest run
npm run build       # tsc + vite build, also needed before the Rust build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

The OCR tests download the ocrs models once into `src-tauri/target/ocr-models/`, or into `$GRAB_IT_OCR_MODELS` when set; CI caches that directory. Their fixture, `src-tauri/tests/fixtures/ocr-pineapple.png`, was made with ImageMagick (the command is in `src-tauri/src/ocr.rs`).

To build installers locally, run `npm run tauri build`; they land in `app/src-tauri/target/release/bundle/`.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the checks on Ubuntu 24.04 (caching the ocrs models for the OCR tests) and, in parallel, builds installers with `tauri-action` on Ubuntu 24.04, Windows and macOS and uploads them as workflow artifacts. It runs on every pull request and push to `main`, and never publishes anything.

## Releases

Releases are cut by hand. Each one publishes a [GitHub release](https://github.com/kerwincarpede/grab-it/releases) of the current `main` with the installers attached: `.msi` and `-setup.exe` for Windows, `.dmg` for macOS (Apple silicon), and `.AppImage`, `.deb` and `.rpm` for Linux.

To release, open **Actions → Release → Run workflow** on GitHub, or from a terminal:

```sh
gh workflow run release.yml                # bump from the commits (below)
gh workflow run release.yml -f bump=minor  # or force patch, minor or major
gh run watch                               # follow it
```

[`.github/workflows/release.yml`](../.github/workflows/release.yml) only runs from `main`, and refuses a commit that is already released. It runs the whole of `ci.yml` (checks and the three installer builds) as a reusable workflow, so a release gets exactly the checks a pull request does.

Versions come from the `v*` git tags. With the default `auto` bump, [`PaulHatch/semantic-version`](https://github.com/PaulHatch/semantic-version) reads the commits since the last tag and bumps by [Conventional Commits](https://www.conventionalcommits.org/):

| Commit (or squash-merged PR title) | Bump |
| --- | --- |
| `feat!: ...`, or `BREAKING CHANGE:` in the message | major |
| `feat: ...` or `feat(scope): ...` | minor |
| anything else | patch |

The first release, made before any tag exists, takes the version in `app/src-tauri/tauri.conf.json`. After that the tags are the source of truth: CI writes the release version into `tauri.conf.json` before building, so the version fields in the repository do not need bumping by hand.

A run opens a draft release, builds the installers into it, and publishes it (creating the tag) only when the checks and all three builds pass. A failed run leaves only a hidden draft, which the next release of that version replaces. Each release is named by its version, for example `0.2.1` for the tag `v0.2.1`.

### Updates

Installed copies update themselves from these releases with Tauri's [updater plugin](https://v2.tauri.app/plugin/updater/) (`app/src-tauri/src/update.rs`). They read `latest.json` from the latest release (`releases/latest/download/latest.json`), compare its version with their own, and offer to download and install the package for their platform and installer type. A release builds those packages because CI turns on `bundle.createUpdaterArtifacts` when it stamps the version: the `.app.tar.gz` on macOS, and the `.AppImage`, `.deb`, `.rpm`, `.msi` and `-setup.exe` themselves elsewhere, each with a `.sig`. The publish job then writes `latest.json` from those signatures ([`.github/scripts/updater_manifest.py`](../.github/scripts/updater_manifest.py)) and refuses to publish a release that is missing macOS, Linux or Windows.

`latest.json` also carries `changes`: the user-facing entries of the generated release notes ("What's Changed") of this release and the 19 before it. The update prompt lists those newer than the installed version, so someone several versions behind sees everything the update brings. Entries come from the pull request titles, without their Conventional Commits prefix; `ci`, `docs`, `chore`, `build`, `refactor`, `style` and `test` changes are left out, so write `feat:` and `fix:` titles for a user to read.

The updater accepts only packages signed with the key whose public half is `plugins.updater.pubkey` in `tauri.conf.json`. The private key and its password are the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets. **Keep a backup of the key**: if it is lost, installed copies cannot be updated, and everyone has to download a release built with a new key by hand. Ordinary CI builds make no update packages, so they need neither secret.

Development builds (`npm run tauri dev`) do not check by themselves; the tray's **Check for updates…** still works.

The installers are not signed with a paid certificate. CI ad-hoc signs the macOS app (the `APPLE_SIGNING_IDENTITY` repository secret overrides the `-` identity), so Gatekeeper says it cannot verify the developer rather than calling the app damaged.

## The README animation

The README shows [`docs/assets/demo.gif`](assets/demo.gif), a 14-second GIF that repeats forever, so it plays wherever the README is read. It is rendered from [`docs/assets/demo.svg`](assets/demo.svg), an SVG animated with CSS keyframes, which is in turn generated by [`docs/assets/demo.py`](assets/demo.py). Edit `demo.py`, not the SVG or the GIF, then regenerate both from the repository root:

```sh
python3 docs/assets/demo.py docs/assets/demo.svg
python3 docs/assets/demo_gif.py docs/assets/demo.svg docs/assets/demo.gif
```

The second command needs Chrome (or Chromium or Edge) and ffmpeg, and takes about a minute: it screenshots the SVG at each of its 280 frames in headless Chrome and joins them with ffmpeg. Set `CHROME` to the browser binary if it is not found.
