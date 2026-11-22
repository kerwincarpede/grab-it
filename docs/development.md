# Developing Grab-it

Grab-it is built with Rust and [Tauri 2](https://tauri.app/), with a React + TypeScript frontend. This page covers building it from source, running the checks, and how releases are made. If you just want to use Grab-it, see [Getting started](getting-started.md).

## Layout

| Path | Contents |
| --- | --- |
| `package.json` | npm workspace root over `src/*`; holds the one lockfile |
| `src/grab-it/` | The Tauri project |
| `src/grab-it/src/` | Frontend: React + TypeScript + Vite |
| `src/grab-it/src-tauri/` | Backend: Rust |
| `src/grab-it/e2e/` | Smoke tests: WebdriverIO specs that drive the built app |
| `.github/workflows/ci.yml` | Checks, Rust tests on Windows and macOS, smoke tests on Linux, and installer builds on Linux, Windows and macOS |
| `.github/workflows/release.yml` | Release of every push to `main` |
| `AGENTS.md` | The rules every change follows, and which standard to read for which task |
| `docs/` | User and developer docs; `docs/standards/` holds the coding, data, writing and PR standards; `docs/assets/` holds the README animation and the scripts that draw it and the docs site's tour animations |

## Setup

1. Install [Node.js 22](https://nodejs.org/) and the stable Rust toolchain via [rustup](https://rustup.rs/) (`rustup component add rustfmt clippy`).
2. Install the Tauri system dependencies for your OS, see [Tauri prerequisites](https://tauri.app/start/prerequisites/). On Debian/Ubuntu:

   ```sh
   sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
     librsvg2-dev libxdo-dev libssl-dev patchelf build-essential curl wget file
   ```

   Showing clicks and keystrokes in recordings ([rdev](https://github.com/Narsil/rdev)'s XRecord hooks) also needs:

   ```sh
   sudo apt-get install -y libx11-dev libxtst-dev libxi-dev
   ```

   Screen capture ([xcap](https://github.com/nashaofu/xcap)) also needs these on Debian/Ubuntu:

   ```sh
   sudo apt-get install -y pkg-config libclang-dev libxcb1-dev libxrandr-dev \
     libdbus-1-dev libpipewire-0.3-dev libwayland-dev libegl-dev libgbm-dev
   ```

   Clipboard sound playback also needs the ALSA development headers on Linux.

   ```sh
   sudo apt-get install -y libasound2-dev
   ```

3. Install the frontend dependencies from the repository root, which is an npm workspace over `src/*`:

   ```sh
   npm ci
   ```

## Run

```sh
cd src/grab-it
npm run tauri dev
```

Grab-it starts in the tray with no window open. Closing a window keeps the app running in the tray. The very first launch also opens a short welcome listing the hotkeys; the tray's **Shortcuts and tips…** shows it again.

To open a window or start a capture directly, for example on a desktop without a tray host, pass `--open` with one of `settings`, `library`, `welcome`, `region`, `all-in-one`, `repeat`, `text`, `colour`, `record`, `steps`, `editor <file>`, `quick <file>`, `pin <file>` or `guide <file>`. npm, the Tauri CLI and cargo each consume one `--`, so three are needed:

```sh
npm run tauri dev -- -- -- --open settings
npm run tauri dev -- -- -- --open region
```

A built binary takes the argument directly, for example `src-tauri/target/release/grab-it --open settings`.

Only one Grab-it runs at a time. Starting it again hands the arguments to the running one, so `grab-it --open region` works as a desktop shortcut or from a script; with no arguments it opens the Library.

The subcommands `displays`, `windows`, `shot`, `record`, `stop`, `gif`, `frames` and `help` are the command line for agents and scripts (`cli.rs`). They run in `lib.rs` `run()` before the Tauri builder, so the single-instance plugin never sees them, and talk to the running app over the control connection (`control.rs`). Try them against the dev app with **Settings → AI integration → Let AI agents use Grab-it** on:

```sh
npm run tauri dev                                  # in one terminal
src-tauri/target/debug/grab-it windows             # in another
src-tauri/target/debug/grab-it shot --window code --max-width 1280
src-tauri/target/debug/grab-it record --window code --for 5
src-tauri/target/debug/grab-it gif <path from record> --end 3 --width 800
src-tauri/target/debug/grab-it frames <path from record> --count 9
```

## How it works

### Tray hub

In `src/hub/Hub.tsx`, the capture choices scroll inside `.hub-scroll`. Opening **Timed** or **Monitor** scrolls its choices into view. The **Recent** heading and thumbnails stay pinned below the list, above the footer.

### Captures on disk

Each capture is copied to the clipboard and saved to `<save folder>/originals/` as `Grab-it YYYY-MM-DD HH-MM-SS.png`, with `<name>.meta.json` beside it holding the time, mode, size, foreground app and window title. The PNG is never modified. On macOS, every image copy offers PNG first, then TIFF for apps that need it. If TIFF conversion fails, the PNG is still available.

The mouse pointer is saved apart from the pixels (`pointer.rs`). One snapshot of its place and image is taken when the monitors freeze, or when a direct capture (Screen, Monitor, Repeat last region, a timed capture) reads the screen, and is mapped into the saved image. `meta.json` keeps it as an optional `pointer`: `x` and `y`, the hot spot in the saved image's pixels; `hotX` and `hotY`, the hot spot within the pointer image; `width` and `height`, the pointer image's size; and `image`, the pointer image as a base64 PNG. A pointer outside the captured area is dropped, and so is one on Wayland, where the portal does not hand it over. X11 reads the image through XFixes, Windows draws the pointer with `DrawIconEx` over black and over white to recover its transparency, and macOS takes the system's current `NSCursor`, resized to the capture's density when the two differ. With **Show the pointer in new captures** on, the clipboard copy made at capture time has the pointer drawn in; the PNG never does. The editor writes the user's changes to the pointer into `<name>.annotations.json` as an optional `pointer` (`shown`, `x`, `y`, `scale`) only once they change it; until then it uses the captured place and the setting. The optional `look` field selects a built-in pointer (`arrow`, `hand` or `text`). A missing or unknown look uses the captured image. The editor applies `scale` to the chosen image’s own size and keeps its hot spot at `x`, `y`.

Annotations are saved in `<name>.annotations.json` beside the capture. Crop and backdrop are non-destructive and only applied on copy and export. Images dropped or pasted into the editor are copied into a `<name>.assets/` folder beside it (`capture::assets_dir`) by `editor_add_image_file` and `editor_add_clipboard_image`, which save under a fresh `<stem>-<millis>.<ext>` name with `create_new`, as backdrop preset images are. An `image` shape in the sidecar names its file by that name alone, never a path, and `editor_asset_image` reads only plain names that still resolve inside that folder; exports into it are refused (`check_export_target`). The editor's canvas is the smallest box around the capture and every `image` shape (`canvasBounds` in `src/editor/model.ts`), never saved: without a crop, copy and export put out that box (`flatten`'s `canvas` option), and what nothing covers stays transparent (white in a JPEG). Display space stays anchored on the capture, so the canvas as it shows (`orientRect(canvas, …)`) may start at negative x or y; the crop is drawn, moved, resized and snapped inside it (the crop helpers in `tools.ts` take its bounds), with the capture's own borders added to the snap lines. A backdrop pads around the whole canvas. When the exported area reaches past the capture (`reachesPast`), the backdrop's shadow is cast by a black silhouette of what has pixels, kept to their own alpha (`shadowPlate` in `flatten.ts`: the flattened content layer on export, and the same layer rendered over the exported area at screen resolution in the preview, so annotations cast it too), drawn out of sight with its shadow offset back (`shadowShift`), so clear canvas and transparent margins of added images cast none; the blurred fill blurs only the capture's part of the area (`blurArea`), and Balance is off. Library and hub renders still show the capture without added images. Deleting a capture (`Library::delete`, or Quick Access for one the library does not know) deletes its assets folder; images removed from the sidecar keep their files until then. Recordings go to `<save folder>/recordings/` as `Grab-it YYYY-MM-DD HH-MM-SS.mp4` (or `.gif`), with their edits in `<name>.edits.json` (see [Recording editor](#recording-editor)).

Arrows keep their endpoints, width and colour in the sidecar. The optional `arrowStyle` names a preset from `src/editor/arrowStyles.ts`. An absent or unknown preset uses Classic. Smooth styles use the optional quadratic `control` point. Elbow uses an optional `elbow` object with the `axis` and `at` coordinate of the middle segment in capture pixels. Without it, the editor centres the segment between the endpoints. Picker previews use the same path data as `ShapeNode`, which draws arrows for the editor canvas, copy and export.

Stamps are `stamp` shapes in the annotations sidecar: `{ "id", "type": "stamp", "name", "x", "y", "size", "rotation"?, "color"?, "label"? }` in capture pixels, `x`, `y` the centre, `size` the longer side and `rotation` in degrees clockwise, absent when upright. They are stored by `name`, one of the bundled stamps in `src/editor/stamps.ts`: the icons `check`, `cross`, `warning`, `question` and `star`, drawn from path data in `color`; the pointers `cursor-arrow`, `cursor-hand` and `cursor-text`; the `keycap`, drawn as a cap in `color` with its `label`; and `emoji-<codepoint>` for each emoji, named after Noto's `emoji_u<codepoint>.svg`. Pointers and emoji keep their own colours and have no `color`. Their SVGs are in `src/editor/stamps/` and reach the page as URLs (`import.meta.glob` with `?url`), loaded into images once and shared (`useStampImage.ts`); `renderCapture` waits for them before it draws. The emoji are from [Noto Emoji](https://github.com/googlefonts/noto-emoji)'s `2D/svg/`, unchanged, under the Apache License 2.0, with its `LICENSE` beside them; the pointer SVGs are Grab-it's own. A sidecar stamp whose `name` this build does not bundle is skipped, like an unknown shape, so a newer build can add stamps. A stamp undoes the capture's turn and mirror about its centre, as step badges do, so it never shows mirrored. The editor remembers the last-picked stamp as `stamp` in the `editor` section of `settings.json`: a name, or `keycap:<label>` for a keycap preset (`pickId`).

A step capture (`steps.rs`) saves each step as an ordinary capture in `originals/`, with a `step` shape whose `number` is set in its annotations sidecar, and lists them in `<save folder>/guides/Grab-it Guide YYYY-MM-DD HH-MM-SS.guide.json`: `{"version": 1, "steps": [{"capture": …, "description": …}]}`, each `capture` a path from the save folder, in step order. Reordering or deleting a step in the Guide window rewrites the guide file and renumbers those `step` shapes in each remaining capture's sidecar; a deleted step's capture stays in the Library.

Region and Window freeze every monitor and show it fullscreen. Each monitor is cropped at its own scale factor, so mixed-DPI setups capture sharp. On Windows Grab-it checks each overlay’s client bounds against the frozen monitor before showing it. If the bounds differ, it applies the monitor’s full physical rectangle on the window thread and checks it again after Windows processes any DPI change. The recording outline, webcam bubble and toolbar move to the target monitor before applying their final physical size and position. On macOS each overlay is placed in its display's points (`overlay::logical_frame`): tao reports a monitor in pixels at that monitor's scale but turns a window's pixels back into points at the scale of the screen the window is on, so with displays of different scales an overlay placed in pixels landed at half or double its place. Overlays take the first click (`accept_first_mouse`), so a drag starts on any display, and the one on the display the pointer is on is shown last, so it takes the keyboard. WebKit sends pointer moves only to the key window, so while a selection is open `overlay::follow_pointer` checks the pointer every 16 ms and makes the overlay under it key (`panel::focus_under_pointer`), unless a mouse button is held, since a drag stays with the overlay it started on. The overlay it leaves clears its crosshair, loupe and window highlight on `mouseleave` and `blur`. Windows and Linux send pointer moves to the window under the pointer, so they need none of this. `record_bar::pointer_on` compares the pointer and the displays in points for the same reason.

Capture & record… (`Action::AllInOne`) opens the same overlay with `allInOne` set in `OverlayInfo`, and the page adds one toolbar (`ChooserToolbar` in `src/overlay/ChooserToolbar.tsx`), in the setup toolbar's pill and palette: Region, Window and Screen, then Text, Colour, Record and Scroll, a middle section, the Timer, a main button named for the mode and Cancel. The picked mode and a set Timer are a grey pill (`#34373f`); only the main button is coloured, and it stays focusable with `aria-disabled` while it is dimmed, so its tooltip can say what to do first. The middle section holds a held region's width, height and ratio presets (`SizeFields`, which the Record overlay's size chip beside its region shares) or, in Colour, the hex value the loupe writes into it as it draws. Every item has a tooltip (`Tipped`) that shows on hover and on keyboard focus and is the item's accessible description: its name, its chooser key, its global shortcut as the tray, hub and Library show it (`effective_hotkeys`: only shortcuts that registered, or the desktop's trigger descriptions on Wayland), and one line of use. There is no hint line, except for an error. `toolbarLayout` (`src/overlay/chooser.tsx`) picks the layout from the viewport's width, from what one row needs with a region held: below 1440 px unselected modes show only their icon and key, below 1180 px the ratios fold into one menu, and below 1080 px the middle section takes a second row, with the actions wrapping below the modes when they do not fit beside them. A held selection under the toolbar sends it to the bottom edge. `Enter` confirms a held selection, or in Window captures the window under the pointer and in Colour copies the pixel under it. Over a toolbar the pointer stands for where it last rested (about 150 ms without moving, `src/overlay/pointerRest.ts`) before it got there, so the main button acts on the window or pixel pointed at rather than one crossed on the way; the highlight, loupe and hex value stay on that target. `Tab` reaches the toolbar, the arrow keys move within a group, and `Esc` on a focused item leaves the toolbar before the next one cancels. The global shortcut cancels a chooser already opening or open. Each opening claim has a session ID so a cancelled worker cannot publish its frames into a later selection. The tray, hub and Library show shortcuts from successful native registrations, or the desktop’s trigger descriptions on Wayland. Chooser keys `1`–`7` select a mode and `8` cycles the timer. Record stays in this toolbar (see Recording below). Switching modes only changes what the page does with the frozen image already on screen; the toolbar's intent, mode and Timer reach `overlay_finish` as its `choice`, which an overlay opened for one mode ignores. Screen sends `{ kind: "screen" }` and saves every frozen monitor stitched. For both Capture & record… and direct Screen captures, the sidecar’s `scaleFactor` determines the size the editor opens at. On macOS, the stitched image uses the densest monitor’s scale. Windows and Linux keep each monitor’s physical pixels and record the shared scale when all monitors match, or 1.0 when they differ. With the Timer on, `overlay_finish` closes the overlay and captures live after the delay: a region through Repeat last region (the region is remembered first), a window by its id and the screen through Screen. On Wayland Capture & record… opens the portal's picker, as Region does.

The overlay has to appear the moment it is asked for, so a spare overlay window per monitor is kept hidden with its page already loaded, and replaced after each selection. On macOS the overlay is a see-through window (hence `macOSPrivateApi` in `tauri.conf.json`), shown as soon as the monitors are frozen; the frozen image reaches the page a moment later and slots in underneath. On Windows each monitor is copied into a bitmap and put on screen at once in a bare window of its own (`freeze.rs`): layered, on top and taking no focus, so menus and tooltips stay as they were captured. The page needs a few hundred milliseconds to receive and decode a frozen monitor, and while the overlays waited for that the desktop stayed live, so moving content jumped back to the older frame when they appeared. The overlays are see-through and are shown together over the frozen screens once every page knows what to show (`overlay_ready`), each frozen screen kept directly under its overlay (`freeze::Order::keep_under`). Their images follow as on macOS, and the loupe shows once its image has arrived. The overlays and the frozen screens have the fade Windows gives a window that appears or goes turned off (`freeze::without_transitions`): over a whole screen it was the desktop dimming and brightening. If a frozen screen cannot be shown, the monitors are captured through xcap as on the other platforms and the overlays open over the live desktop. If a page stalls, Grab-it ends the selection. On X11 each overlay waits for its own image.

Nothing heavy happens while a selection is on screen. The frozen image is encoded for the page on its own thread the moment the monitors freeze (`overlay::encode_for_page`), never on the main thread. On macOS it is an uncompressed BMP: WebKit took about 100 ms to decode a 5K screen as PNG and under 30 ms as a BMP, so the loupe and the hover blur have the image sooner. Elsewhere it is still a PNG. On macOS the window list is read in one pass over the window server's list (`screen::windows_and_foreground`) rather than through xcap, which fetches the whole list again for every property of every window, and only ordinary app windows are offered for hovering. The blur around a hovered window is drawn once per selection into a small canvas (`src/overlay/backdrop.ts`), not by a CSS filter. The OCR queue waits while an overlay is open. On macOS, WebKit draws a page at most 60 times a second even on a 120 Hz ProMotion display, so a dragged selection moved in steps behind the cursor; the overlay's webview turns that off (`overlay::render_at_display_rate`, WebKit's internal "Prefer Page Rendering Updates near 60fps" feature) and keeps up with the display. The tint fills the viewport until there is a selection or a hovered window. On Windows it cuts the selection out of the viewport-sized tint using CSS pixels, so tinted areas reach the edges on a scaled display. On macOS and X11, a transform moves four solid pieces around the selection without repainting them. The selection's border uses transforms for its four edges and corner ticks on every platform (`stretch`, `surround` and `frameParts` in `src/overlay/geometry.ts`). A pointer move is rendered before its event returns (`flushSync`), and nothing that follows the pointer may have a transition: one of any length shows the old position for a frame. That is why `App.css` answers `prefers-reduced-motion` with `transition: none` and not with a very short duration, which made every element transition every property it changed. Set `GRAB_IT_TRACE_OVERLAY=1` to print how long freezing, listing windows, showing the overlay and encoding the image took. To time hovering and dragging, see [Capture overlay bench](#capture-overlay-bench).

### Clipboard sound

`file_clipboard.rs` reports one successful logical write to `clipboard_sound.rs`.
A guide offers HTML and Markdown together, and a macOS image can offer PNG and
TIFF together. Each pair produces one confirmation. For Capture text, the first
successful copy can play the sound even when the text comes from AI. An automatic
AI replacement of text already copied by OCR is silent.

The `copySound` setting defaults to `true` when the file has no saved value,
including an older file that omits it. A saved `false` stays off.
`copySoundVolume` is a whole percent from 0 to 100 and defaults to 50; a value
out of range is clamped and one that is not a number keeps 50.
`clipboard_sound::Preference` holds the flag and the volume, so copies read
both without the settings lock. Each copy or preview reads the volume when it
starts, and `sample_at` scales every sample by it as a linear gain, for the
Linux ALSA frames and the Windows and macOS callback alike. At 0% nothing plays
and no output opens. The approved WAV is never rewritten to change its
loudness. Preview, the play button beside the switch, bypasses the flag but
uses the volume. A recording session suppresses both sounds during countdown,
recording and pause. Starting a session cancels active and
pending playback.

The approved WAV is embedded in the binary. Its checksum and provenance are
recorded under `src-tauri/sounds/`. Playback runs on a worker thread. On Windows
and macOS it opens the default output through CPAL (WASAPI and Core Audio), and
an underrun or a device change does not stop it. On Linux it opens ALSA's
`default` PCM, which a desktop routes to PulseAudio or PipeWire. It asks for a
500 ms buffer, writes the whole 260 ms clip at once, as aplay and ffmpeg do, and
waits for the output to drain. A callback stream refilling two small periods
underran while a closing overlay kept the CPU busy, and the plugin then failed
or stalled. The clip is already queued, so a busy moment cannot cut it short. A
recording start drops the queued sound at once. On Linux each sound has a 3 s
deadline from opening the output to its end. On Windows and macOS the output has
up to 2 s to take the whole clip, then up to 2 s more to finish playing it.

If no output opens, a clipboard copy still succeeds and Settings reports an error
when asked to preview. An output that opens and then stops part-way is only
logged, so Preview shows no error for it.

### Wayland and macOS

- **Wayland** (`WAYLAND_DISPLAY` set): captures go through the desktop's Screenshot portal, and Pick a colour uses the desktop's colour picker. Hotkeys are offered to the desktop through the GlobalShortcuts portal; where the desktop has no such portal, use the tray menu. Repeat last region and recording are not available, since only the desktop may read the screen there.
- **macOS**: Grab-it needs *Screen Recording* permission under System Settings → Privacy & Security, and offers to open that page when the permission is missing. Recording with the microphone also needs the *Microphone* permission, asked for the first time, recording with Show clicks or Show keystrokes needs *Input Monitoring*, and Show webcam needs the *Camera* (see [Recording](#recording)).

### Recording

**Settings → Recording** picks what recordings are saved as (`recording` in `settings.json`): `format` is `mp4` (the default) or `gif`; `quality` is `low`, `medium` or `high` (the default) and `fps` is `30` (the default) or `60`, both for MP4 only; `showCursor` (on by default) draws the pointer into MP4s and GIFs alike; `showClicks` and `showKeystrokes` (both off by default) draw click rings and a keystroke label into them (see [Clicks and keystrokes](#clicks-and-keystrokes)); `audio` is `none` (the default), `microphone`, `system` (what the computer plays) or `both` (the two mixed), with `microphone` naming the one to record (`null`, the default, records the system's default microphone); `removeNoise` (off by default) removes background noise from the microphone of an MP4 (see [Background noise](#background-noise)); and `showWebcam` (off by default) shows the camera named by `camera` (`null`, the default, is the system's default camera) in a bubble whose `webcamShape` is `squircle` (the default; `rounded`, its old name, still loads as it), `round`, `arch`, `pill`, `wide` or `blob`, shown mirrored unless `mirrorWebcam` (on by default) is off (see [Webcam](#webcam)); and `countdown` is `0` (the default), `3`, `5` or `10` seconds counted down on the recording toolbar before the first frame. A GIF is always silent, so the page disables **Audio**, **Microphone** and **Remove background noise** for it, and **Remove background noise** too while **Audio** records no microphone. **System sound** and **Microphone and system sound** are offered only where system sound can be recorded (`recording_system_audio`): Windows, Linux and macOS 13 or later. A saved choice is still shown on an older macOS, which records only the microphone for it and says so on the card.

Record opened on its own shows a **setup toolbar** (`src/overlay/RecordSetup.tsx`) the moment it opens, in the recording toolbar's pill and palette: a grip, the source (Region, Window or Screen, keys `1` to `3`), the recording options (`RecordOptionsFields`: format and frame rate, the microphone (none, the default or one by name), the webcam, and system sound, Remove background noise, clicks and keys as icon toggles), the countdown, **Record** and Cancel. Every item has a tooltip (`Tipped`, `src/overlay/Tipped.tsx`, shared with Capture & record…'s toolbar) in place of a hint line; the hint line stays only for an error and on a display with no setup toolbar until it is clicked. Each choice is saved to `recording` as it is made (`set_recording`), the source included (`recording.source`, `region` by default), so Settings and the next recording follow it and Record opens on the source used last. Record, like `Enter`, is dimmed with `aria-disabled` until something is picked, and its tooltip says what to pick:

- **Region** keeps the held selection with its handles, Shift, Space, the size field and the ratios, in a chip beside it without a button of its own; a clicked window's area is held too.
- **Window** picks the window under a click and holds the area it covers when recording starts, outlined in violet with its name and size.
- **Screen** outlines the whole display with its name; it starts picked on the display the pointer is on (`OverlayInfo::pointer_here`), and a click picks another.

Window and Screen send their area to `overlay_finish` as a region selection, so recording is still one rectangle on one monitor (`record::start`). The toolbar shows on the overlay of the display the pointer is on, or one with a pick of its own, centred where the recording toolbar would open on that display (`OverlayInfo::bar_centre`, from `record_bar::position_at` at the pill's size). It follows its grip by a `transform` alone, without a transition; when it is let go, `record_bar_remember` saves a pill-sized area centred on it as that display's `record_bar::Spot`, so both toolbars open centred on the same point. In Capture & record…, Record has no setup toolbar: Region, Window and Screen in the chooser's toolbar (and keys `1` to `3`) pick the source, Record stays pressed with its dot red, the middle section holds `RecordOptionsFields`, the Timer's place (and key `8`) is the countdown, and the main button is a red **Record**. Record or `6` again goes back to screenshots. Record lays the toolbar out as a display 400 px narrower would (`RECORD_ROOM`), so below 1840 px the microphone and webcam chips shrink to their icons (their tooltips name the choice) and below 1480 px the options move to a second row. A region keeps its size chip beside it, as in Record on its own, and a held area under the toolbar sends it to the bottom edge.

While it records, the **recording toolbar** (`record_bar.rs`, the `record-bar` window on the `#/recordbar` route, `src/recordbar/`) floats over the screen in place of the old Quick Access card: a small pill with the elapsed time (paused time left out), a mute button and level meter for the microphone (or system sound when there is no microphone), a labelled **Pause** (**Resume**, with an amber dot and PAUSED, while paused), a labelled red **Stop** pill the size of the setup toolbar's Record, and a **⋯** menu with the sound and webcam toggles, **Restart**, **Discard** and **Move back to the top**. The window is see-through and fitted to the pill (`record_bar_fit`), growing under or, in the lower half of the display, over it while the menu is open. Its state comes from `record::BarStatus` through `record_bar_status` and the `record-bar-status` event; the microphone's level is read from the WAV sink (`audio::Meter`) through `record_bar_level`.

The toolbar is dragged by its body and remembers where it was left on each display, in `record-bar.json` in the app data directory: the corner of the display's work area it was nearest and its distance from that corner in points (`record_bar::Spot`), keyed by the monitor's name, and the display it was last left on. A recording opens it on that display while it is connected, else on the display being recorded, at its spot there or at the top centre, always clamped into the work area. Windows and macOS leave it out of the recording (`content_protected`, which is `WDA_EXCLUDEFROMCAPTURE` and `NSWindowSharingNone`); X11 cannot, so there a toolbar that would cover the recorded area opens just outside it (`record_bar::clear_of`), or where it is when there is no room. On Linux the window is resizable, since GTK keeps a window that may not be resized at the size it was built with; with no frame there is nothing to resize it by.

Every recording also outlines what it records (`record_frame.rs`, the `record-frame` window on the `#/recordframe?shape=…&margin=…&protected=…` route, `src/recordframe/`). The window is borderless, see-through, always on top, never focused, content-protected like the toolbar, and click-through (`set_ignore_cursor_events`); it is the recorded area grown by 6 points on every side (`record_frame::frame_around`), and the page draws only in that margin, a 1px dashed red edge and 3px solid corner brackets just outside the area, so they never land in the video even on X11. `shape` is `window` when the setup toolbar's source is Window, `screen` (brackets only, in the display's own corners, with no margin) when the area is the whole image, and `region` otherwise (`record_frame::shape_for`). A window's outline has rounded corners only where the outline is left out of the capture (`protected=1`), since a rounded edge bends past the area's corner into it; where it is not (`protected=0`, Linux) a window's outline stays square and a display's brackets go once the countdown ends. While counting down it shows the big number in the middle of the area, from `record_bar_status` and the `record-bar-status` event (`record_bar::changed` emits it while either window is open, granted to it in `capabilities/floating.json`), and drops it as the countdown ends, before the first frame. It opens beside the toolbar in `record::start`, stays through Restart, and is destroyed wherever the toolbar is closed.

A recording stops from the toolbar's Stop, from the tray's **Stop recording**, or from the Record or Capture & record… shortcut pressed again: `actions::start` stops a recording under way for both (`Action::stops_recording`) instead of opening an overlay.

**Pause** stops grabbing frames. For an MP4 the sound keeps recording, and the paused stretch is kept as a gap (`record::Pacer::resume`) that is cut out of it as dropped frame times are (see below); a GIF shows the frame before the pause only as long as it was on screen, and the pause does not count towards its minute. **Mute** writes silence in place of what the microphone or system sound hears (`audio::Sound::set_muted`), so the track keeps its length. **Restart** and **Discard** stop the recording and delete it; Restart then records the same area again, countdown included. Stop during the countdown records nothing.

An MP4 is recorded at a constant 30 or 60 fps with no time limit (`record::record_mp4`). Each grab of the recorded area is piped into ffmpeg's stdin as raw RGBA (`-f rawvideo -pix_fmt rgba`), and ffmpeg writes H.264 in yuv420p at even dimensions, at most 1920 px wide, with `-movflags +faststart` so it plays while it downloads. A grab that takes longer than a frame repeats the frame before for every frame time that went by (`record::Pacer`), so the video keeps time, but only up to half a second of repeats after each grab, with Stop checked between them. Frame times further behind than that are dropped, so a fresh frame is always grabbed soon: when ffmpeg takes frames in more slowly than the frame rate, or the computer sleeps mid-recording, the video is shorter than the recording. The bitrate is the quality's bits per pixel of each frame: 0.05 for low, 0.1 for medium and 0.2 for high, about 12 Mbit/s for 1080p at high. A GIF is still encoded in Grab-it at about 10 fps, scaled to at most 1280 px wide, and stops after a minute.

Frames are grabbed in the fastest way each platform has (`frames.rs`, with the pointer code in `pointer.rs`, which captures share), so 60 fps holds:

- **X11**: only the recorded area is read (`Monitor::capture_region`), not the whole monitor. The pointer is drawn in from the XFixes cursor image, through x11rb's pure-Rust connection, so no extra system libraries are needed.
- **Windows**: DXGI desktop duplication (xcap's `Monitor::video_recorder`), cropped to the area. Each monitor's duplication is opened once, by the first recording on it, and is then started and stopped for each recording: xcap's duplication thread never ends, so a new one each time would pile up until DXGI refused more. Duplication only sends a frame when the screen changes, so the newest one is reused until then, and GDI grabs stand in until the first arrives or when duplication cannot start (over Remote Desktop, say). The pointer is drawn with `GetCursorInfo` and `DrawIconEx`, which also gets inverting pointers such as the I-beam right.
- **macOS**: Grab-it's own `AVCaptureScreenInput` session, cropped to the area (`cropRect`) and limited to the frame rate (`minFrameDuration`). It draws the pointer itself when `capturesCursor` is set from Show cursor; xcap's own recorder cannot leave it out. If the session cannot start, the whole monitor is grabbed and cropped as before, without the pointer.

With **Audio** set to **Microphone**, the microphone is recorded alongside the video (`audio.rs`); with **System sound**, what the computer plays; with both, each into a WAV of its own. Each starts just before the first frame is grabbed and is written to a 16-bit PCM WAV in the temporary folder, noting when its first sample was heard (the time its first chunk arrived, less that chunk's length). The microphone is read:

- **macOS and Windows**: [cpal](https://github.com/RustAudio/cpal) reads it through Core Audio or WASAPI. The picker lists cpal's input devices by name.
- **Linux**: ffmpeg's PulseAudio input reads it (`ffmpeg -f pulse -i <source> -f s16le pipe:1`, which PipeWire's Pulse server answers too) and pipes raw 48 kHz mono samples to Grab-it, so building Grab-it needs no ALSA or Pulse headers and cpal is not used there. The picker lists `ffmpeg -sources pulse`, leaving out `.monitor` sources (system sound), so it fills in once ffmpeg is ready.

The system sound is read:

- **Windows**: cpal opens the default output device for input, which is WASAPI loopback of what it plays.
- **Linux**: ffmpeg's PulseAudio input reads the default output's monitor source (`-i @DEFAULT_MONITOR@`), in 48 kHz stereo.
- **macOS 13 and later**: an audio-only ScreenCaptureKit stream of the main display (`audio/system_mac.rs`), with Grab-it's own sound left out. The stream still captures the display, so it asks for a 2×2 picture once a second and throws it away; it needs the *Screen Recording* permission recording already has. ScreenCaptureKit is weakly linked (`build.rs`), so Grab-it still starts on macOS before 12.3, where it is missing. Before 13 it records no sound, so System and Both are not offered.

WASAPI loopback sends nothing while nothing plays, so whenever a chunk of system sound arrives more than 100 ms later than the samples so far account for, that stretch is kept as silence (`audio::missing_frames`), and the sound stays in step with the video. The silence is not written while recording: it is filled in when the sound is cut to the video (`audio::Captured::cut`), so silence the video skipped, an hour of sleep say, never reaches the WAV. A recording during which nothing played has no system sound, and the card says so.

When the recording stops, ffmpeg muxes the WAV into the MP4 as AAC (its own `aac` encoder, 160 kbit/s), copying the video as it is (`ffmpeg::add_audio`). For Both, the two WAVs become one AAC track: each is brought to 48 kHz stereo (`aformat`) and they are mixed with `amix` (`normalize=0`, so each keeps its own level rather than being halved); there is never a second audio track. Each sound is shifted by the gap between the first frame and its first sample (`audio::offset`): sound heard before the first frame has its start cut (`-ss` on the WAV), and sound that started later is delayed with silence (`adelay`). Frame times the video dropped because it fell too far behind (`record::Pacer`) are cut out of the sound first (`audio::Captured::cut`), so the sound after them stays in step. It is then padded or cut to the video's length. The muxed copy replaces the MP4 only once finished, and the WAVs are deleted. If a sound cannot start or sends nothing, the video keeps whatever other sound worked, or is kept silent, and the card after it says which is missing and why; if the sound cannot be muxed in, the video is kept silent.

When the microphone was recorded and its sound muxed in, each source is also kept unmixed beside the MP4 in `<name>.sound.m4a` (`record::sound_path`), written by its own ffmpeg run from the same WAVs before they are deleted (`ffmpeg::sound_args`, `ffmpeg::write_sound`): `a:0` is the microphone and `a:1` the system sound when it was recorded, each AAC at 160 kbit/s, shifted, cut and padded to the video exactly as the mux does, but neither resampled nor filtered, so the sources stay as they were heard. The MP4 keeps its one mixed track, so shared files play as before. If it cannot be written, it is logged and the recording is kept without it. Recordings with system sound alone, and GIFs, get no sound sidecar. Renaming, duplicating, deleting, trashing and cleanup take it with the recording (`library::extra_files`), as discarding a recording does (`record::remove_recording`).

On macOS the first recording with the microphone asks for the *Microphone* permission (`permissions::ensure_microphone`), with the reason in `src-tauri/Info.plist` (`NSMicrophoneUsageDescription`), and waits for the answer before it starts. Once refused, Grab-it offers to open Privacy & Security → Microphone, and records without sound until it is allowed.

To check a recording's sound, `ffprobe -v error -show_entries stream=codec_name,duration <recording>.mp4` should list an `aac` stream about as long as the `h264` one, and only one `aac` stream for Both; the same on `<recording>.sound.m4a` lists one `aac` stream for each source. On Linux, play something (`paplay /usr/share/sounds/freedesktop/stereo/complete.oga`, say) while recording System or Both to hear it in the result.

Beside each MP4, `<name>.cursor.json` says where the pointer was, whether or not it was drawn, for later edits such as zooming in on it:

```json
{ "version": 1, "width": 1920, "height": 1080, "fps": 60, "positions": [[812, 433], [815, 431], null], "audio": ["microphone", "system"], "removeNoise": true }
```

`width` and `height` are the video's size, and `positions` holds one entry for every frame of the video, repeated frames included: the pointer's hot spot in the video's pixels from its top-left corner, which lies outside that size when the pointer is outside the recorded area, or `null` where it could not be told. `audio` lists the sources the MP4's sound holds, in the sound sidecar's stream order (`microphone`, then `system`), and is empty when the recording is silent or its sound could not be muxed in. It is absent in recordings made before it was saved. `removeNoise` is `true` when background noise was removed from the microphone in the MP4's sound (see [Background noise](#background-noise)), and absent otherwise and in older recordings. A GIF gets no sidecar.

#### Background noise

With `removeNoise` on and the microphone recorded, the mux removes background noise from the microphone alone with ffmpeg's `arnndn` filter (RNNoise), placed before its `adelay` and `apad` (one track) or its `aformat` (mixed with system sound), so the delay's silence is not run through the model (`ffmpeg::mux_args`, which `ffmpeg::AudioTrack::microphone` tells which track to filter). System sound is never filtered, nor is the sound sidecar, so `<name>.sound.m4a` keeps the microphone as it was heard. The model is `beguiling-drafter-2018-08-30/bd.rnnn` from [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models) at commit `3eee541a`, about 300 KB, whose author places it outside copyright. It is bundled like the face model: committed in `src-tauri/noise-models/` with its notice, listed under `bundle.resources`, its SHA-256 pinned in `noise::tests::MODEL_SHA256` and in `LICENSE.md`, and found under the resource directory when the recording starts (`noise::bundled_model`). `.gitattributes` keeps a Windows checkout from changing its line endings, which would break the checksum. Its path is escaped twice for the filter graph (`ffmpeg::escape_filter_value`), once for the option and once for the graph, since a Windows path holds `\` and `:`. Without the model the recording is kept unfiltered and it is logged. If the filtered mux fails, say with an ffmpeg older than 4.3 that has no `arnndn`, it is logged and the sound is muxed again unfiltered (`record::mux_removing_noise`), so `removeNoise` is saved only when the filter ran. Nothing leaves the computer.

#### Clicks and keystrokes

With **Show clicks** or **Show keystrokes** on, the mouse and keyboard are watched for as long as the recording runs, and what they did is drawn into each frame after the pointer and before it is encoded (`frame_overlays.rs`), so no window of its own is shown on screen and recorded with it. MP4s and GIFs get them alike.

- **Input** (`input.rs`): [rdev](https://github.com/Narsil/rdev)'s `listen` hooks global input: an event tap on macOS, low-level hooks on Windows and XRecord on X11. Wayland has no such access, and recording is not offered there. `listen` never returns once it runs, so its thread is started by the first recording that wants it and kept for the life of the app; each recording connects to it (`input::Capture`) and disconnects when it stops, and between recordings events go to no one. rdev is taken from its main branch at a fixed commit: its last release looks key names up on the tap's own thread on macOS, which macOS 14 aborts.
- **Clicks**: each left, right or middle button press becomes a ring where the pointer was in the first frame grabbed after it, in that frame's pixels whatever the platform, growing from 14 to 26 points and fading out over 0.5 s (`frame_overlays::ring_alpha`).
- **Keystrokes**: each key press, with the modifiers held, becomes a label such as `⌘ ⇧ 4` on macOS or `Ctrl Shift 4` elsewhere, from Grab-it's own key table (`input::KeyStyle`) rather than rdev's layout-dependent names. A modifier pressed on its own shows nothing. The label of the last keys sits at the bottom centre, white on a dark rounded box, shrinking to fit a narrow recording; it stays 1.5 s after the last key and then fades over 0.25 s (`frame_overlays::label_alpha`). Its text is drawn with [ab_glyph](https://github.com/alexheretic/ab-glyph) in `src-tauri/fonts/DejaVuSans-Bold-keys.ttf`, DejaVu Sans Bold cut down to printable ASCII, the arrows and the macOS key symbols (licence beside it).
- **Passwords**: on macOS no key is kept while secure input is on (`IsSecureEventInputEnabled`), as it is while a password field has the focus. Windows and X11 cannot tell, and the setting's hint says so.
- **Permission**: on macOS a recording with either toggle on first asks for *Input Monitoring* (`permissions::ensure_input_monitoring`, `CGRequestListenEventAccess`), and once refused offers to open Privacy & Security → Input Monitoring. Without it the recording goes ahead without clicks or keystrokes, and the card says so. If the hooks cannot start (no X RECORD extension, say), the recording goes ahead without them too.

Sizes are in points times the monitor's scale factor, so they look the same on a HiDPI recording.

#### Webcam

With **Show webcam** on, the camera is shown in a bubble on screen for as long as the recording runs (`webcam.rs`), and is recorded with the screen like any other window, so MP4s and GIFs get it alike and the recording has no separate camera track.

- **Window**: a borderless, see-through, always-on-top window labelled `webcam`, showing `#/webcam?shape=…&mirror=0&camera=…` (`src/webcam/`; `mirror=0` only when mirroring is off), so the page needs nothing from the backend. It opens as the recording starts, before the settle delay so the camera is running by the first frame, at the bottom-right corner of the recorded area: 200 points across for a round or square bubble, at most 40% of the area's shorter side and at least 72 points, 24 points in from its edges (`webcam::place`). The arch (0.88 × 1.10 of that), pill (0.84 × 1.20) and wide (1.28 × 0.80) shapes take about the same area, and shrink to fit a narrow area. The window is 24 points larger on every side (`webcam::with_shadow_room`): the bubble's shadow falls in that see-through room. It never takes the keyboard focus. Drag it anywhere (`startDragging`, granted to it in `capabilities/floating.json`); it is destroyed when the recording stops.
- **Camera**: the page opens the chosen camera with `getUserMedia` (video only), and the default camera when the chosen one is gone; the video fills the bubble, cropped to its shape. Each shape is one outline in a 1 × 1 box (`src/webcam/shapes.ts`), used as an SVG clip path in `objectBoundingBox` units for the bubble and the video and as its two hairline edges; the blob's outline is animated between three. The bubble has a three-layer `drop-shadow`, which follows any outline. While the camera starts it shows a slow pulse; the video fades in 150 ms after its first frame, once the exposure has settled, and mirrored video gets a mirrored clip so it lands back on the outline. When no camera starts, the bubble says why ("Camera not allowed", "No camera found"…), and the recording goes ahead.
- **Picker**: Settings → Recording lists the webview's cameras (`enumerateDevices`). Their `deviceId` is what `camera` saves. Webviews hide camera names until a camera has been allowed, so turning Show webcam on opens the camera for a moment, which also asks for the permission where the system wants one; until then cameras are listed as "Camera 1", "Camera 2" or not at all.
- **Permissions**: the `webcam` and `main` windows grant the camera, and only the camera, to their page (`webcam::allow_camera`, the webview's permission request: WebView2's `PermissionRequested`, WebKitGTK's `permission-request` and WKWebView's media capture delegate). WebKitGTK also leaves media streams off unless asked, so those windows turn them on and load their page again (`webcam::enable_media_streams`). On macOS the first use asks for the *Camera* permission, with the reason in `src-tauri/Info.plist` (`NSCameraUsageDescription`); refused, the bubble says "Camera not allowed" until it is allowed under Privacy & Security → Camera. On Linux, WebKitGTK reads the camera through GStreamer, so its PipeWire or V4L2 plugins must be installed.

ffmpeg is not bundled (see [ffmpeg builds](#ffmpeg-builds)). With MP4 chosen, Grab-it gets it ready in the background when it starts, or as soon as MP4 is picked in Settings (`ffmpeg.rs`):

1. `GRAB_IT_FFMPEG`, when set, names the ffmpeg to use, and nothing else is tried.
2. Otherwise each ffmpeg already on the computer is tried, in order (`ffmpeg::system_dirs`): every directory on `PATH`, then where package managers put it, since an app opened from the Dock, Finder or Start menu often lacks those on its `PATH`, and one installed after Grab-it started never has them. That is Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) and MacPorts (`/opt/local/bin`) on macOS; winget's links, Chocolatey and Scoop on Windows; and `/usr/local/bin`, `/usr/bin`, Linuxbrew and `~/.local/bin` on Linux. A directory linked to one already searched, such as `/bin`, finds the same ffmpeg only once.
3. Then the copy Grab-it downloaded earlier to `ffmpeg/` in the app data directory.
4. When none of those can encode H.264, this platform's [FFmpeg-Builds](#ffmpeg-builds) build is downloaded, checked against the SHA-256 compiled into `ffmpeg.rs`, and its `bin/ffmpeg` is taken out and moved there. Linux and Windows, x64 and arm64, have one. macOS has none: the Recording page says to install it with `brew install ffmpeg` and press **Retry**.

The Recording page shows the download's progress, and **Retry** when ffmpeg is not installed or could not be set up. Each ffmpeg's H.264 encoders are tried by encoding one frame, in this order, and the first ffmpeg with one that works is kept with it until Grab-it quits: `h264_videotoolbox` on macOS; `h264_nvenc`, `h264_qsv`, `h264_amf` and `h264_mf` on Windows; `h264_nvenc` and `h264_vaapi` (on `/dev/dri/renderD128`) on Linux; then `libx264`, which package managers' ffmpegs usually have, and `libopenh264`, which the downloaded builds have, everywhere. The page names the ffmpeg and the encoder chosen. A copy downloaded on an earlier run that no encoder works with is deleted, so it is downloaded again.

A recording started while ffmpeg is not ready yet (still downloading, not installed, or failed) is saved as a GIF, and the card after it says why. When MP4 is ready the card counts up with no limit and says **Video saved** when done.

The card after a recording is laid out like a capture's: a frame of the recording (`quick_thumbnail`: a GIF's first frame, an MP4's from a second in, decoded by ffmpeg through `ffmpeg::video_frame`) with its length and file size, **Video saved** or **GIF saved**, and **Edit** (MP4 only), **Show in folder** and **Delete**. Clicking the frame plays the recording in the system's player (the `open` action). Why an MP4 was saved as a GIF shows as a line above the buttons.

### Recordings in the library

Recordings are rows in `library.db` beside captures (schema 4): `kind` is `image` for a capture, `video` for an MP4 and `gif` for a GIF, with `duration_ms` and `bytes`. A recording joins the library when it is saved or exported (`library::record_recording`), and a rescan adds the MP4s and GIFs in `<save folder>/recordings/` that it does not know. Their length and size come from the recorder, else from `ffmpeg -i` (`ffmpeg::probe_file`); a recording found before ffmpeg was ready is read again by the rescan that runs once it is. Their thumbnails go in `recordings/thumbs/` and are made when first shown: an MP4's needs ffmpeg, so until it is ready the tile shows a film icon. Recordings are never read by OCR or described: they start out read with no text and skipped, and the OCR and AI queues only take `kind = 'image'`.

In the Library a recording's tile has a play badge and its length, and **Play**, **Edit** (MP4 only) and **Show in folder** on hover. Double-clicking opens an MP4 in the recording editor and plays a GIF (`library_open`); **Play** opens either in the system's player (`library_play`). Its details have the same actions, its size, length and file size, and its tags and notes, but no text or description. Deleting one removes its pointer, sound and edits sidecars and closes its editor. **Recordings** in the sidebar, or **Type** in the filter menu of the Library window, narrows the library to recordings (`kind` in `SearchQuery`: `image` or `recording`).

To try MP4 recording with a particular ffmpeg, point `GRAB_IT_FFMPEG` at it:

```sh
GRAB_IT_FFMPEG=/path/to/ffmpeg npm run tauri dev -- -- -- --open record
```

### Recording editor

An MP4's Quick Access card has **Edit**, which opens the recording in a recording editor window (`recording-<n>`, on the `#/recording` route; `windows::show_recording_editor`), or focuses the one already showing it. It plays the recording with a timeline holding a playhead and start and end trim handles (drag them, or focus one and use the arrow keys, Shift for a second at a time), and puts it on a backdrop with the capture editor's **Backdrop** panel and its saved presets. The backdrop's aspect ratio is the export's shape: Auto, 16:9, 4:3, 1:1 or 9:16 (9:16 is offered for captures too). GIF recordings have no editor.

The page plays the recording from the `grab-it-video` URI scheme (`grab-it-video://localhost/<path>`, `http://grab-it-video.localhost/<path>` on Windows, the path URI-encoded; `recording_editor::serve_video`). It serves only `.mp4` files directly in the current save folder's `recordings/`, compared by the files they name so `..` and symlinks reach nothing else, and answers `Range` requests at most 4 MB at a time (a request with no `Range` gets the first 4 MB of a longer file). macOS and Windows play straight from the scheme. WebKitGTK's GStreamer player only loads `http`, `https` and `blob:` URLs, so on Linux (`playsFromBlob` in `src/recording/api.ts`) the page instead fetches the whole file from the scheme, a range at a time until `Content-Range`'s total is reached (`fetchRecording`), and plays it from a `blob:` URL. The editor releases each preview's blob URL when the last clip using that recording is removed or the window closes. The scheme answers CORS preflights and exposes `Content-Range` for this.

Edits are kept in `<name>.edits.json` beside the MP4, saved as each change is let go and read again when the recording is reopened; the MP4 itself is never changed. A sidecar with a version this build does not know is never written over:

```json
{
  "version": 1,
  "trim": { "startMs": 1250, "endMs": 9500 },
  "backdrop": { "fill": "ocean", "padding": 64, "radius": 36, "radiusUnit": "pt", "shadow": true, "aspect": "9:16" },
  "zooms": [
    { "id": "z1", "startMs": 2000, "endMs": 4500, "scale": 2, "focus": { "kind": "area", "x": 0.25, "y": 0.4 } },
    { "id": "z2", "startMs": 6000, "endMs": 8000, "scale": 1.5, "focus": { "kind": "cursor" } }
  ]
}
```

`trim` is absent while the whole recording is kept, `backdrop` is the capture sidecar's (see `Backdrop` in `src/editor/model.ts`), `zooms` is absent without any (see [Zooms](#zooms)), and `removeNoise` is absent until **Remove background noise** is changed (see [Sound sources](#sound-sources)).

**Export** saves `<name> (edited).mp4` beside the original (`(edited 2)` and so on when that is taken) and shows it on the Quick Access card. The page lays the video out on its backdrop as captures are (`recordingLayout` in `src/recording/layout.ts`: padding, then the aspect ratio), scaled so the longer side is at most 1920 px and both sides are even: a 1920×1080 recording at 9:16 exports at 1080×1920. It paints the fill and shadow, and a mask of the video's rounded corners, as PNGs at that size and sends them with the plan (`recording_export`). Rust then has ffmpeg decode the trimmed stretch (`-ss` and `-t` on the input) as raw RGBA at the size the video takes, at the frame rate in `<name>.cursor.json` (30 without one), lays each frame over the backdrop through the mask (`recording_editor::Composer`), and pipes it into the H.264 encoder and quality recordings use. Each clip's trimmed sound is joined in order and added last as AAC (`recording_editor::clip_sound_args`; see [Joining recordings](#joining-recordings)), with background noise removed from the microphone or left in as the plan's `removeNoise` says (see [Sound sources](#sound-sources)). The progress panel under the timeline shows the percentage of frames written. Its **Cancel** button calls `recording_export_cancel` for this window. The renderer checks the flag between frames, including gaps. It also stops ffmpeg during source probing, encoder finalisation and audio muxing, then removes any unfinished output before the editor reports **Export cancelled**. A transparent fill exports as black, since a video has no transparency.

#### Zooms

A zoom shows a stretch of the recording larger, 1.25× to 4× in quarter steps, centred on a chosen area or following the pointer. Zooms sit on a row under the timeline (`src/recording/ZoomTrack.tsx`): **Zoom** in the top bar, or a double-click on an empty stretch of the row, adds a 2-second 2× area zoom there (shorter when the next zoom or the end is closer; at least half a second). Drag a zoom to move it and its edges to resize it; zooms never overlap. A selected zoom shows its controls in the top bar: **Area** or **Follow cursor**, **Scale**, and Delete (also the Delete key; the arrow keys move it). While an area zoom is selected and the recording is paused, the preview shows the whole frame with the zoomed area on it: press or drag to centre the area, or nudge it with the arrow keys. Edits are saved in `zooms` in the sidecar; times are in the recording, not the trimmed clip.

**Follow cursor** needs `<name>.cursor.json` and is disabled without it. Rust reads and smooths the pointer path once (`zoom::CursorPath::load`): each position is held inside the frame and made a fraction of it, a frame where the pointer was unknown keeps the last known point, and the path goes through an exponential filter with a 0.25 s time constant forward and then backward, so it neither lags nor leads. The page gets the smoothed path with the recording (`RecordingInfo.cursor`) and the export uses the same one, reading it between frames.

#### Sound sources

`recording_editor::audio_sources` lists a recording's sound sources, each by kind (`microphone`, `system` or `mixed`), file and audio stream, for waveforms and mixing to build on. With the sound sidecar, there is one for each entry of `audio` in `<name>.cursor.json`, at its stream in `<name>.sound.m4a`. Without it, the MP4's `a:0` is `audio`'s one entry, or `mixed` when `audio` names two (the sound sidecar could not be written). When `audio` is absent, or the pointer sidecar is missing or cannot be read, the recording is older: one `mixed` source when ffmpeg's probe of the MP4 finds an `Audio:` stream (`ffmpeg::Probe::audio`), and none without ffmpeg. The page gets the kinds with the recording (`RecordingInfo.audio`), and the status bar names them (**Microphone · System sound**), or shows **Mixed sound** with a tooltip saying the two can only be edited together, or nothing for a silent recording.

A recording keeps its microphone apart (`recording_editor::kept_sound`) when its first source is the microphone at `a:0` of the sound sidecar; system sound, when recorded, is its `a:1`. The page gets this as `separateMicrophone`, and whether the MP4's microphone had noise removed (the pointer sidecar's `removeNoise`) as `removeNoise`, on `RecordingInfo` and on each joined recording's `RecordingClipSource`. **Remove background noise** in the top bar is the edits sidecar's `removeNoise`, or the opened recording's `removeNoise` while that is absent; it is saved and undone like any edit, and disabled, with a tooltip, when no clip's recording keeps its microphone apart. The preview always plays the MP4 as recorded: the toggle changes only the export. The export plan carries it as `removeNoise`, and for each clip `recording_editor::sound_from` picks the sound: the MP4's `a:0` when the toggle matches the clip's `removeNoise` or the recording does not keep its microphone apart, and otherwise the sound sidecar's stretch, its microphone run through `arnndn` with the bundled model when the toggle is on (`ffmpeg::noise_filter`, after the trim so only the kept stretch is filtered) and mixed with its system sound at 48 kHz stereo with `amix` unnormalised, as the mux does (`ffmpeg::MIX_FORMAT`, `ffmpeg::mix`). The model is found when the export starts (`noise::bundled_model`); without it an export that would remove noise from a clip fails before encoding and says so.

The view at each moment is worked out the same way in the page (`viewAt` in `src/recording/zooms.ts`) and in Rust (`zoom::view_at`); keep the two in step. A zoom eases in over its first 0.3 s and out over its last (half its length each when it is shorter than 0.6 s) along a smoothstep, its scale growing as `scale ^ strength`. The view's centre is the area's or the pointer's, moved just far enough that the zoomed view stays inside the frame. The preview shows it with a CSS transform on the video, inside the video's rounded box.

On export each clip of the plan carries its zooms and its recording's size. Frames are then decoded larger than the place the video takes, as large as the deepest zoom needs up to the recording's own size (`ExportClip::decode_size`), and each is cut to its view and scaled to that place (`zoom::draw_view`: bilinear, averaging up to 4×4 samples a pixel when shrinking) before it is laid over the backdrop.

#### Joining recordings

**Recording** in the top bar adds another MP4 from the recordings folder (the folder of the recording the editor opened) after the clip under the playhead; the file picker opens there, and a file from anywhere else is refused. The sequence is a list of clips (`src/recording/clips.ts`), each `{id, source, startMs, endMs}`: `source` is a file name in that folder and the times are in that recording. A clip starts in the sequence at the sum of the earlier clips' kept lengths; `toSource` and `toSequence` map between the two, and later timeline, sound and overlay work should use them, addressing media by (source, ms) and clips by id. The timeline then shows the clips end to end (`src/recording/ClipTrack.tsx`): dragging a clip's edge trims it within its recording, dragging it or Alt + ←/→ reorders it, and Delete removes it unless it is the last. Every edit is one undo entry.

The sidecar holds the list only when the sequence is not a single clip of its own recording (`withClips`); otherwise it stays version 1 with `trim`, so an untouched or only trimmed recording reads in older builds:

```json
{
  "version": 2,
  "clips": [
    { "id": "own", "source": "Grab-it 2026-03-07 09-05-01.mp4", "startMs": 1250, "endMs": 9500 },
    { "id": "c2", "source": "Grab-it 2026-03-08 14-20-11.mp4", "startMs": 0, "endMs": 4000 }
  ],
  "zooms": [
    { "id": "z1", "startMs": 2000, "endMs": 4500, "scale": 2, "focus": { "kind": "cursor" } },
    { "id": "z2", "source": "Grab-it 2026-03-08 14-20-11.mp4", "startMs": 500, "endMs": 2500, "scale": 2, "focus": { "kind": "cursor" } }
  ]
}
```

With `clips`, `trim` is not written. A zoom keeps its recording's time and gains `source` (absent for the sidecar's own recording), so it moves with its clip; one outside its clip's kept stretch stays saved but is hidden. `validate_edits` reads versions 1 to 3 and refuses a clip whose source is not a bare file name. The Library gains nothing until Export.

The recording the editor opened sets the output size, the video box on the backdrop and the frame rate, whatever the order; other recordings are fitted inside that box, centred, with black bars (`fitInside`). `recording_source` gives the page another recording's path, frame rate, pointer path and whether it has sound, refusing anything that is not an MP4 in the folder; a recording that is gone shows as missing and disables Export. The preview keeps one video element for each recording in the sequence. At a cut it seeks the next clip's player to its start and continues playback. Other players stay mounted and paused so repeated seeks can reuse the same media and, on Linux, the same blob URL.

On export the plan holds the clips in order (`ExportClip`: source, stretch, the recording's size and its fitted box, its zooms), and gaps as `{gapMs}` (`ExportGap`; the two are `ExportEntry`). Rust resolves each source with `allowed_video`, decodes each clip in turn with its own `decode_args`, zooms and pointer path into one encoder at the opened recording's frame rate, and reports progress over all frames. The sound is one `filter_complex`: each clip's audio is `atrim`med, resampled to 48 kHz stereo and `concat`enated in order, and a recording without sound gives silence of the clip's length (`anullsrc`). Whether a recording has sound comes from `ffmpeg::Probe::audio`. Clips cut straight from one to the next.

#### Splitting and gaps

**Split** (`S`) cuts the clip under the playhead into two clips of its recording that meet at the playhead's time in it (`splitClip`); the first keeps its id. Each part keeps at least `MIN_CLIP_MS`, so Split is off nearer an edge, and splitting a recording that was one clip makes it a sequence. With a clip selected, **Duplicate** (Ctrl/⌘ D) inserts a copy under a new id after it, **Delete** (`Delete`/`Backspace`) removes it and closes the stretch it took (`removeClip`), and **Leave gap** (`Shift` + `Delete`) puts a gap of its length in its place (`leaveGap`). A sequence keeps at least one clip of a recording, so both deletes are off on the last one. A gap is selectable on the timeline and either delete closes it. Neighbouring gaps merge into one (`mergeGaps`), and gaps at the start or end stay. Selecting a clip or gap clears the zoom selection and the other way round, so one key acts once. Each edit is one undo entry and saves the sidecar.

In memory a gap is a `Clip` with `gap: true`, no `source`, and `endMs` its length from `startMs` 0, so `clipStarts`, `toSource` and the rest work unchanged; no zoom is ever on it. The sidecar holds it as `{id, gapMs}`, and a sidecar with a gap is written as version 3, which builds that read only versions 1 and 2 refuse, and so never write over. A sequence without gaps is still written as version 1 or 2:

```json
{
  "version": 3,
  "clips": [
    { "id": "own", "source": "Grab-it 2026-03-07 09-05-01.mp4", "startMs": 0, "endMs": 4000 },
    { "id": "g1", "gapMs": 1500 },
    { "id": "c2", "source": "Grab-it 2026-03-07 09-05-01.mp4", "startMs": 6000, "endMs": 12000 }
  ]
}
```

The preview shows a gap as the backdrop with a black video box: every player is paused and hidden, and while playing, the playhead runs on a `requestAnimationFrame` clock (`performance.now`) until the next clip, whose player then seeks and plays. The export renders a gap's frames (`ExportEntry::frames`, counted in the total and progress) as the backdrop with a black video box, or all black without a backdrop, and its sound as `anullsrc` silence of its length.

### Search and OCR

The text in each image is read in the background, one capture at a time, newest first. Tags, notes, app and window title are searchable straight away.

Every OCR path (the Library queue, Capture text, **Copy text** and Blur private details) goes through `Ocr::read_image`. On macOS it reads with Vision first (`src-tauri/src/ocr_vision.rs`): a `VNRecognizeTextRequest` at the accurate level with language correction on, in the system's preferred languages that Vision supports (`ocr_vision::pick_languages`; Vision's default before macOS 12, which cannot list them). Vision's boxes are normalised with the origin at the bottom left; `ocr_vision::pixel_rect` turns them into top-left image pixels, grown to whole pixels and clipped, and each word's box comes from `boundingBoxForRange:error:` on its UTF-16 range (the line's box when Vision gives none). Vision scales a very large image down until ordinary UI text is too small to read, so an image over 4096 px either way is read in overlapping tiles of at most 4096 × 4096 px, overlapping by at least 128 px (`ocr_vision::tiles`); each tile's boxes are moved into image pixels, and a tile offers the lines whose box centre lies in its core (the tile up to halfway through each overlap) or within 32 px past it (`ocr_vision::tile_lines`). Each tile measures a line on its own, so a line centred on a seam can fall just outside both cores. When two tiles' lines cover at least half of the smaller box, `ocr_vision::merge_tiles` keeps one: the one centred in its core first, then the larger, so the seams give no duplicates and lose no lines. Lines of one character are dropped, and lines of two when Vision's confidence is below 0.5 (`ocr_vision::keep_line`), which leaves out icons read as letters. Grab-it sets no macOS minimum, so `ocr_vision::read` looks `VNRecognizeTextRequest` up at runtime and gives `None` before macOS 10.15. When it gives `None`, or Vision fails (logged), the image is read with [ocrs](https://github.com/robertknight/ocrs) instead, as it always is on Windows and Linux. ocrs exposes no confidence, so only its one-character lines are dropped. The ocrs models load as before on every platform, as the fallback.

The same pass decodes any QR codes and barcodes in the image (`codes::decode`, as Capture text does) and appends their values to the stored text, one per line (`ocr::with_codes`), so search finds a capture by what its codes hold and **Copy text** includes them. The plain text is stored before decoding (`ocr::store_text`): release builds abort on a panic, so a capture that crashes the decoder is already read and is not retried on every launch. Captures read before this was added are not read again.

The two ocrs models (about 12 MB) ship with the app. They are committed in `src-tauri/ocr-models/` with their licence (CC BY-SA 4.0, see `LICENSE.md` there) and listed under `bundle.resources` in `tauri.conf.json`, so every package, `tauri dev` and the tests find them in `ocr-models/` under the resource directory without a network. A test pins their SHA-256 checksums (`ocr::tests::MODEL_SHA256`); to update them, replace both files, the checksums in the test and in `LICENSE.md`. If the models cannot be loaded, the Library says so and suggests reinstalling; the next capture tries again. Set `GRAB_IT_OCR_MODELS` to load models from another directory instead. Earlier versions downloaded the models into `ocr-models/` in the app data directory; Grab-it deletes that copy when it starts (`ocr::remove_downloaded_models`). Downloads (ffmpeg) and AI endpoints verify certificates against the operating system's trust store (`src-tauri/src/net.rs`), so they work behind TLS-inspecting proxies whose root CA IT has installed.

The editor's Blur private details (`src/editor/redact.ts`) matches emails, phone numbers, Luhn-checked card numbers and street addresses in the capture's word boxes: the ones the library stored, else read on demand by the `editor_words` command. Faces come from the `editor_faces` command (`src-tauri/src/faces.rs`), which runs the [UltraFace](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB) RFB-320 model (about 1 MB, MIT) with rten: the capture is resized to 320×240, boxes scoring at least 0.7 are kept, overlaps above IoU 0.3 dropped, and the rest scaled back to capture pixels. The published file uses ONNX opset 9, whose `Slice` rten cannot load, so the bundled copy is upgraded to opset 11 and simplified with onnx and onnxsim (the script is in `face-models/LICENSE.md`). rten 0.24 also panics running the graph's own box decoding, so `faces.rs` reads the raw box offsets (node `460`) and decodes them against UltraFace's prior boxes itself (`faces::priors`, `faces::decode`). The model is bundled like the OCR ones: committed in `src-tauri/face-models/` with its licence, listed under `bundle.resources`, its SHA-256 pinned in `faces::tests::MODEL_SHA256` and in `LICENSE.md`, loaded the first time it is used. Set `GRAB_IT_FACE_MODELS` to load it from another directory. Nothing leaves the computer.

The Library's **Copy text** copies a capture's stored OCR text (`library_copy_text`). A capture OCR has not read yet, or could not read, is read on the spot, codes included, and the result stored, as the queue would.

OCR also keeps where it found the text. Beside `ocr_text`, the `ocr_words` column of `shots` (migration 6) holds the lines OCR read as JSON: `[{text, x, y, width, height, words: [{text, x, y, width, height}]}]`, each box axis-aligned, in the pixels of the original PNG in `originals/` and clipped to it (`ocr::OcrLine`, `Library::set_ocr_lines`). Lines of one character are dropped, as from the text; the codes' values have no boxes. The frontend reads them with `shotWords(id)` in `src/library/api.ts` (the `library_words` command), which gives null for recordings, for captures waiting for or failing OCR and for captures read before word boxes were stored, which are not read again. Search and `shots_fts` use `ocr_text` only.

The search index is a SQLite FTS5 table in `library.db`, kept in step with each capture's tags, notes, text and AI description as they change.

### AI integration (optional)

Grab-it can ask a vision model to describe each capture: a sentence or two, a category (`code`, `terminal`, `browser`, `chat`, `document`, `design`, `error`, `receipt`, `photo` or `other`) and a few tags. The description and AI tags are searchable, the Library can filter by category, and the tag filter matches AI tags as well as your own. AI tags are stored apart from your tags.

Who describes captures is picked under **AI integration** in Settings (`ai.provider` in `settings.json`), the same page that holds the agent controls (`AgentsSection.tsx`). The old `agents` section id still routes there:

- **Claude Code** (`claudeCode`): Grab-it runs the `claude` CLI you already have installed and signed in to, headlessly, with the `haiku` model, no tools, no MCP servers and no saved session, in an empty temporary folder (see `ai_cli.rs`). Nothing else to set up or download. Screenshots go to Anthropic under your Claude account. Each description records `claude-code/haiku` as its model.
- **Codex** (`codex`): Grab-it runs the `codex` CLI you already have installed and signed in to, as `codex exec` in a read-only sandbox with no saved session, in an empty temporary folder holding only the capture and the JSON schema its answer must follow. It uses the model you configured for Codex, at low reasoning effort, and its stdin is closed. Screenshots go to OpenAI under your ChatGPT or OpenAI account. Each description records `codex` as its model.
- **OpenAI-compatible endpoint** (`endpoint`): any `/chat/completions` API: [LM Studio](https://lmstudio.ai), [Ollama](https://ollama.com), llama.cpp's server, or a cloud API such as OpenRouter or OpenAI.

AI integration is **off by default**, and Grab-it never turns it on by itself: finding `claude` or `codex` only lets Settings say whether the chosen CLI is missing. Three switches are independent: `ai.enabled` (**Use an AI provider**) lets Grab-it use the provider at all, `ai.automaticDescriptions` (**Describe captures with AI**) queues captures for describing, and `ai.tidyText` tidies Capture text. `automaticDescriptions` is absent in settings from earlier versions and then reads as on, so an upgraded user who had describing on keeps it on; an `ai` with `enabled: true` and no `provider` is still an endpoint user from before providers existed. When a user who never chose a provider turns the provider on, Settings starts `automaticDescriptions` and `tidyText` off.

The AI settings in Settings are a draft: nothing is saved until **Save**, and **Cancel** restores the saved values. **Test connection** sends the bundled `src-tauri/fixtures/connection-test.png` with the draft settings (`ai_test_connection` takes them) and persists nothing. Saving a draft that would describe existing captures (describing on with `newCapturesOnly` off, when it was not before) first shows the count of image captures from `ai_capture_count` and waits for confirmation; so does **Re-describe all…**.

`finish_first_run` sets `ai.noticePending` on the first launch only. While it is set and no provider was ever chosen, the Library shows a dismissible invitation to set up AI integration; **Choose a provider** opens Settings at that section, and either button clears it with `dismiss_ai_notice`. Turning the provider on also clears it. An upgraded user whose earlier version turned on Claude Code or Codex by itself, and who never dismissed that notice, still sees it naming the provider. The welcome window's last tip says AI integration is optional and off, or that Claude Code describes captures while it does.

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

For a cloud API, set the endpoint, model and API key. The **Preset** menu in Settings (`ENDPOINT_PRESETS` in `src/settings/api.ts`) fills in the URL and a vision model for the common ones, and shows each one's setup steps; you add the key and press Save:

| Preset | Endpoint | Model |
| --- | --- | --- |
| LM Studio | `http://localhost:1234/v1` | `qwen/qwen3-vl-4b` |
| Ollama | `http://localhost:11434/v1` | `qwen3-vl:4b` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-5-mini` |
| OpenAI | `https://api.openai.com/v1` | `gpt-5-mini` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-haiku-5-5` |

A preset is matched by its URL alone, so any typed model ID keeps it; any other URL shows as **Custom**. Presets only fill in fields: nothing new is saved, so existing endpoint settings, CLI providers and custom URLs load unchanged. The key is sent as `Authorization: Bearer …`.

**List models** calls `ai_list_models`, which sends `GET <endpoint>/models` with the draft key and returns the `data[].id` values without embedding or reranking models (`is_embedding_model`), which Settings shows in a **Listed models** menu that fills in Model. It is a menu rather than a datalist because a datalist hides every ID that does not start with the current value. Any ID can still be typed. It sends no image and saves nothing. Endpoint failures, in the queue and in **Test connection**, start with what to fix (`endpoint_error` in `src-tauri/src/ai.rs`), then `Details:` and the raw error: no answer, a refused key (401 or 403), or a model that refuses images (a 400, 415, 422 or 500 whose server message, without the model ID, mentions images or vision). **Test connection** also fails with a response error when the reply has no JSON object with `ok`, so a model that ignores the instructions is caught before it describes the library. A text-only model behind a server that drops the image silently still passes. LM Studio and llama.cpp's server answer with whichever model is loaded whatever the request's `model` says, so a wrong ID cannot be detected there; this is documented rather than checked, since checking `/models` on every test costs a request and Anthropic does not support it with a Bearer key.

The connection test and descriptions both send `max_tokens` 400 (`DESCRIPTION_MAX_TOKENS`); step guides send 120, Annotate with AI 2000 and tidy-up 8192. When a reply has no content and `finish_reason` is `length`, or it carries only `reasoning_content` or `reasoning`, the model was still reasoning: `complete` asks once more with a larger budget (`raised_budget`): `REASONING_MAX_TOKENS` (2048), or double the request's own budget when that is more, at most `REASONING_MAX_TOKENS_CAP` (8192). Descriptions go from 400 to 2048 and Annotate with AI from 2000 to 4000. That retry costs a second request, with the screenshot uploaded again, on top of the tokens the first attempt already billed. `Clients::reasoning` then remembers the endpoint and model, so later requests to them start at their raised budget and pay that extra request once rather than per capture; another endpoint or model starts at its usual budget again. Tidy-up's budget is already at the cap, so it is never raised. If the raised attempt also thinks out, `complete` returns `AiError::Endpoint`, so the queue stops with the advice to choose a model without reasoning or turn reasoning off in the server, and the capture waits instead of being marked failed. No reasoning-effort field is sent, as servers name it differently and refusing it would cost another request. The provider guide's *What has been tested* table lists the servers and models this was checked against and what was not.

The API key is kept in the OS credential store, not in `settings.json`: Keychain on macOS, Credential Manager on Windows and the Secret Service (GNOME Keyring, KWallet) on Linux, under the service `com.kerwincarpede.grabit`. A key saved by an earlier version stays under the account `ai-endpoint-api-key` until the key or the endpoint first changes. From then on each key is stored under an account named for its endpoint, `ai-endpoint-<SHA-256 of the endpoint URL>-<slot>`, so a key typed for one destination is never sent to another. A save writes the new key to the other slot first and then renames `settings.json` into place with `aiKeySlot` pointing at it, so a failed save or a crash leaves the old key and endpoint in use; the old account is removed after the file is written. A key typed into `settings.json` as `"apiKey"`, or left there by an earlier version, is moved into the credential store the next time Grab-it starts, and the file is rewritten without it. Emptying the key in Settings removes it from the credential store too; if the store cannot remove it right then, the save fails with its message and the key is kept, so it never comes back on the next start. Where there is no credential store that works, such as a Linux session without a Secret Service, the key stays in plain text in `settings.json` under `ai.apiKey`; the hint under the API key field in Settings says which. The `keyring` crate talks to the Secret Service over D-Bus in pure Rust, so building needs no extra system packages. Tests use an in-memory key store and never touch the real one.

With `newCapturesOnly`, captures that already existed when you turned describing on are skipped; set it to `false` before turning it on to describe the whole library. **Test connection** in Settings checks whichever provider is picked.

Captures are described in the background, one at a time and newest first, once OCR has read them. Each one is scaled down to at most 1568 px on its long edge and sent with its OCR text, app and window title. A model on a CPU can take a minute or more per capture. If the endpoint cannot be reached or refuses the request, or the CLI fails, describing pauses. It tries again when you change the settings or ask for a capture to be described again, or when a new capture arrives a minute or more later. Changing the model does not redo old captures: each one records the model that described it, and you can ask for one capture, or all of them, to be described again.

### Tidying captured text

While AI descriptions are on, **Capture text** also asks the same provider to read the text again (`tidy.rs`), unless `ai.tidyText` is `false`. The local OCR text is copied at once and the card says the AI is working. The region then goes to the provider with the OCR text as a hint, and the model answers `{"text", "format", "language"}`. `format` is one of `plain`, `json`, `yaml`, `xml`, `sql`, `code` or `table`.

Valid JSON is re-indented in Rust token by token, so key order and long numbers are kept exactly. The answer replaces the card's text, and the clipboard's only while it still holds what OCR copied. The card's **Copy as read** copies the OCR text. When OCR finds nothing, the AI's text is the only one. Closing the card, or a newer capture, drops a late answer.

### Annotate with AI

The editor's **Annotate with AI** popover (`AiAnnotatePanel.tsx`, `aiAnnotate.ts`) sends the user's request to `editor_annotate` (`annotate.rs`). Without `ai.enabled` it answers `needsProvider`, and the popover opens the Grab-it window on the `ai-settings` view (Settings at AI integration) while the editor keeps the request. Otherwise the original capture (no edits) goes to the provider scaled to `MAX_IMAGE_EDGE`, with the capture's OCR lines (the library's stored ones, else read now; none when OCR fails) listed as `t1`, `t2`… with their boxes in the sent image's pixels. The model answers `{"annotations": [{"kind", "target", "box", "from", "text"}]}`: `box`, `arrow` or `label`, naming a region ID (or its exact text, used only when one line or word holds it) or giving coordinates. Rust maps them to `Suggestion`s in capture pixels, scaled back up and kept inside the capture, and counts what it cannot place: unknown kinds, missing or ambiguous targets, empty labels, shapes with no room, more than `MAX_SUGGESTIONS`. Boxes pad their region, arrows stop just short of it, and labels go below it, or above when there is no room. A region wins over the model's `box` for all three: a label's `box` places it only when it has no region, as Gemma 4 26B put a labelled target's `box` on the very text it named. Models often put a label's text on its box or arrow instead of a separate `label`, as Gemma 4 26B did; that text becomes a label too (below the box, or at the arrow's tail away from its head) unless one of the model's labels already has the shape's target or text. The prompt says that only labels have text, to prefer region IDs, and to box a group by covering all of its regions.

The editor keeps the suggestions in capture pixels and, on every draw and again on **Apply**, moves them through the cuts the document has then, so a cut made or undone while they are on preview moves them too. It draws them with the current Rectangle, Arrow and Text styles and previews them in a faded, non-listening group outside the document. **Apply** commits them all at once, so one undo removes them, and the sidecar saves them as ordinary shapes. **Cancel** bumps a request counter so a late answer is dropped; the provider call itself runs on until it ends. `ANNOTATE_TIMEOUT` (120 s) is a stall timeout, applied to each phase of each request rather than to the whole call, so a reasoning model that thinks out and is asked again with the raised budget can keep the user waiting longer: Gemma 4 26B in LM Studio took about 163 s, and in 2 of 3 runs thought out both budgets and failed with the advice to turn reasoning off. The budgets stay at 2000 then 4000, as no cap guarantees a reasoning model an answer and larger ones cost hosted users more; the user guide recommends turning reasoning off for annotating.

### Reading codes

**Capture text** first looks for QR codes and barcodes in the region (`codes.rs`), with [rxing](https://github.com/rxing-core/rxing), a Rust port of ZXing. Every format rxing reads is tried: QR, Micro QR, Data Matrix, Aztec, PDF417, MaxiCode and the 1D codes (Code 128, Code 39, EAN, UPC, ITF and more), light-on-dark as well as dark-on-light. rxing is built without its default features: Grab-it hands it the region's grey pixels itself, so rxing's own `image` dependency, SVG reading and result parsers stay out of the binary. The tests draw the codes they read with rxing's writers (`encoders`, a dev-dependency feature only), so there are no image fixtures.

When it finds a code, the region is OCR'd as well, and the card (`QuickItem::Code`) shows the values. Every value is copied, one per line, top to bottom. **Copy text** copies what OCR read around them; an OCR failure only leaves that out. Only `http://` and `https://` values count as links. **Open link** opens the first one through `tauri-plugin-opener`, and only from the card's `quick_action`: nothing opens a decoded link by itself. The text is not tidied by AI. When the region holds no code, Capture text works as before.

### Agents and the control connection

The running app listens on a local socket made with the [interprocess](https://github.com/kotauskas/interprocess) crate (`control::start`): `control.sock` in the app data directory on Linux and macOS, mode `0600`, and on Windows the named pipe `\\.\pipe\com.kerwincarpede.grabit.control.<user>`, whose security descriptor (`D:P(A;;GA;;;OW)`) admits only its owner. Each connection carries one request, a JSON line such as `{"command":"shot","target":{"kind":"window","window":"firefox"},"delayMs":0}`, and gets one reply line, `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}`; the CLI prints `result` as one JSON line on stdout, or `error` on stderr with exit code 1 (2 for bad arguments). When the socket is missing the CLI starts the same executable with no arguments, so it waits in the tray, and retries for up to 15 seconds. On Windows release builds, a GUI-subsystem program, the CLI attaches to the parent console when its stdout is not already a pipe or file.

While `agentAccess` in `settings.json` is `false` (the default) every request is refused with a message naming the switch. Requests run in `agent.rs`: `displays` and `windows` come from `screen::monitors` and `screen::desktop`, and `shot` captures with xcap, saves with `capture::save_capture`, adds the PNG with `library::record_capture` and tags it `agent`. Agent shots are never copied or opened: a `QuickItem::Notice` titled *Captured by an agent* shows instead. `--window` takes an id or the frontmost window whose app or title contains the text; `--region` is in desktop coordinates and is cropped from the display holding most of it. `record` resolves the same targets to one display and a rectangle in its image (`--screen` is the main display) and calls `record::start_with` with `record::AgentOptions`, which replace the settings' format, frame rate and pointer and turn off sound, webcam, countdown, clicks and keystrokes. The `record::Session` keeps the file path and, once the recording thread ends, its outcome, which `Session::wait` hands to `record --for` and `stop`; an agent's recording is added with `library::record_recording`, tagged `agent` and told in a *Recorded by an agent* notice instead of Quick Access. `gif` runs ffmpeg (from `ffmpeg::ready`) with `fps`, `scale`, `palettegen` and `paletteuse` into `recordings/`; `frames` samples one frame from the middle of each of `--count` equal parts with `fps` and lays them out with `tile`, then saves the sheet with `capture::save_capture`. Both are tagged `agent` with a *Made by an agent* notice. On Wayland (`portal::is_wayland`) every command but `gif` and `frames` fails with one message.

**Install skill** in Settings (`install_agent_skill`) writes `src-tauri/agent-skill/SKILL.md`, compiled in with `include_str!`, to `~/.agents/skills/grab-it/` and `~/.claude/skills/grab-it/`, with `{{GRAB_IT}}` replaced by the absolute path of the running executable. `agent_skill_status` reports where it is installed and whether every copy names the current executable.

### Settings

The image editor, Library and guide export dialogs read the optional `lastExportFolder` in `settings.json` when they open, falling back to `saveFolder`. Choosing a file updates `lastExportFolder` to its parent directory.

`settings.json` lives in the app data directory (`com.kerwincarpede.grabit`):

- Linux: `~/.local/share/com.kerwincarpede.grabit/`
- macOS: `~/Library/Application Support/com.kerwincarpede.grabit/`
- Windows: `%APPDATA%\com.kerwincarpede.grabit\`

It holds the save folder (default `~/Pictures/Grab-it/`), the hotkeys, what happens after a capture, whether captures are copied to the clipboard, the [AI description](#ai-descriptions-optional) settings and the [update channel](#updates). Changing the save folder only affects new captures.

**Start Grab-it when you sign in** is kept by the operating system rather than in `settings.json`: a login item on macOS, a registry entry on Windows, and an autostart entry on Linux.

## Checks

Run `npm ci` at the repository root, then the rest from `src/grab-it/`. CI runs the same commands.

```sh
npm ci              # at the repository root
cd src/grab-it
npm run lint        # eslint + tsc --noEmit
npm run test:coverage  # vitest run --coverage
npm run build       # tsc + vite build, also needed before the Rust build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo llvm-cov --manifest-path src-tauri/Cargo.toml --no-report
cargo llvm-cov report --manifest-path src-tauri/Cargo.toml --html
```

`npm run test:coverage` fails when the frontend tests cover less than 90% of lines or 83% of branches in `src/`, test and bench files, `src/test/` and the generated `src/app/bindings.ts` aside; the floors are in `vitest.config.ts`. It writes HTML and lcov reports to `src/grab-it/coverage/`. `npm test` runs the same tests without coverage. `cargo llvm-cov` needs [cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov) and the `llvm-tools-preview` rustup component, and writes its HTML report to `src-tauri/target/llvm-cov/html/`. Without them, `cargo test --manifest-path src-tauri/Cargo.toml` runs the same tests. Rust coverage counts lines only, since branch coverage needs nightly Rust, and CI fails below 68% of lines; that floor is in `ci.yml`.

The IPC tests in `src-tauri/src/ipc_tests.rs` call the real commands through Tauri's IPC on its mock runtime, against a temporary settings file, Library and save folder, so they need no display either. They check each command's JSON reply, what it saves and its error messages.

`src/app/bindings.ts` holds the TypeScript types of every command the page calls, generated from the Rust signatures by [tauri-specta](https://github.com/specta-rs/tauri-specta) (`specta_builder` in `src-tauri/src/lib.rs`). After changing a command's arguments or return type, or a struct or enum it sends or receives, or only their `///` doc comments (which are copied into the file), regenerate it from `src/grab-it/` and commit the result:

```sh
npm run bindings    # cargo test runs tests::export_bindings, which writes src/app/bindings.ts
```

`cargo test` fails while the file is out of date (`tests::bindings_are_up_to_date`). The byte commands, which send or receive raw bytes (the `byte_commands!` list in `lib.rs`), are left out of the bindings and registered through a plain `generate_handler!` built from the same list as `BYTE_COMMANDS`. `invoke_handler()`, which the app and the IPC tests share, sends each call to that handler or to the `specta_builder` one by command name, so the tests exercise the app's routing. The byte commands' callers and mocks type them by hand.

The OCR tests load the bundled models from `src-tauri/ocr-models/`, so they need no network. Their fixture, `src-tauri/tests/fixtures/ocr-pineapple.png`, was made with ImageMagick (the command is in `src-tauri/src/ocr.rs`).

To build installers locally, run `npm run tauri build`; they land in `src/grab-it/src-tauri/target/release/bundle/`.

## Smoke tests

The smoke tests in `src/grab-it/e2e/` drive the built app through [tauri-driver](https://v2.tauri.app/develop/tests/webdriver/) with [WebdriverIO](https://webdriver.io/) and Mocha. Each spec file starts a fresh Grab-it and checks one area against the files it leaves on disk: the app launches, a dragged region and the whole screen are saved with their `meta.json`, Quick Access shows the capture, the editor saves a rectangle to `annotations.json` and exports a PNG while the original stays unchanged, the Library lists a capture and deletes it with its sidecars, and a changed setting survives a restart. They run on Linux under X11 and on Windows; Wayland and macOS are not automated.

They use a test build with the `e2e` Cargo feature. In it, `GRAB_IT_E2E_CAPTURE` names a PNG that every monitor and window capture returns in place of the screen, resized to the size xcap reports (`screen.rs`). On Windows it also skips the frozen screen (`freeze.rs`), which reads the screen itself, so the overlays open over the live desktop and show the fixture. Release builds never turn the feature on. The suite sets it to `e2e/fixtures/screen.png`, a 960×540 picture of a window with four colour swatches, and checks known pixels of it in the saved region and screen captures, so a capture of the real screen fails. The specs read the screen's size and scale first and place the dragged region and the pixels they check from it, so they pass at any resolution.

On Debian/Ubuntu, add WebKit's WebDriver, a virtual display, xdotool and a session bus, then tauri-driver:

```sh
sudo apt-get install -y webkit2gtk-driver xvfb xauth xdotool dbus
cargo install tauri-driver --locked
```

Then, from `src/grab-it/`:

```sh
npm run e2e         # builds the e2e binary, then runs every spec
npm run e2e:run     # runs the specs against the last e2e build
```

`npm run e2e` builds with `npm run tauri build -- --debug --no-bundle --features e2e`, so tauri-driver launches `src-tauri/target/debug/grab-it` with `--open=library`, since Grab-it otherwise starts with no window. It is one argument because msedgedriver does not keep a separate value after a switch. `e2e/wdio.conf.ts` starts its own 1920×1080 Xvfb, so no window opens on your desktop and `xvfb-run` is optional; set `GRAB_IT_E2E_DISPLAY=inherit` to use your own display instead and watch. Each spec file gets its own tauri-driver, under `dbus-run-session` when it is installed, so the single-instance check never hands its arguments to a Grab-it you have running. The app's `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` point into a throwaway folder per session, with a seeded `settings.json` that saves captures there, records GIF so no ffmpeg is downloaded, keeps AI descriptions off and keeps Quick Access open. The folders, captures, logs (`tauri-driver.log` per session, WebdriverIO's under `logs/`) and a screenshot of the window each failed test was driving (`screenshots/`) are kept after the run in the folder it prints, or in `GRAB_IT_E2E_RUN` when that is set. The editor's export answers GTK's Save dialog with xdotool, the one native window the suite drives.

On Windows, tauri-driver drives [msedgedriver](https://developer.microsoft.com/microsoft-edge/tools/webdriver/), which must match the installed WebView2 runtime's version. CI reads that version from the registry and downloads the matching driver; locally, download it yourself and set `MSEDGEDRIVER` to it or put it on `PATH`. tauri-driver launches `src-tauri\target\debug\grab-it.exe`. msedgedriver passes its browser arguments, `--remote-debugging-port` among them, in `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, but the arguments wry gives WebView2 replace that variable. So in e2e builds every webview builder calls `e2e_browser_args` (`windows.rs`), which passes the variable's arguments with wry's `--disable-features` list merged into them. WebView2 wants the same arguments for every webview in a process. Tauri asks Windows for the app data folders rather than reading `APPDATA`, so a session cannot be given throwaway ones: before each session the suite stops any Grab-it and empties `%APPDATA%\com.kerwincarpede.grabit` and `%LOCALAPPDATA%\com.kerwincarpede.grabit`, deleting your settings and Library. It therefore runs only when `CI=true`, or when `GRAB_IT_E2E_REPLACE_APP_DATA=1` says you accept that. Captures still go to the throwaway save folder. Xvfb, `dbus-run-session` and xdotool are Linux only, and the editor's export is skipped, since nothing drives Windows' Save dialog. tauri-driver starts msedgedriver through `msedgedriver.cmd`, a wrapper the suite writes in each session folder, which adds `--verbose` and a `msedgedriver.log` beside it. The session folder also gets `processes.txt`, the Grab-it, WebView2 and driver processes with their command lines, 40 seconds into a session start that has not finished and again after a failure; on a failure CI also prints them and any `DevToolsActivePort` files.

Captures are driven through the Grab-it window, as a user would: **New capture** opens the overlay, where a WebDriver pointer drag selects the region, and **Capture screen** in its menu captures the screen. That menu offers the same captures as the hub through the same command (`hub_capture`). The hub itself opens only from a tray click, which WebDriver cannot reach, and Linux has no hub, so it is checked by hand.

### macOS checklist

macOS has no WebDriver for WKWebView, so check these by hand on a build of the change, with a new save folder:

1. Quit Grab-it, then open it: the menu bar icon appears, and the first launch opens the welcome.
2. Click the menu bar icon: the hub opens under it. Press **Region** and drag a box: a PNG and its `.meta.json` appear in `originals/`, and Quick Access shows the capture.
3. Capture the whole screen from the hub: the PNG is the size of the display in pixels.
4. Click **Annotate** on Quick Access: the editor opens. Draw a rectangle, then close the editor: `.annotations.json` holds a `rect` shape.
5. Open the capture in the editor again and **Export…** a PNG: the file is written, and the original PNG is unchanged.
6. Open the Library: both captures are listed. Delete one: its PNG and sidecars are gone from `originals/`.
7. In **Settings → After a capture**, turn off **Copy every capture to the clipboard**. Quit and reopen Grab-it: it is still off.

## Benchmarks

Criterion benches in `src-tauri/benches/` time the Rust hot paths. Each needs the `bench` feature, which makes the code they call reachable through the `bench` module in `lib.rs`; the feature is off by default, so `cargo test`, `cargo clippy --all-targets`, `cargo llvm-cov` and release builds leave the benches out. The lib and the app binary set `bench = false`, so `cargo bench` runs only these and criterion's own flags, such as `--save-baseline`, reach them. Run them from `src/grab-it/` after `npm run build`:

```sh
cargo bench --manifest-path src-tauri/Cargo.toml --features bench
cargo bench --manifest-path src-tauri/Cargo.toml --features bench --bench library   # one file
cargo bench --manifest-path src-tauri/Cargo.toml --features bench -- detect/ocr     # one bench
```

- `detect`: OCR (`Ocr::read_image`), face detection (`Faces::detect`) and code detection (`codes::decode`, with a QR code and with none) on a 1280×800 capture made from the test fixtures and the bundled models. On macOS, `Ocr::read_image` times Vision; elsewhere it times ocrs.
- `encode`: writing a thumbnail and `export_shot` to PNG, JPG and WebP from a generated 1920×1080 capture. A PNG export of a PNG capture copies its bytes.
- `library`: `Library::search` (two words, a prefix, an app filter, newest first) over 10,000 generated items, and a rescan of a save folder of 10,000 captures, once with nothing changed (`unchanged`) and once into an empty Library (`into_empty`).

Each bench makes its captures when it starts, writing any files to a temporary folder, and uses no fixtures beyond the tests' own, so none needs a network or a display. The `bench` profile skips the release profile's link-time optimisation to build faster, so its times compare one commit with another rather than measure the shipped app.

To compare a change with `main` locally, save a baseline on `main` and compare against it on the branch:

```sh
cargo bench --manifest-path src-tauri/Cargo.toml --features bench -- --save-baseline main
git switch my-branch
cargo bench --manifest-path src-tauri/Cargo.toml --features bench -- --baseline main
```

Criterion keeps the results in `src-tauri/target/criterion/`. From the repository root, `python3 .github/scripts/bench_report.py src/grab-it/src-tauri/target/criterion` prints them as the table CI shows.

`npm run bench` in `src/grab-it/` times the frontend's pure code with `vitest bench`. The benches sit beside their modules as `*.bench.ts`, and `npm test` leaves them out. Each file holds one test, named after its module, whose `bench` fixture times each case with `bench(...).run()`:

- `overlay/geometry`: 1000 pointer moves of a selection drag, free and at 16:9, each working out the box, the cut-out, the frame and the size label; every resize handle over the same moves; and finding the window under the pointer among 200.
- `editor/flatten`: the plain borders of a 1920×1080 capture with a window in the middle, and of one that is plain all over; laying out and painting every backdrop fill at every aspect; and the export area at 1000 views.
- `editor/render`: the render plan of 128 edited captures (every turn and mirror, cropped and not, under each kind of backdrop), with and without a scale factor.
- `recording/clips`: scrubbing 1000 times across 200 clips, clip starts and zoom owners, 100 splits and moves, and reading 200 saved clips.

Each file takes the functions it times from their module once, so its own calls skip the test runner's export getters. The code it calls still goes through them for its own imports: `editor/flatten` and `editor/render` read `model.ts`'s exports this way on every call, so their times include that cost. The base and the head pay it alike, so the comparison holds, and `vitest.config.ts` turns off the warning vitest prints about it (`benchmark.suppressExportGetterWarnings`). There is no canvas in the benches' jsdom, so they time the layout and pixel maths, not drawing.

```sh
npm run bench                      # every frontend bench
npm run bench -- overlay/geometry  # one file
```

To compare a change with `main` locally, write a JSON report on each and pass both to the report script from the repository root:

```sh
npm run bench -- --reporter=default --reporter=json --outputFile.json=/tmp/main.json   # on main
npm run bench -- --reporter=default --reporter=json --outputFile.json=/tmp/head.json   # on the branch
python3 .github/scripts/bench_report.py --vitest /tmp/head.json --vitest-base /tmp/main.json
```

### Capture overlay bench

Set `GRAB_IT_OVERLAY_BENCH` to time the capture overlay in the running app. Any value turns it on, even an empty one. Each overlay then opens at `#/overlay?bench`, and once its image is painted it replays a 2.5 s hover sweep and a 3 s drag at 120 Hz, prints `BENCH` lines with the frame timings to stderr (on macOS each is followed by a `BENCHCPU` line with the CPU time of WindowServer, WebKit's GPU process and the app), then cancels. Without the variable the page calls none of the bench commands and nothing is logged. Its value is a comma-separated list of switches, each turning one suspect off or changing one thing: `noloupe`, `nolensdraw`, `nodim`, `noguides`, `noblend`, `nobackdrop`, `noselection`, `noimage`, `nohint`, `nowillchange`, `leak`, `lazy`, `raw` and `probe`, plus `cap60`, `png` and `opaque`, which work on macOS only. The harness is in `src/overlay/bench.ts` and the `overlay_bench_*` commands in `overlay.rs`. Quit every running Grab-it first, and build with the `Grab-it Dev` identifier as the write-up shows. Otherwise `--open region` goes to the copy already running, which ignores the variable, and no bench runs. Start the app with the variable set, then trigger a region from another terminal:

```sh
GRAB_IT_OVERLAY_BENCH= src-tauri/target/release/grab-it
src-tauri/target/release/grab-it --open region
```

`docs/analysis/capture-overlay-bench/run.sh` does this several times and prints medians. What each switch and figure means is in [Capture overlay performance on macOS](analysis/capture-overlay-performance.md).

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the checks on Ubuntu 24.04, and the [smoke tests](#smoke-tests) on Ubuntu 24.04 and Windows for pull requests. In parallel, the Rust tests job runs `cargo test` on Windows and macOS, so code behind `#[cfg(windows)]` and `#[cfg(target_os = "macos")]` is tested as well as built. Tauri embeds the Common Controls 6 manifest only in the app, so on Windows the test executables would fail to start. `build.rs` turns that off and has the linker embed `windows-app-manifest.xml`, the same manifest, in every binary instead. The build job builds installers with `tauri-action` on Ubuntu 24.04, Windows and macOS and uploads them as workflow artifacts. `ci.yml` runs on every pull request except those that change only docs (the site, `docs/` or Markdown), and never publishes anything. Pushes to `main` run it through the release workflow instead (below), so `main` is built once, as a release. Linux dependencies are downloaded from the Ubuntu archive (ports on arm64), with a 120-second limit for index updates and 180 seconds for package downloads per attempt. A failure tries a second mirror (the runner's original ports source on arm64). Downloads finish before installation, so a timeout never interrupts dpkg. Packages are installed without optional recommendations.

The Checks job measures coverage while it runs the tests: `npm run test:coverage` for the frontend and `cargo llvm-cov` (pinned in `ci.yml`) for Rust, which prints a line summary in the job log. Either one falling below its floor fails the job. It uploads the HTML and lcov reports for both as one `coverage` artifact, even when a test or floor fails.

[`.github/workflows/bench.yml`](../.github/workflows/bench.yml) runs on the same pull requests. In one Ubuntu 24.04 job it checks the Rust benches with `cargo clippy --features bench --benches`, times the PR's base (from a `git worktree` sharing the target folder, `--save-baseline base`) and then its head (`--baseline-lenient base`), and runs `npm run bench` on the base and the head with vitest's JSON reporter. `.github/scripts/bench_report.py` writes a table for each, Rust and Frontend, to the job summary and to the Report step's log, which signed-out viewers and `gh run view --log` can read. The frontend's change is worked out from the two reports' means. A bench over 10% slower than the base is flagged with a warning, but the job never fails on it. A base from before a suite's benches existed, or one that fails to build or run, is skipped and that table shows the head alone. See "Benchmarks" above.

## Releases

Every push to `main`, such as a merged pull request, is released to the Edge channel. Each release publishes a [GitHub release](https://github.com/kerwincarpede/grab-it/releases) of that commit, marked as a pre-release and never as the latest release, with the installers attached: `.msi` and `-setup.exe` for Windows, a universal `.dmg` for macOS, and `.AppImage`, `.deb` and `.rpm` for Linux. Only copies on the Edge update channel offer it. A Stable release is an Edge release promoted later, with the same installers (see "Promoting to Stable").

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs the whole of `ci.yml` (checks, the Rust tests on Windows and macOS, and the installer builds) as a reusable workflow, so a release gets exactly the checks a pull request does, and those builds are the ones released. A short version job reserves each release in a draft. GitHub queues these jobs without allocating a runner until they can start (`queue: max`, up to 100 waiting jobs). Two installer pipelines can run at once, with their waiting jobs also queued by GitHub; no runner polls for earlier releases. Every code merge keeps its release, even if another finishes first. Duplicate runs of the same commit wait for each other.

To force a bump the commits would not give, or to retry a failed release, open **Actions → Release → Run workflow** on GitHub, or from a terminal:

```sh
gh workflow run release.yml -f bump=minor  # force patch, minor or major
gh run watch                               # follow it
```

A release only runs from `main`, and refuses a commit that is already released.

Versions come from published `v*` git tags and drafts that reserve versions for builds still running. [`.github/scripts/release_version.py`](../.github/scripts/release_version.py) walks main's first-parent history from the nearest reservation, skipping docs-only commits. Each code merge consumes its own version in commit order, even when a later run reserves its version first. The default `auto` bump takes the highest [Conventional Commits](https://www.conventionalcommits.org/) bump from the commit message and any commits it merges. For squash merges, it also reads commit subjects that GitHub includes as bullets in the squash message.

| Conventional Commit marker | Bump |
| --- | --- |
| `!` after the type or scope, or a `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer | major |
| `feat: ...` or `feat(scope): ...` | minor |
| `fix: ...`, other types or no marker | patch |

The first release, made before any tag exists, takes the version in `src/grab-it/src-tauri/tauri.conf.json`. CI writes the reserved version into `tauri.conf.json` before building, so the version fields in the repository do not need bumping by hand. A forced bump cannot change an existing reservation or invalidate a newer commit's reservation; use a new commit for that.

A run opens a draft release, builds the installers into it, and publishes it as a pre-release (creating the tag) only when the checks and all the builds pass. A failed run leaves a hidden draft that keeps its version reserved. Retrying that commit with `auto` replaces the unfinished draft and keeps its version; other commits never take it. Each release is named by its version, for example `0.2.1` for the tag `v0.2.1`, and its notes open with an **Edge build** line.

Before publishing, the workflow cleans up GitHub's generated **What's Changed** list. It removes Conventional Commits prefixes and skips `ci`, `docs`, `chore`, `build`, `refactor`, `style` and `test` entries. The GitHub release keeps contributor credits and pull request links. The update prompt shows the same change descriptions.

All updater assets are attached before publication. Releases are immutable: neither Edge checks nor Stable promotion replaces their assets. Edge asks GitHub's releases API for the highest published version with a `latest.json`, including versions promoted to Stable, and reads that version's manifest. The list is paginated and discovery has a 30-second total timeout. An older build finishing later cannot move Edge backwards. The old rolling `edge` release is unused; copies that still read it need one manual update from a versioned release.

Releases run only from `main`. The release workflow's version and publish jobs, and `ci.yml`'s build jobs when they build a release, run in the `release` environment, which only `main` may deploy to. It holds the signing secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `MACOS_CERTIFICATE` and `MACOS_CERTIFICATE_PASSWORD`. A branch cannot use them, so pull request builds make no update packages and sign the macOS app ad-hoc.

### Promoting to Stable

[`.github/workflows/promote.yml`](../.github/workflows/promote.yml) makes an Edge release the latest release, which Stable copies update to. Nothing is rebuilt. Run it from `main` with **Actions → Promote to Stable → Run workflow**, or:

```sh
gh workflow run promote.yml                  # the newest Edge release
gh workflow run promote.yml -f version=0.9.3 # a chosen one
```

It runs in the `stable` environment, which only `main` may deploy to and which waits for the owner's approval. [`.github/scripts/promote.py`](../.github/scripts/promote.py) picks the newest `v*` pre-release when no version is given, and refuses a draft or any version not newer than the current Stable release. The workflow validates and reuses that release's existing `latest.json`, drops the **Edge build** line from its notes, and marks it as the latest release and no longer a pre-release. Only metadata changes; immutable assets are left intact.

Homebrew users install the universal `.dmg` through the cask in [kerwincarpede/homebrew-tap](https://github.com/kerwincarpede/homebrew-tap) (`brew install --cask kerwincarpede/tap/grab-it`). Promotion points the cask at the promoted release's `.dmg` ([`.github/scripts/homebrew_cask.py`](../.github/scripts/homebrew_cask.py)), so Homebrew installs only Stable. The push needs `HOMEBREW_TAP_TOKEN` in the `stable` environment (fine-grained, contents: write on the tap); without it the release is still promoted and the cask stays as it was. The cask is updated after the release is published, so if that push fails, the run cannot simply be run again (the version is Stable by then): update `Casks/grab-it.rb` in the tap by hand.

### Updates

Installed copies update themselves from these releases with Tauri's [updater plugin](https://v2.tauri.app/plugin/updater/) (`src/grab-it/src-tauri/src/update.rs`). They read `latest.json` from their update channel, compare its version with their own, and offer to download and install the package for their platform and installer type.

The channel is **Settings → General → Updates** (`updateChannel` in `settings.json`). Stable, the default, reads the latest release (`releases/latest/download/latest.json`, the endpoint in `tauri.conf.json` that older copies use). Edge discovers the highest published version through GitHub's releases API and reads `releases/download/v<version>/latest.json`. It ignores drafts, non-version tags and releases without a manifest. `update::check` builds its updater with the channel's endpoint each time and leaves the public key in `tauri.conf.json` alone. Only a newer version counts as an update, so a copy moving from Edge back to Stable waits until Stable passes its version. Switching channel (`set_update_channel`) forgets any update the old channel found and checks the new one at once. That check reports a failure in the sidebar without opening the Updates dialog, and a check still running when the channel changes checks again. On Edge, the Grab-it window's sidebar shows an **Edge** badge next to the version.

When **Install and restart** is selected, Grab-it checks whether the shared Library window exists. A minimised window counts as open. If it is open, Grab-it writes the target version as a JSON string to `update-library-restore.json` in the app data directory before calling the updater. On Windows the installer relaunches the app with its original arguments. On macOS and Linux Grab-it restarts after installation succeeds. A download or install error clears the record.

At startup Grab-it consumes the record even if another window takes precedence. An explicit `--open` request comes first, then required Welcome. A version matching the newly running copy opens the Library when Grab-it would otherwise stay in the tray. If a Windows installer was cancelled after Grab-it exited, the old version discards the record on its next launch.

A release builds those packages because CI turns on `bundle.createUpdaterArtifacts` when it stamps the version: the `.app.tar.gz` on macOS, and the `.AppImage`, `.deb`, `.rpm`, `.msi` and `-setup.exe` themselves elsewhere, each with a `.sig`. The publish job then writes `latest.json` from those signatures ([`.github/scripts/updater_manifest.py`](../.github/scripts/updater_manifest.py)) and refuses to publish a release that is missing macOS, Linux or Windows.

`latest.json` also carries `changes`, the user-facing entries from this release's **What's Changed** list and up to 49 earlier published versions available when the manifest was written, including Edge pre-releases. Promotion reuses that history. The rolling `edge` release is left out. The update prompt lists the changes newer than the installed version, so someone several versions behind sees everything the update brings.

The updater accepts only packages signed with the key whose public half is `plugins.updater.pubkey` in `tauri.conf.json`. The private key and its password are the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets in the `release` environment. **Keep a backup of the key**: if it is lost, installed copies cannot be updated, and everyone has to download a release built with a new key by hand. Ordinary CI builds make no update packages, so they need neither secret.

Development builds (`npm run tauri dev`) do not check by themselves; the tray's **Check for updates…** still works.

The installers are not signed with a paid certificate, so Gatekeeper says it cannot verify the developer of the macOS app rather than calling it damaged, and Windows SmartScreen warns too.

CI signs the macOS app with a self-signed certificate, held in the `MACOS_CERTIFICATE` (a base64 `.p12`) and `MACOS_CERTIFICATE_PASSWORD` secrets in the `release` environment. macOS remembers Screen Recording and keychain permissions by the app's signature. Each ad-hoc signature is tied to one exact build, so before this certificate every update lost them. With the certificate, every release has the same identity and keeps them. Tauri's own `APPLE_CERTIFICATE` import accepts only Apple-issued certificates, so CI imports this one into a temporary keychain itself and hands its name to Tauri as `APPLE_SIGNING_IDENTITY`, then fails the build if the signature is not tied to it. Without the secret, as in every pull request, the app is signed ad-hoc (`-`). An `APPLE_SIGNING_IDENTITY` secret (a paid certificate) takes precedence over both.

The certificate was made once with [`.github/scripts/make_macos_signing_cert.sh`](../.github/scripts/make_macos_signing_cert.sh) and is valid for 20 years. **Keep a backup of the `.p12` and its password**: a new certificate is a new identity, so every installed copy would have to grant its permissions again once.

## ffmpeg builds

MP4 recording encodes through ffmpeg, which is not bundled. Grab-it uses one already installed, and otherwise downloads a static LGPL build of ffmpeg 8.1 from [FFmpeg-Builds](https://github.com/FFmpeg-Builds/FFmpeg-Builds) (BtbN's) the first time it is needed. Grab-it does not host or repackage ffmpeg.

| Platform | Build |
| --- | --- |
| Linux x64 | `linux64-lgpl-8.1` (`.tar.xz`) |
| Linux arm64 | `linuxarm64-lgpl-8.1` (`.tar.xz`) |
| Windows x64 | `win64-lgpl-8.1` (`.zip`) |
| Windows arm64 | `winarm64-lgpl-8.1` (`.zip`) |
| macOS | None: Homebrew's (`brew install ffmpeg`) |

They come from one release, `ffmpeg::RELEASE_URL`, and each archive's SHA-256 is compiled in (`ffmpeg::build_for`), so the download is checked without trusting anything fetched beside it. The release is a month-end autobuild: FFmpeg-Builds keeps those for about two years, but its daily ones for only about two weeks. The `pinned_builds_are_still_published` test checks that the release still lists every pinned archive with its checksum, so CI, and with it a release, fails once it is gone.

To move to a newer build, pick a month-end `autobuild-…` release, and copy each archive's name and checksum from its `checksums.sha256` into `ffmpeg.rs`:

```sh
gh release list -R FFmpeg-Builds/FFmpeg-Builds
curl -sL https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/<tag>/checksums.sha256 \
  | grep -E 'n8\.1.*-(linux64|linuxarm64|win64|winarm64)-lgpl-8\.1\.'
```

Only `bin/ffmpeg` (`bin/ffmpeg.exe`) is taken out of the archive. `bin/ffmpeg` comes first in the `.tar.xz`, so the rest is barely decompressed.

### Licence

Grab-it is MIT and runs ffmpeg as a separate program; it does not link it. It downloads FFmpeg-Builds' LGPL builds, not their GPL ones, but it does not distribute ffmpeg itself: the download comes straight from FFmpeg-Builds, whose build scripts and the source they build from are public. An ffmpeg the user installed, under whatever licence, is only run. That is why `libx264` is tried when it is there.

The keystroke label's font, `src-tauri/fonts/DejaVuSans-Bold-keys.ttf`, is cut down from [DejaVu Sans](https://dejavu-fonts.github.io/) Bold, under the Bitstream Vera licence in `src-tauri/fonts/LICENSE.txt` beside it.

## The README and tour animations

The README shows [`docs/assets/demo.gif`](assets/demo.gif), a 32-second GIF that repeats forever, so it plays wherever the README is read. It is rendered from [`docs/assets/demo.svg`](assets/demo.svg), an SVG animated with CSS keyframes, which is in turn generated by [`docs/assets/demo.py`](assets/demo.py). The screen sits in the landing page's frame: the headline with its box round "Mark it.", a still of the page's field of glass captures, and the chapter names on a hairline track. The site's fonts are embedded from `node_modules`, so run `npm ci` first. Edit `demo.py`, not the SVG or the GIF, then regenerate both from the repository root:

```sh
python3 docs/assets/demo.py docs/assets/demo.svg
python3 docs/assets/demo_gif.py docs/assets/demo.svg docs/assets/demo.gif
```

The second command needs Chrome (or Chromium or Edge) and ffmpeg, and takes about two minutes: it screenshots the SVG at each of its 640 frames in headless Chrome and joins them with ffmpeg. Set `CHROME` to the browser binary if it is not found.

The docs site's landing page has one animation per tour: capture, the image editor, recording and the video editor, and the Library. They are SVGs in `src/grab-it-docs/src/components/landing/tours/`, generated by [`docs/assets/tours.py`](assets/tours.py), and shown as they are, not as GIFs. Regenerate them all from the repository root, or name the ones to make:

```sh
python3 docs/assets/tours.py                  # all four
python3 docs/assets/tours.py capture video    # just these
```

Both scripts build on [`docs/assets/animkit.py`](assets/animkit.py): the timeline helpers (keyframes in seconds, fades, click rings) and the shared drawings, such as the dashboard window, the toolbar icons and the Library thumbnails. On the landing page, `TourAnimation.tsx` starts each loop when it scrolls into view, pauses it off screen and adds a pause button. It plays even when motion is reduced. `Tour.astro` shows them on one sticky stage beside the four chapters: as a chapter crosses the middle of the screen, the stage changes to its animation. On narrow screens each chapter shows its own.

The hero at the top of the landing page is not an SVG. `HeroDemo.astro` draws one first run of the app in HTML: PrtSc, a drag around a chart, the capture lifting off the screen into the Quick Access card, Annotate flying it into the editor, an arrow and Copy. The scene's markup is built at build time by `hero/scene.ts`, and `hero/player.ts` draws it at any second of the timeline in `hero/timeline.ts`. The selection is drawn from the pointer's position and the arrowhead sits on the pointer, so the pointer can't drift from what it is doing. To change the workflow, change the moments in `buildTimeline()` and the pointer's stops in `pointerKeys()`. The 3D is CSS transforms only, so the drags and clicks stay face-on and the camera moves between them. The player starts the loop when the hero is on screen, has pause, replay and a button per step, and follows the action with a closer camera on stages narrower than 640 pixels. When motion is reduced it still plays, but face-on, without the camera's swings. Without JavaScript the scene shows the editor with the finished arrow.

Behind the whole landing page is a slow 3D field of glass captures, drawn with [three.js](https://threejs.org/) by `field.ts`: rounded frames with faint lines of content, some with the logo's crop corners, and some with an arrow, numbered steps, a highlight, a recording dot or the Library's search loupe. The camera glides down the field as the page scrolls and leans a little with the pointer, and frames fade out as it nears them so they never sweep over the text. Each section with a `data-hue` gives the frames its feature's colour as it crosses the middle of the screen. `LandingLayout.astro` loads it only once the page is idle, so three.js never holds up the first paint; without WebGL the canvas is removed. When motion is reduced the field keeps its slow drift but the camera stays still. Sections rise into view as they scroll in, from `reveal.ts`: mark an element `data-reveal`, and its `data-reveal-child` children follow one after another.
