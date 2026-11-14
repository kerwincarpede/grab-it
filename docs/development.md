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

The overlay has to appear the moment it is asked for, so a spare overlay window per monitor is kept hidden with its page already loaded, and replaced after each selection. On macOS the overlay is a see-through window (hence `macOSPrivateApi` in `tauri.conf.json`), shown as soon as the monitors are frozen; the frozen image reaches the page a moment later and slots in underneath. On Windows and X11 the overlay stays hidden until the frozen image is painted.

Nothing heavy happens while a selection is on screen. The frozen image is encoded for the page on its own thread the moment the monitors freeze (`overlay::encode_for_page`), never on the main thread. On macOS it is an uncompressed BMP: WebKit took about 100 ms to decode a 5K screen as PNG and under 30 ms as a BMP, so the loupe and the hover blur have the image sooner. Elsewhere it is still a PNG. On macOS the window list is read in one pass over the window server's list (`screen::windows_and_foreground`) rather than through xcap, which fetches the whole list again for every property of every window, and only ordinary app windows are offered for hovering. The blur around a hovered window is drawn once per selection into a small canvas (`src/overlay/backdrop.ts`), not by a CSS filter. The OCR queue waits while an overlay is open. On macOS, WebKit draws a page at most 60 times a second even on a 120 Hz ProMotion display, so a dragged selection moved in steps behind the cursor; the overlay's webview turns that off (`overlay::render_at_display_rate`, WebKit's internal "Prefer Page Rendering Updates near 60fps" feature) and keeps up with the display. Set `GRAB_IT_TRACE_OVERLAY=1` to print how long freezing, listing windows, showing the overlay and encoding the image took.

### Wayland and macOS

- **Wayland** (`WAYLAND_DISPLAY` set): captures go through the desktop's Screenshot portal, and Pick a colour uses the desktop's colour picker. Hotkeys are offered to the desktop through the GlobalShortcuts portal; where the desktop has no such portal, use the tray menu. Repeat last region and recording are not available, since only the desktop may read the screen there.
- **macOS**: Grab-it needs *Screen Recording* permission under System Settings → Privacy & Security, and offers to open that page when the permission is missing.

### Search and OCR

The text in each image is read by [ocrs](https://github.com/robertknight/ocrs) in the background, one capture at a time, newest first. Tags, notes, app and window title are searchable straight away.

The same pass decodes any QR codes and barcodes in the image (`codes::decode`, as Capture text does) and appends their values to the stored text, one per line (`ocr::with_codes`), so search finds a capture by what its codes hold and **Copy text** includes them. The plain text is stored before decoding (`ocr::store_text`): release builds abort on a panic, so a capture that crashes the decoder is already read and is not retried on every launch. Captures read before this was added are not read again.

The OCR models (about 12 MB) are not bundled: they are downloaded into `ocr-models/` in the app data directory the first time a capture needs reading, with progress shown in the Library. If the download fails, the Library offers **Retry**; the next capture also retries. Set `GRAB_IT_OCR_MODELS` to use another models directory.

The Library's **Copy text** copies a capture's stored OCR text (`library_copy_text`). A capture OCR has not read yet, or could not read, is read on the spot, codes included, and the result stored, as the queue would.

The search index is a SQLite FTS5 table in `library.db`, kept in step with each capture's tags, notes, text and AI description as they change.

### AI descriptions (optional)

Grab-it can ask a vision model to describe each capture: a sentence or two, a category (`code`, `terminal`, `browser`, `chat`, `document`, `design`, `error`, `receipt`, `photo` or `other`) and a few tags. The description and AI tags are searchable, the Library can filter by category, and the tag filter matches AI tags as well as your own. AI tags are stored apart from your tags.

Who describes captures is picked under **AI descriptions** in Settings (`ai.provider` in `settings.json`):

- **Claude Code** (`claudeCode`): Grab-it runs the `claude` CLI you already have installed and signed in to, headlessly, with the `haiku` model, no tools, no MCP servers and no saved session, in an empty temporary folder (see `ai_cli.rs`). Nothing else to set up or download. Screenshots go to Anthropic under your Claude account. Each description records `claude-code/haiku` as its model.
- **Codex** (`codex`): Grab-it runs the `codex` CLI you already have installed and signed in to, as `codex exec` in a read-only sandbox with no saved session, in an empty temporary folder holding only the capture and the JSON schema its answer must follow. It uses the model you configured for Codex, at low reasoning effort, and its stdin is closed. Screenshots go to OpenAI under your ChatGPT or OpenAI account. Each description records `codex` as its model.
- **OpenAI-compatible endpoint** (`endpoint`): any `/chat/completions` API: [Ollama](https://ollama.com), LM Studio, llama.cpp's server, or a cloud API such as OpenAI or OpenRouter.

Describing is otherwise **off by default**. When Grab-it starts and finds `claude`, it turns describing on with Claude Code, for new captures only, **once**; without `claude` but with `codex`, it does the same with Codex. That happens only for a user who never turned it on: no `ai` in `settings.json`, or an `ai` with no `provider` and `enabled: false`. The Library then shows a one-time notice naming the provider, and for Claude Code the welcome window mentions it too. An `ai` with `enabled: true` and no `provider` is an endpoint user from before providers existed and is left alone. Once a provider is set, Grab-it never changes it again, so turning describing off keeps it off.

Grab-it looks for `claude` and `codex` on its own PATH, then on your login shell's PATH (an app started from Finder or a launcher does not have it), then in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`. Installing or signing in to either CLI is up to you: if it is missing, not signed in or fails, describing pauses and the Library shows its message. A run that takes longer than five minutes is stopped.

With Ollama as the endpoint, everything stays local:

```sh
ollama pull qwen3-vl:4b   # about 3 GB; any vision model works
ollama serve              # if it is not already running
```

Then pick the endpoint in Settings and choose the **Ollama** preset, or set it under `ai` in `settings.json`. The defaults already point at Ollama with `qwen3-vl:4b`. Earlier versions defaulted to `qwen2.5vl:7b`; a model already in `settings.json` is kept, so switching means picking the preset again or editing `model`:

```json
"ai": {
  "enabled": true,
  "provider": "endpoint",
  "endpoint": "http://localhost:11434/v1",
  "model": "qwen3-vl:4b",
  "newCapturesOnly": true
}
```

For a cloud API, set the endpoint, model and API key. The **Preset** menu in Settings fills in the URL and a vision model for the common ones; you add the key and press Save:

| Preset | Endpoint | Model |
| --- | --- | --- |
| Ollama | `http://localhost:11434/v1` | `qwen3-vl:4b` |
| OpenAI | `https://api.openai.com/v1` | `gpt-5-mini` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-haiku-5-5` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-5-mini` |

Any other URL or model shows as **Custom**. The key is sent as `Authorization: Bearer …`.

The API key is kept in the OS credential store, not in `settings.json`: Keychain on macOS, Credential Manager on Windows and the Secret Service (GNOME Keyring, KWallet) on Linux, under the service `com.kerwincarpede.grabit` and the account `ai-endpoint-api-key`. A key typed into `settings.json` as `"apiKey"`, or left there by an earlier version, is moved into the credential store the next time Grab-it starts, and the file is rewritten without it. Emptying the key in Settings removes it from the credential store too; if the store cannot remove it right then, the save fails with its message and the key is kept, so it never comes back on the next start. Where there is no credential store that works, such as a Linux session without a Secret Service, the key stays in plain text in `settings.json` under `ai.apiKey`; the hint under the API key field in Settings says which. The `keyring` crate talks to the Secret Service over D-Bus in pure Rust, so building needs no extra system packages. Tests use an in-memory key store and never touch the real one.

With `newCapturesOnly`, captures that already existed when you turned describing on are skipped; set it to `false` before turning it on to describe the whole library. **Test connection** in Settings checks whichever provider is picked.

Captures are described in the background, one at a time and newest first, once OCR has read them. Each one is scaled down to at most 1568 px on its long edge and sent with its OCR text, app and window title. A model on a CPU can take a minute or more per capture. If the endpoint cannot be reached or refuses the request, or the CLI fails, describing pauses. It tries again when you change the settings or ask for a capture to be described again, or when a new capture arrives a minute or more later. Changing the model does not redo old captures: each one records the model that described it, and you can ask for one capture, or all of them, to be described again.

### Tidying captured text

While AI descriptions are on, **Capture text** also asks the same provider to read the text again (`tidy.rs`), unless `ai.tidyText` is `false`. The local OCR text is copied at once and the card says the AI is working. The region then goes to the provider with the OCR text as a hint, and the model answers `{"text", "format", "language"}`. `format` is one of `plain`, `json`, `yaml`, `xml`, `sql`, `code` or `table`.

Valid JSON is re-indented in Rust token by token, so key order and long numbers are kept exactly. The answer replaces the card's text, and the clipboard's only while it still holds what OCR copied. The card's **Copy as read** copies the OCR text. When OCR finds nothing, the AI's text is the only one. Closing the card, or a newer capture, drops a late answer.

### Reading codes

**Capture text** first looks for QR codes and barcodes in the region (`codes.rs`), with [rxing](https://github.com/rxing-core/rxing), a Rust port of ZXing. Every format rxing reads is tried: QR, Micro QR, Data Matrix, Aztec, PDF417, MaxiCode and the 1D codes (Code 128, Code 39, EAN, UPC, ITF and more), light-on-dark as well as dark-on-light. rxing is built without its default features: Grab-it hands it the region's grey pixels itself, so rxing's own `image` dependency, SVG reading and result parsers stay out of the binary. The tests draw the codes they read with rxing's writers (`encoders`, a dev-dependency feature only), so there are no image fixtures.

When it finds a code, the region is OCR'd as well, and the card (`QuickItem::Code`) shows the values. Every value is copied, one per line, top to bottom. **Copy text** copies what OCR read around them; an OCR failure only leaves that out. Only `http://` and `https://` values count as links. **Open link** opens the first one through `tauri-plugin-opener`, and only from the card's `quick_action`: nothing opens a decoded link by itself. The text is not tidied by AI. When the region holds no code, Capture text works as before.

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

The installers are not signed with a paid certificate, so Gatekeeper says it cannot verify the developer of the macOS app rather than calling it damaged, and Windows SmartScreen warns too.

CI signs the macOS app with a self-signed certificate, held in the `MACOS_CERTIFICATE` (a base64 `.p12`) and `MACOS_CERTIFICATE_PASSWORD` repository secrets. macOS remembers Screen Recording and keychain permissions by the app's signature. Each ad-hoc signature is tied to one exact build, so before this certificate every update lost them. With the certificate, every release has the same identity and keeps them. Tauri's own `APPLE_CERTIFICATE` import accepts only Apple-issued certificates, so CI imports this one into a temporary keychain itself and hands its name to Tauri as `APPLE_SIGNING_IDENTITY`, then fails the build if the signature is not tied to it. Without the secret, as in pull requests from forks, the app is signed ad-hoc (`-`). An `APPLE_SIGNING_IDENTITY` secret (a paid certificate) takes precedence over both.

The certificate was made once with [`.github/scripts/make_macos_signing_cert.sh`](../.github/scripts/make_macos_signing_cert.sh) and is valid for 20 years. **Keep a backup of the `.p12` and its password**: a new certificate is a new identity, so every installed copy would have to grant its permissions again once.

## The README animation

The README shows [`docs/assets/demo.gif`](assets/demo.gif), a 14-second GIF that repeats forever, so it plays wherever the README is read. It is rendered from [`docs/assets/demo.svg`](assets/demo.svg), an SVG animated with CSS keyframes, which is in turn generated by [`docs/assets/demo.py`](assets/demo.py). Edit `demo.py`, not the SVG or the GIF, then regenerate both from the repository root:

```sh
python3 docs/assets/demo.py docs/assets/demo.svg
python3 docs/assets/demo_gif.py docs/assets/demo.svg docs/assets/demo.gif
```

The second command needs Chrome (or Chromium or Edge) and ffmpeg, and takes about a minute: it screenshots the SVG at each of its 280 frames in headless Chrome and joins them with ffmpeg. Set `CHROME` to the browser binary if it is not found.
