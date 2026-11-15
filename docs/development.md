# Developing Grab-it

Grab-it is built with Rust and [Tauri 2](https://tauri.app/), with a React + TypeScript frontend. This page covers building it from source, running the checks, and how releases are made. If you just want to use Grab-it, see [Getting started](getting-started.md).

## Layout

| Path | Contents |
| --- | --- |
| `app/` | The Tauri project |
| `app/src/` | Frontend: React + TypeScript + Vite |
| `app/src-tauri/` | Backend: Rust |
| `.github/workflows/ci.yml` | Checks plus installer builds on Linux, Windows and macOS |
| `.github/workflows/release.yml` | Release of every push to `main` |
| `docs/` | User and developer docs; `docs/assets/demo.gif` is the README animation |

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

To open a window or start a capture directly, for example on a desktop without a tray host, pass `--open` with one of `settings`, `library`, `welcome`, `region`, `all-in-one`, `repeat`, `text`, `colour`, `record`, `editor <file>`, `quick <file>` or `pin <file>`. npm, the Tauri CLI and cargo each consume one `--`, so three are needed:

```sh
npm run tauri dev -- -- -- --open settings
npm run tauri dev -- -- -- --open region
```

A built binary takes the argument directly, for example `src-tauri/target/release/grab-it --open settings`.

Only one Grab-it runs at a time. Starting it again hands the arguments to the running one, so `grab-it --open region` works as a desktop shortcut or from a script; with no arguments it opens the Library.

## How it works

### Captures on disk

Each capture is copied to the clipboard and saved to `<save folder>/originals/` as `Grab-it YYYY-MM-DD HH-MM-SS.png`, with `<name>.meta.json` beside it holding the time, mode, size, foreground app and window title. The PNG is never modified.

Annotations are saved in `<name>.annotations.json` beside the capture. Crop and backdrop are non-destructive and only applied on copy and export. Recordings go to `<save folder>/recordings/` as `Grab-it YYYY-MM-DD HH-MM-SS.mp4` (or `.gif`), with their edits in `<name>.edits.json` (see [Recording editor](#recording-editor)).

Region and Window freeze every monitor and show it fullscreen. Each monitor is cropped at its own scale factor, so mixed-DPI setups capture sharp.

All-in-one (`Action::AllInOne`) opens the same overlay with `allInOne` set in `OverlayInfo`, and the page adds a mode toolbar (`Toolbar` in `src/overlay/RegionOverlay.tsx`). Switching modes only changes what the page does with the frozen image already on screen; the toolbar's intent, mode and Timer reach `overlay_finish` as its `choice`, which an overlay opened for one mode ignores. Screen sends `{ kind: "screen" }` and saves every frozen monitor stitched. With the Timer on, `overlay_finish` closes the overlay and captures live after the delay: a region through Repeat last region (the region is remembered first), a window by its id and the screen through Screen. On Wayland All-in-one opens the portal's picker, as Region does.

The overlay has to appear the moment it is asked for, so a spare overlay window per monitor is kept hidden with its page already loaded, and replaced after each selection. On macOS the overlay is a see-through window (hence `macOSPrivateApi` in `tauri.conf.json`), shown as soon as the monitors are frozen; the frozen image reaches the page a moment later and slots in underneath. On Windows and X11 the overlay stays hidden until the frozen image is painted.

Nothing heavy happens while a selection is on screen. The frozen image is encoded for the page on its own thread the moment the monitors freeze (`overlay::encode_for_page`), never on the main thread. On macOS it is an uncompressed BMP: WebKit took about 100 ms to decode a 5K screen as PNG and under 30 ms as a BMP, so the loupe and the hover blur have the image sooner. Elsewhere it is still a PNG. On macOS the window list is read in one pass over the window server's list (`screen::windows_and_foreground`) rather than through xcap, which fetches the whole list again for every property of every window, and only ordinary app windows are offered for hovering. The blur around a hovered window is drawn once per selection into a small canvas (`src/overlay/backdrop.ts`), not by a CSS filter. The OCR queue waits while an overlay is open. On macOS, WebKit draws a page at most 60 times a second even on a 120 Hz ProMotion display, so a dragged selection moved in steps behind the cursor; the overlay's webview turns that off (`overlay::render_at_display_rate`, WebKit's internal "Prefer Page Rendering Updates near 60fps" feature) and keeps up with the display. Whatever follows the pointer is placed by a `transform` and nothing else: the tint is four solid pieces around the selection and the selection's border is four edges and four corner ticks (`stretch`, `surround` and `frameParts` in `src/overlay/geometry.ts`), so a drag lays out and paints nothing the size of the selection. A pointer move is rendered before its event returns (`flushSync`), and nothing that follows the pointer may have a transition: one of any length shows the old position for a frame. That is why `App.css` answers `prefers-reduced-motion` with `transition: none` and not with a very short duration, which made every element transition every property it changed. Set `GRAB_IT_TRACE_OVERLAY=1` to print how long freezing, listing windows, showing the overlay and encoding the image took.

### Wayland and macOS

- **Wayland** (`WAYLAND_DISPLAY` set): captures go through the desktop's Screenshot portal, and Pick a colour uses the desktop's colour picker. Hotkeys are offered to the desktop through the GlobalShortcuts portal; where the desktop has no such portal, use the tray menu. Repeat last region and recording are not available, since only the desktop may read the screen there.
- **macOS**: Grab-it needs *Screen Recording* permission under System Settings → Privacy & Security, and offers to open that page when the permission is missing. Recording with the microphone also needs the *Microphone* permission, asked for the first time, recording with Show clicks or Show keystrokes needs *Input Monitoring*, and Show webcam needs the *Camera* (see [Recording](#recording)).

### Recording

**Settings → Recording** picks what recordings are saved as (`recording` in `settings.json`): `format` is `mp4` (the default) or `gif`; `quality` is `low`, `medium` or `high` (the default) and `fps` is `30` (the default) or `60`, both for MP4 only; `showCursor` (on by default) draws the pointer into MP4s and GIFs alike; `showClicks` and `showKeystrokes` (both off by default) draw click rings and a keystroke label into them (see [Clicks and keystrokes](#clicks-and-keystrokes)); `audio` is `none` (the default), `microphone`, `system` (what the computer plays) or `both` (the two mixed), with `microphone` naming the one to record (`null`, the default, records the system's default microphone); and `showWebcam` (off by default) shows the camera named by `camera` (`null`, the default, is the system's default camera) in a bubble whose `webcamShape` is `round` (the default) or `rounded` (see [Webcam](#webcam)); and `countdown` is `0` (the default), `3`, `5` or `10` seconds counted down on the recording toolbar before the first frame. A GIF is always silent, so the page disables **Audio** and **Microphone** for it. **System sound** and **Microphone and system sound** are offered only where system sound can be recorded (`recording_system_audio`): Windows, Linux and macOS 13 or later. A saved choice is still shown on an older macOS, which records only the microphone for it and says so on the card.

Every Record overlay shows a **setup toolbar** (`src/overlay/RecordSetup.tsx`) the moment it opens, in the recording toolbar's pill and palette: a grip, the source (Region, Window or Screen, keys `1` to `3`), format and frame rate, the microphone (none, the default or one by name), system sound, webcam, clicks and keys as icon toggles with tooltips, the countdown, **Record** and Cancel. Each choice is saved to `recording` as it is made (`set_recording`), the source included (`recording.source`, `region` by default), so Settings and the next recording follow it and Record opens on the source used last. Record, like `Enter`, is disabled until something is picked:

- **Region** keeps the held selection with its handles, Shift, Space, the size field and the ratios, in a chip beside it without a button of its own; a clicked window's area is held too.
- **Window** picks the window under a click and holds the area it covers when recording starts, outlined in violet with its name and size.
- **Screen** outlines the whole display with its name; it starts picked on the display the pointer is on (`OverlayInfo::pointer_here`), and a click picks another.

Window and Screen send their area to `overlay_finish` as a region selection, so recording is still one rectangle on one monitor (`record::start`). The toolbar shows on the overlay of the display the pointer is on, or one with a pick of its own, centred where the recording toolbar would open on that display (`OverlayInfo::bar_centre`, from `record_bar::position_at` at the pill's size). It follows its grip by a `transform` alone, without a transition; when it is let go, `record_bar_remember` saves a pill-sized area centred on it as that display's `record_bar::Spot`, so both toolbars open centred on the same point. In All-in-one, Record shows the setup toolbar centred under the mode toolbar, with no grip, and the number keys keep picking modes.

While it records, the **recording toolbar** (`record_bar.rs`, the `record-bar` window on the `#/recordbar` route, `src/recordbar/`) floats over the screen in place of the old Quick Access card: a small pill with the elapsed time (paused time left out), a mute button and level meter for the microphone (or system sound when there is no microphone), a labelled **Pause** (**Resume**, with an amber dot and PAUSED, while paused), a labelled red **Stop** pill the size of the setup toolbar's Record, and a **⋯** menu with the sound and webcam toggles, **Restart**, **Discard** and **Move back to the top**. The window is see-through and fitted to the pill (`record_bar_fit`), growing under or, in the lower half of the display, over it while the menu is open. Its state comes from `record::BarStatus` through `record_bar_status` and the `record-bar-status` event; the microphone's level is read from the WAV sink (`audio::Meter`) through `record_bar_level`.

The toolbar is dragged by its body and remembers where it was left on each display, in `record-bar.json` in the app data directory: the corner of the display's work area it was nearest and its distance from that corner in points (`record_bar::Spot`), keyed by the monitor's name, and the display it was last left on. A recording opens it on that display while it is connected, else on the display being recorded, at its spot there or at the top centre, always clamped into the work area. Windows and macOS leave it out of the recording (`content_protected`, which is `WDA_EXCLUDEFROMCAPTURE` and `NSWindowSharingNone`); X11 cannot, so there a toolbar that would cover the recorded area opens just outside it (`record_bar::clear_of`), or where it is when there is no room. On Linux the window is resizable, since GTK keeps a window that may not be resized at the size it was built with; with no frame there is nothing to resize it by.

Every recording also outlines what it records (`record_frame.rs`, the `record-frame` window on the `#/recordframe?shape=…&margin=…&protected=…` route, `src/recordframe/`). The window is borderless, see-through, always on top, never focused, content-protected like the toolbar, and click-through (`set_ignore_cursor_events`); it is the recorded area grown by 6 points on every side (`record_frame::frame_around`), and the page draws only in that margin, a 1px dashed red edge and 3px solid corner brackets just outside the area, so they never land in the video even on X11. `shape` is `window` when the setup toolbar's source is Window, `screen` (brackets only, in the display's own corners, with no margin) when the area is the whole image, and `region` otherwise (`record_frame::shape_for`). A window's outline has rounded corners only where the outline is left out of the capture (`protected=1`), since a rounded edge bends past the area's corner into it; where it is not (`protected=0`, Linux) a window's outline stays square and a display's brackets go once the countdown ends. While counting down it shows the big number in the middle of the area, from `record_bar_status` and the `record-bar-status` event (`record_bar::changed` emits it while either window is open, granted to it in `capabilities/floating.json`), and drops it as the countdown ends, before the first frame. It opens beside the toolbar in `record::start`, stays through Restart, and is destroyed wherever the toolbar is closed.

A recording stops from the toolbar's Stop, from the tray's **Stop recording**, or from the Record or All-in-one shortcut pressed again: `actions::start` stops a recording under way for both (`Action::stops_recording`) instead of opening an overlay.

**Pause** stops grabbing frames. For an MP4 the sound keeps recording, and the paused stretch is kept as a gap (`record::Pacer::resume`) that is cut out of it as dropped frame times are (see below); a GIF shows the frame before the pause only as long as it was on screen, and the pause does not count towards its minute. **Mute** writes silence in place of what the microphone or system sound hears (`audio::Sound::set_muted`), so the track keeps its length. **Restart** and **Discard** stop the recording and delete it; Restart then records the same area again, countdown included. Stop during the countdown records nothing.

An MP4 is recorded at a constant 30 or 60 fps with no time limit (`record::record_mp4`). Each grab of the recorded area is piped into ffmpeg's stdin as raw RGBA (`-f rawvideo -pix_fmt rgba`), and ffmpeg writes H.264 in yuv420p at even dimensions, at most 1920 px wide, with `-movflags +faststart` so it plays while it downloads. A grab that takes longer than a frame repeats the frame before for every frame time that went by (`record::Pacer`), so the video keeps time, but only up to half a second of repeats after each grab, with Stop checked between them. Frame times further behind than that are dropped, so a fresh frame is always grabbed soon: when ffmpeg takes frames in more slowly than the frame rate, or the computer sleeps mid-recording, the video is shorter than the recording. The bitrate is the quality's bits per pixel of each frame: 0.05 for low, 0.1 for medium and 0.2 for high, about 12 Mbit/s for 1080p at high. A GIF is still encoded in Grab-it at about 10 fps, scaled to at most 1280 px wide, and stops after a minute.

Frames are grabbed in the fastest way each platform has (`frames.rs`), so 60 fps holds:

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

On macOS the first recording with the microphone asks for the *Microphone* permission (`permissions::ensure_microphone`), with the reason in `src-tauri/Info.plist` (`NSMicrophoneUsageDescription`), and waits for the answer before it starts. Once refused, Grab-it offers to open Privacy & Security → Microphone, and records without sound until it is allowed.

To check a recording's sound, `ffprobe -v error -show_entries stream=codec_name,duration <recording>.mp4` should list an `aac` stream about as long as the `h264` one, and only one `aac` stream for Both. On Linux, play something (`paplay /usr/share/sounds/freedesktop/stereo/complete.oga`, say) while recording System or Both to hear it in the result.

Beside each MP4, `<name>.cursor.json` says where the pointer was, whether or not it was drawn, for later edits such as zooming in on it:

```json
{ "version": 1, "width": 1920, "height": 1080, "fps": 60, "positions": [[812, 433], [815, 431], null] }
```

`width` and `height` are the video's size, and `positions` holds one entry for every frame of the video, repeated frames included: the pointer's hot spot in the video's pixels from its top-left corner, which lies outside that size when the pointer is outside the recorded area, or `null` where it could not be told. A GIF gets no sidecar.

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

- **Window**: a borderless, see-through, always-on-top window labelled `webcam`, showing `#/webcam?shape=…&camera=…` (`src/webcam/`), so the page needs nothing from the backend. It opens as the recording starts, before the settle delay so the camera is running by the first frame, at the bottom-right corner of the recorded area: 200 points square, at most 40% of the area's shorter side and at least 72 points, 24 points in from its edges (`webcam::place`). It never takes the keyboard focus. Drag it anywhere (`startDragging`, granted to it in `capabilities/floating.json`); it is destroyed when the recording stops.
- **Camera**: the page opens the chosen camera with `getUserMedia` (video only), and the default camera when the chosen one is gone; the video fills the window, cropped to a circle or a rounded square. When no camera starts, the bubble says why ("Camera not allowed", "No camera found"…), and the recording goes ahead.
- **Picker**: Settings → Recording lists the webview's cameras (`enumerateDevices`). Their `deviceId` is what `camera` saves. Webviews hide camera names until a camera has been allowed, so turning Show webcam on opens the camera for a moment, which also asks for the permission where the system wants one; until then cameras are listed as "Camera 1", "Camera 2" or not at all.
- **Permissions**: the `webcam` and `main` windows grant the camera, and only the camera, to their page (`webcam::allow_camera`, the webview's permission request: WebView2's `PermissionRequested`, WebKitGTK's `permission-request` and WKWebView's media capture delegate). WebKitGTK also leaves media streams off unless asked, so those windows turn them on and load their page again (`webcam::enable_media_streams`). On macOS the first use asks for the *Camera* permission, with the reason in `src-tauri/Info.plist` (`NSCameraUsageDescription`); refused, the bubble says "Camera not allowed" until it is allowed under Privacy & Security → Camera. On Linux, WebKitGTK reads the camera through GStreamer, so its PipeWire or V4L2 plugins must be installed.

ffmpeg is not bundled (see [ffmpeg builds](#ffmpeg-builds)). With MP4 chosen, Grab-it gets it ready in the background when it starts, or as soon as MP4 is picked in Settings (`ffmpeg.rs`):

1. `GRAB_IT_FFMPEG`, when set, names the ffmpeg to use, and nothing else is tried.
2. Otherwise each ffmpeg already on the computer is tried, in order (`ffmpeg::system_dirs`): every directory on `PATH`, then where package managers put it, since an app opened from the Dock, Finder or Start menu often lacks those on its `PATH`, and one installed after Grab-it started never has them. That is Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) and MacPorts (`/opt/local/bin`) on macOS; winget's links, Chocolatey and Scoop on Windows; and `/usr/local/bin`, `/usr/bin`, Linuxbrew and `~/.local/bin` on Linux. A directory linked to one already searched, such as `/bin`, finds the same ffmpeg only once.
3. Then the copy Grab-it downloaded earlier to `ffmpeg/` in the app data directory.
4. When none of those can encode H.264, this platform's [FFmpeg-Builds](#ffmpeg-builds) build is downloaded, checked against the SHA-256 compiled into `ffmpeg.rs`, and its `bin/ffmpeg` is taken out and moved there. Linux and Windows, x64 and arm64, have one. macOS has none: the Recording page says to install it with `brew install ffmpeg` and press **Retry**.

The Recording page shows the download's progress, and **Retry** when ffmpeg is not installed or could not be set up. Each ffmpeg's H.264 encoders are tried by encoding one frame, in this order, and the first ffmpeg with one that works is kept with it until Grab-it quits: `h264_videotoolbox` on macOS; `h264_nvenc`, `h264_qsv`, `h264_amf` and `h264_mf` on Windows; `h264_nvenc` and `h264_vaapi` (on `/dev/dri/renderD128`) on Linux; then `libx264`, which package managers' ffmpegs usually have, and `libopenh264`, which the downloaded builds have, everywhere. The page names the ffmpeg and the encoder chosen. A copy downloaded on an earlier run that no encoder works with is deleted, so it is downloaded again.

A recording started while ffmpeg is not ready yet (still downloading, not installed, or failed) is saved as a GIF, and the card after it says why. When MP4 is ready the card counts up with no limit and says **Video saved** when done.

To try MP4 recording with a particular ffmpeg, point `GRAB_IT_FFMPEG` at it:

```sh
GRAB_IT_FFMPEG=/path/to/ffmpeg npm run tauri dev -- -- -- --open record
```

### Recording editor

An MP4's Quick Access card has **Edit**, which opens the recording in a recording editor window (`recording-<n>`, on the `#/recording` route; `windows::show_recording_editor`), or focuses the one already showing it. It plays the recording with a timeline holding a playhead and start and end trim handles (drag them, or focus one and use the arrow keys, Shift for a second at a time), and puts it on a backdrop with the capture editor's **Backdrop** panel and its saved presets. The backdrop's aspect ratio is the export's shape: Auto, 16:9, 4:3, 1:1 or 9:16 (9:16 is offered for captures too). GIF recordings have no editor.

The page plays the recording from the `grab-it-video` URI scheme (`grab-it-video://localhost/<path>`, `http://grab-it-video.localhost/<path>` on Windows, the path URI-encoded; `recording_editor::serve_video`). It serves only `.mp4` files directly in the current save folder's `recordings/`, compared by the files they name so `..` and symlinks reach nothing else, and answers `Range` requests at most 4 MB at a time (a request with no `Range` gets the first 4 MB of a longer file). macOS and Windows play straight from the scheme. WebKitGTK's GStreamer player only loads `http`, `https` and `blob:` URLs, so on Linux (`playsFromBlob` in `src/recording/api.ts`) the page instead fetches the whole file from the scheme, a range at a time until `Content-Range`'s total is reached (`fetchRecording`), and plays it from a `blob:` URL. That URL is revoked when the editor closes. The file is held in memory while it is open. The scheme answers CORS preflights and exposes `Content-Range` for this.

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

`trim` is absent while the whole recording is kept, `backdrop` is the capture sidecar's (see `Backdrop` in `src/editor/model.ts`), and `zooms` is absent without any (see [Zooms](#zooms)).

**Export** saves `<name> (edited).mp4` beside the original (`(edited 2)` and so on when that is taken) and shows it on the Quick Access card. The page lays the video out on its backdrop as captures are (`recordingLayout` in `src/recording/layout.ts`: padding, then the aspect ratio), scaled so the longer side is at most 1920 px and both sides are even: a 1920×1080 recording at 9:16 exports at 1080×1920. It paints the fill and shadow, and a mask of the video's rounded corners, as PNGs at that size and sends them with the plan (`recording_export`). Rust then has ffmpeg decode the trimmed stretch (`-ss` and `-t` on the input) as raw RGBA at the size the video takes, at the frame rate in `<name>.cursor.json` (30 without one), lays each frame over the backdrop through the mask (`recording_editor::Composer`), and pipes it into the H.264 encoder and quality recordings use. The trimmed sound of the original is added last as AAC (`recording_editor::trim_audio_args`). The editor shows the frames written so far as the export runs. A transparent fill exports as black, since a video has no transparency.

#### Zooms

A zoom shows a stretch of the recording larger, 1.25× to 4× in quarter steps, centred on a chosen area or following the pointer. Zooms sit on a row under the timeline (`src/recording/ZoomTrack.tsx`): **Zoom** in the top bar, or a double-click on an empty stretch of the row, adds a 2-second 2× area zoom there (shorter when the next zoom or the end is closer; at least half a second). Drag a zoom to move it and its edges to resize it; zooms never overlap. A selected zoom shows its controls in the top bar: **Area** or **Follow cursor**, **Scale**, and Delete (also the Delete key; the arrow keys move it). While an area zoom is selected and the recording is paused, the preview shows the whole frame with the zoomed area on it: press or drag to centre the area, or nudge it with the arrow keys. Edits are saved in `zooms` in the sidecar; times are in the recording, not the trimmed clip.

**Follow cursor** needs `<name>.cursor.json` and is disabled without it. Rust reads and smooths the pointer path once (`zoom::CursorPath::load`): each position is held inside the frame and made a fraction of it, a frame where the pointer was unknown keeps the last known point, and the path goes through an exponential filter with a 0.25 s time constant forward and then backward, so it neither lags nor leads. The page gets the smoothed path with the recording (`RecordingInfo.cursor`) and the export uses the same one, reading it between frames.

The view at each moment is worked out the same way in the page (`viewAt` in `src/recording/zooms.ts`) and in Rust (`zoom::view_at`); keep the two in step. A zoom eases in over its first 0.3 s and out over its last (half its length each when it is shorter than 0.6 s) along a smoothstep, its scale growing as `scale ^ strength`. The view's centre is the area's or the pointer's, moved just far enough that the zoomed view stays inside the frame. The preview shows it with a CSS transform on the video, inside the video's rounded box.

On export the plan carries the zooms and the recording's size. Frames are then decoded larger than the place the video takes, as large as the deepest zoom needs up to the recording's own size (`ExportPlan::decode_size`), and each is cut to its view and scaled to that place (`zoom::draw_view`: bilinear, averaging up to 4×4 samples a pixel when shrinking) before it is laid over the backdrop.

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

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the checks on Ubuntu 24.04 (caching the ocrs models for the OCR tests) and, in parallel, builds installers with `tauri-action` on Ubuntu 24.04, Windows and macOS and uploads them as workflow artifacts. It runs on every pull request and never publishes anything. Pushes to `main` run it through the release workflow instead (below), so `main` is built once, as a release.

## Releases

Every push to `main`, such as a merged pull request, is released. Each release publishes a [GitHub release](https://github.com/kerwincarpede/grab-it/releases) of that commit with the installers attached: `.msi` and `-setup.exe` for Windows, `.dmg` for macOS (Apple silicon), and `.AppImage`, `.deb` and `.rpm` for Linux.

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs the whole of `ci.yml` (checks and the three installer builds) as a reusable workflow, so a release gets exactly the checks a pull request does, and those builds are the ones released. Releases run one at a time: pushes that land during a release wait, and only the newest of them runs, releasing all their commits together.

To force a bump the commits would not give, or to retry a failed release, open **Actions → Release → Run workflow** on GitHub, or from a terminal:

```sh
gh workflow run release.yml -f bump=minor  # force patch, minor or major
gh run watch                               # follow it
```

A release only runs from `main`, and refuses a commit that is already released.

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

## The README animation

The README shows [`docs/assets/demo.gif`](assets/demo.gif), a 14-second GIF that repeats forever, so it plays wherever the README is read. It is rendered from [`docs/assets/demo.svg`](assets/demo.svg), an SVG animated with CSS keyframes, which is in turn generated by [`docs/assets/demo.py`](assets/demo.py). Edit `demo.py`, not the SVG or the GIF, then regenerate both from the repository root:

```sh
python3 docs/assets/demo.py docs/assets/demo.svg
python3 docs/assets/demo_gif.py docs/assets/demo.svg docs/assets/demo.gif
```

The second command needs Chrome (or Chromium or Edge) and ffmpeg, and takes about a minute: it screenshots the SVG at each of its 280 frames in headless Chrome and joins them with ffmpeg. Set `CHROME` to the browser binary if it is not found.
