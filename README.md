# Grab-it

Cross-platform screenshot tool with annotation and fast full-text search, built with Rust and [Tauri 2](https://tauri.app/).

Grab-it lives in the system tray. Capture a region, a window, every monitor or one monitor from the tray menu or a hotkey; each capture is saved as a PNG and copied to the clipboard. The annotation editor and the searchable library are on the way.

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

Grab-it starts in the tray with no window open. Closing a window keeps the app running in the tray.

To open a window directly, for example on a desktop without a tray host, pass `--open settings` or `--open region`. npm, the Tauri CLI and cargo each consume one `--`, so three are needed:

```sh
npm run tauri dev -- -- -- --open settings
npm run tauri dev -- -- -- --open region
```

A built binary takes the argument directly, for example `src-tauri/target/release/grab-it --open settings`.

## Capturing

| Capture | Tray item | Default hotkey | macOS |
| --- | --- | --- | --- |
| Region (drag, or click a window) | Region | PrintScreen | Cmd+Shift+2 |
| Window (hover and click) | Window | Alt+PrintScreen | Cmd+Shift+W |
| Every monitor | Screen (all monitors) | Ctrl+PrintScreen | Cmd+Shift+F |
| One monitor | Monitor ▸ | – | – |

Change the hotkeys in Settings: click a field and press the new keys. If another app holds a hotkey, Settings says so and the tray still works.

Region and Window freeze every monitor and show it fullscreen. Drag to select a region, or hover a window and click it; Esc or right-click cancels. Each monitor is cropped at its own scale factor, so mixed-DPI setups capture sharp.

Each capture is copied to the clipboard and saved to `<save folder>/originals/` as `Grab-it YYYY-MM-DD HH-MM-SS.png`, with `<name>.meta.json` beside it holding the time, mode, size, foreground app and window title. The PNG is never modified.

- **Wayland** (`WAYLAND_DISPLAY` set): captures go through the desktop's Screenshot portal, which lets you pick the region or window. Hotkeys are offered to the desktop through the GlobalShortcuts portal; where the desktop has no such portal, use the tray menu.
- **macOS**: grant Grab-it *Screen Recording* under System Settings → Privacy & Security. Grab-it offers to open that page when the permission is missing.

## Settings

`settings.json` lives in the app data directory (`com.kerwincarpede.grabit`):

- Linux: `~/.local/share/com.kerwincarpede.grabit/`
- macOS: `~/Library/Application Support/com.kerwincarpede.grabit/`
- Windows: `%APPDATA%\com.kerwincarpede.grabit\`

The save folder defaults to `~/Pictures/Grab-it/`. Changing it only affects new captures: earlier captures stay where they are and stay in the library. `settings.json` also holds the capture hotkeys.

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
