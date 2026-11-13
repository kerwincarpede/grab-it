# Grab-it

Cross-platform screenshot tool with annotation and fast full-text search, built with Rust and [Tauri 2](https://tauri.app/).

Grab-it lives in the system tray. Capture a region, a window, every monitor or one monitor from the tray menu or a hotkey; each capture is saved as a PNG, copied to the clipboard and shown on a small Quick Access card with the next steps one click away.

| | |
| --- | --- |
| **Capture** | Region, window, screen, one monitor, timed captures, and Repeat last region. A magnifier shows the exact pixel and its colour while you select. |
| **Quick Access** | A card in the corner after each capture: Copy, Annotate, Pin, Show in folder, Delete. It goes away by itself. |
| **Annotate** | Arrows, shapes, text, numbered steps, highlighter, blur or pixelate, spotlight and crop, all non-destructive. A backdrop adds a gradient, padding, rounded corners and a shadow. |
| **Pin** | Float any capture above your other windows as a reference. |
| **Capture text** | Drag over anything on screen to copy its text (offline OCR). |
| **Pick a colour** | Click any pixel to copy its hex colour. |
| **Record** | Record a region or a window as an animated GIF. |
| **Library** | Every capture, searchable by the text in the image, tags, notes, app and window title. |

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

To open a window or start a capture directly, for example on a desktop without a tray host, pass `--open` with one of `settings`, `library`, `region`, `repeat`, `text`, `colour`, `record`, `editor <file>`, `quick <file>` or `pin <file>`. npm, the Tauri CLI and cargo each consume one `--`, so three are needed:

```sh
npm run tauri dev -- -- -- --open settings
npm run tauri dev -- -- -- --open region
```

A built binary takes the argument directly, for example `src-tauri/target/release/grab-it --open settings`.

Only one Grab-it runs at a time. Starting it again hands the arguments to the running one, so `grab-it --open region` works as a desktop shortcut or from a script; with no arguments it opens the Library.

## Capturing

| Capture | Tray item | Default hotkey | macOS |
| --- | --- | --- | --- |
| Region (drag, or click a window) | Capture region | PrintScreen | Cmd+Shift+2 |
| Window (hover and click) | Capture window | Alt+PrintScreen | Cmd+Shift+W |
| Every monitor | Capture screen (all monitors) | Ctrl+PrintScreen | Cmd+Shift+F |
| One monitor | Monitor ▸ | – | – |
| The same region again | Repeat last region | – | – |
| After 3, 5 or 10 seconds | Timed capture ▸ | – | – |
| Text in a region | Capture text | Shift+PrintScreen | Cmd+Shift+1 |
| Colour of a pixel | Pick a colour | Ctrl+Shift+PrintScreen | Cmd+Shift+9 |
| Animated GIF | Record GIF / Stop recording | – | – |

Change the hotkeys in Settings: click a field and press the new keys. If another app holds a hotkey, Settings says so and the tray still works.

Region and Window freeze every monitor and show it fullscreen. Drag to select a region, or hover a window and click it; Esc or right-click cancels. Guide lines and a magnifier follow the pointer, showing the pixel under it, its colour and its position. While dragging, hold Shift for a square and Space to move the selection. Each monitor is cropped at its own scale factor, so mixed-DPI setups capture sharp.

A timed capture waits, then freezes the screen: time to open a menu or hover a tooltip first. Repeat last region captures the area you last dragged, without the overlay, as it looks now.

Each capture is copied to the clipboard and saved to `<save folder>/originals/` as `Grab-it YYYY-MM-DD HH-MM-SS.png`, with `<name>.meta.json` beside it holding the time, mode, size, foreground app and window title. The PNG is never modified.

- **Wayland** (`WAYLAND_DISPLAY` set): captures go through the desktop's Screenshot portal, which lets you pick the region or window, and Pick a colour uses the desktop's colour picker. Hotkeys are offered to the desktop through the GlobalShortcuts portal; where the desktop has no such portal, use the tray menu. Repeat last region and recording are not available, since only the desktop may read the screen there.
- **macOS**: grant Grab-it *Screen Recording* under System Settings → Privacy & Security. Grab-it offers to open that page when the permission is missing.

### Quick Access

After a capture a small card appears in the bottom-left corner with the capture's preview. **Copy** copies it again, **Annotate** (or a click on the preview) opens the editor, **Pin** floats it above other windows, and the two icons show it in its folder or delete it. The card never takes the keyboard focus and dismisses itself after a few seconds; rest the pointer on it to keep it. The tray's **Show last capture** brings the newest capture back.

Prefer something else? Settings → *After a capture* offers Quick Access, opening the editor straight away, or nothing; copying to the clipboard can be turned off there too.

### Pinning

A pinned capture is a borderless window that stays above everything else. Drag it anywhere, scroll (or press + and -) to resize it, and press Esc or double-click to close it. Pin from Quick Access, the Library, or the editor; the editor pins the annotated image.

### Capturing text and colours

**Capture text** reads the text in the region you drag and copies it, using the same offline OCR as the Library's search. Nothing is saved. **Pick a colour** copies the colour of the pixel you click as `#RRGGBB`. Both confirm what they copied on the Quick Access card.

### Recording

**Record GIF** asks for a region or a window, then records it at up to ten frames a second into `<save folder>/recordings/`. The Quick Access card shows the elapsed time and **Stop** (the tray item stops it too), and moves to another corner when it would be in the picture. A recording stops by itself after one minute; frames wider than 1280 pixels are scaled down.

## Annotating

The editor opens from Quick Access, the Library, or straight after a capture if you choose so in Settings. Tools sit in the rail on the left, each with a single-key shortcut shown in its tooltip:

- **Arrow, line, rectangle, ellipse, freehand, highlighter, text** and numbered **steps**. Rectangles and ellipses can be filled; text can have a background.
- **Blur** hides part of the capture, pixelated or smoothly blurred.
- **Spotlight** dims everything outside the rectangles you drag, with your annotations kept bright on top.
- **Crop** and the **Backdrop** (gradient or plain colour, padding, rounded corners, shadow) shape the exported image.

Ctrl/Cmd+D duplicates the selected shape, the arrow keys nudge it (Shift for 10 pixels), and `[` and `]` change the stroke width. **Copy** (Ctrl/Cmd+C), **Export…** and **Pin** use the finished image; Ctrl/Cmd+Enter copies and closes the editor.

Annotations are saved automatically in `<name>.annotations.json` beside the capture and can be changed at any time. The original PNG is never modified.

## Searching

The Library (tray → **Library…**) shows every capture, newest first. Select one to open it in the editor, copy it, pin it, show it in its folder, or give it tags and notes.

Type in the search box at the top of the Library to find captures by the text in the image, their tags, notes, app or window title. Results update once you pause typing (or press Enter). Each word matches the start of a word, and every word must match, so `inv 2026` finds a receipt reading "Invoice 2026-03". Each result shows where it matched, with the matching words highlighted.

The filter bar narrows the Library, with or without words: by app, by tag, and by the days captured (From and To are both included). **Clear** resets the search and the filters.

The text in each image is read by [ocrs](https://github.com/robertknight/ocrs) in the background, one capture at a time, newest first. Captures become findable by their text once they have been read; their tags, notes, app and window title are searchable straight away.

The OCR models (about 12 MB) are not bundled: they are downloaded into `ocr-models/` in the app data directory the first time a capture needs reading, with progress shown in the Library. If the download fails, the Library says so and offers **Retry**; the next capture also retries. Set `GRAB_IT_OCR_MODELS` to use another models directory.

The search index is a SQLite FTS5 table in `library.db`, kept in step with each capture's tags, notes and text as they change.

## Settings

`settings.json` lives in the app data directory (`com.kerwincarpede.grabit`):

- Linux: `~/.local/share/com.kerwincarpede.grabit/`
- macOS: `~/Library/Application Support/com.kerwincarpede.grabit/`
- Windows: `%APPDATA%\com.kerwincarpede.grabit\`

The save folder defaults to `~/Pictures/Grab-it/`. Changing it only affects new captures: earlier captures stay where they are and stay in the library. `settings.json` also holds the hotkeys, what happens after a capture, and whether captures are copied to the clipboard.

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

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the checks on Ubuntu 24.04 (caching the ocrs models for the OCR tests) and, in parallel, builds unsigned installers with `tauri-action` on Ubuntu 24.04, Windows and macOS and uploads them as workflow artifacts.

## License

[MIT](LICENSE)
