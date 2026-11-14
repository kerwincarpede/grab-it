# App icon sources

Every file in `../` is generated from these SVGs; edit the SVGs, then regenerate.

- `app-icon.svg` is the icon on a near full-bleed tile, used for Windows, Linux, the tray and the window icon.
- `app-icon-macos.svg` is the same artwork on Apple's icon grid (an 824 px tile with a shadow in a 1024 px canvas) so it matches other macOS icons. Only `icon.icns` comes from it.

From `app/`:

```sh
npx tauri icon src-tauri/icons/source/app-icon.svg -o /tmp/grab-it-icons
npx tauri icon src-tauri/icons/source/app-icon-macos.svg -o /tmp/grab-it-icons-macos
```

Then copy over the files that already exist in `src-tauri/icons/` (skip the generated `android/`, `ios/` and `64x64.png`), take `icon.icns` from the macOS run, and copy `32x32.png` to `public/icon.png` for the favicon.
