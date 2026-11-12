# Grab-it

Cross-platform screenshot tool with annotation and fast full-text search, built with Rust and [Tauri 2](https://tauri.app/).

Grab-it lives in the system tray. Right now the tray menu has **Settings…** and **Quit Grab-it**; capture, the annotation editor and the searchable library are on the way.

## Layout

| Path | Contents |
| --- | --- |
| `app/` | The Tauri project |
| `app/src/` | Frontend: React + TypeScript + Vite |
| `app/src-tauri/` | Backend: Rust |
| `.github/workflows/ci.yml` | Checks plus installer builds on Linux, Windows and macOS |

## Setup

1. Install [Node.js 22](https://nodejs.org/) and the stable Rust toolchain via [rustup](https://rustup.rs/) (`rustup component add rustfmt clippy`).
2. Install the Tauri system dependencies for your OS, see [Tauri prerequisites](https://tauri.app/start/prerequisites/). On Debian/Ubuntu:

   ```sh
   sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
     librsvg2-dev libxdo-dev libssl-dev patchelf build-essential curl wget file
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

Grab-it starts in the tray with no window open. Use the tray menu to open Settings or quit. Closing a window keeps the app running in the tray.

To open a window directly, for example on a desktop without a tray host, pass `--open`:

```sh
npm run tauri dev -- -- --open settings
```

## Settings

`settings.json` lives in the app data directory (`com.kerwincarpede.grabit`):

- Linux: `~/.local/share/com.kerwincarpede.grabit/`
- macOS: `~/Library/Application Support/com.kerwincarpede.grabit/`
- Windows: `%APPDATA%\com.kerwincarpede.grabit\`

The save folder defaults to `~/Pictures/Grab-it/`. Changing it only affects new captures: earlier captures stay where they are and stay in the library.

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

To build installers locally, run `npm run tauri build`; they land in `app/src-tauri/target/release/bundle/`.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the checks on Ubuntu 22.04, then builds unsigned installers with `tauri-action` on Ubuntu 22.04, Windows and macOS and uploads them as workflow artifacts.

## License

[MIT](LICENSE)
