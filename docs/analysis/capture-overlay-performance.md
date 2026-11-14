# Capture overlay performance on macOS

Findings from profiling the region/window capture overlay on a 120 Hz
MacBook Pro, November 2026 (PR #72, branch `fix/smooth-capture-overlay`).
This is a hand-off: what was measured, what was fixed, what was ruled out,
and where the remaining cost is, with the tooling to reproduce every number.

## Summary

- **Dragging was jerky because WebKit drew the overlay at 60 fps on a 120 Hz
  display.** WKWebView has "Prefer Page Rendering Updates near 60fps" on by
  default. Layers moved only by `transform` (loupe, guide lines) still
  reached the screen at 120 Hz, so the selection box, the tint's cut-out and
  the size label stepped at 60 Hz behind the cursor and the loupe. Fixed in
  `overlay::render_at_display_rate` (d0be414): 60 → 120 fps.
- **The page's own work is tiny.** About 0.1 ms of script and under 1 ms of
  style/layout per pointer move. React re-rendering on every `mousemove`,
  the loupe's `drawImage`/`getImageData`, the `clip-path` tint, layout of
  `.overlay-selection` and `mix-blend-mode` on the guides each cost **no
  frames** when switched off one at a time. Don't refactor them for frame
  rate; there is nothing to gain there on this machine.
- **The frozen image arrives about 64 ms sooner as an uncompressed BMP**
  (macOS only). WebKit took about 100 ms to decode a 5K PNG.
- **The biggest remaining cost is outside the page:** WindowServer spends
  about a third of a CPU core compositing the overlay while it is on screen,
  and the screen freeze (about 45 to 65 ms) is the floor of the startup
  pause. See [Open opportunities](#open-opportunities).

## Round two: the selection was drawn a frame behind the pointer

Branch `fix/leaner-capture-overlay`, on top of PR #72. Same machine, which
has **Reduce Motion switched on** (System Settings, Accessibility, Display).
That setting turned out to be the cause.

- **Every piece that follows the pointer was painted where the pointer had
  been a frame earlier.** `App.css` answered `prefers-reduced-motion` by
  giving every element `transition-duration: 0.01ms`. An element that asks
  for no transition has `transition-property: all`, so with any duration at
  all it transitions every property it changes. Each pointer move started a
  transition on the selection's `left`, `top`, `width` and `height`, on the
  loupe's and guide lines' `transform` and on the loupe's swatch, and a
  transition shows its old value in the frame it starts in. The tint's
  cut-out was exempt (the overlay's own reduced-motion rule), so the hole
  kept up while its border trailed it. Fixed at the root: the rule is now
  `transition: none`. Nothing in the app waits for a `transitionend`.
- **A drag no longer lays out or paints anything the size of the
  selection.** The border was one element resized on every move, so a layer
  as large as the selection was painted again each time, and the tint was a
  screen-sized layer with a new `clip-path` each time. Both are now small
  solid pieces placed by `transform` alone (`stretch`, `surround` and
  `frameParts` in `geometry.ts`).
- **A pointer move is rendered before its event returns** (`flushSync` in
  `onMouseMove`). React renders a `mousemove` in a task of its own, and a
  frame that goes out in between shows the old position.
- **The blur is not the problem.** Switched off, it changes neither frame
  rate nor lag. Its one cost is at the start: see open opportunity 3.

Measured with the bench, medians, Reduce Motion on:

| | Before (480c7e6) | After |
|---|---|---|
| Drag frames in which the selection was painted away from the pointer | 348 to 350 of 357 | 0 of 358 |
| Hover frames in which the guide lines were | 287 to 297 of 300 | 0 of 300 (39 of 301 in one run of eight, unexplained) |
| The same, new code without `flushSync` (`raw,lazy`) | n/a | hover 50 to 60 of 300; drag 0 to 70 of 359 |
| Transitions running mid-drag | 4 | 0 |
| GPU process CPU per 3 s drag | 625 ms | 490 ms |
| WindowServer CPU per 3 s drag | 1220 ms | 1310 to 1380 ms |
| App process CPU per 3 s drag | 215 ms | 210 to 240 ms |
| Script per move, render and commit included | not measured (see below) | 0.4 to 0.8 ms |
| Longest drag frame, median of runs | 18 ms | 12 ms |

Frames reaching the screen, with the transitions left in both builds so the
count compares like with like (`leak` puts them back): a drag went from
about 110 a second (92 to 120 per 250 ms bucket, 6 runs) to 120 in every
bucket (2 runs).

What this round got wrong at first, so the next one does not:

- **`scriptPerMove` in round one never included React's render.** The bench
  wrapped `dispatchEvent` in `flushSync`, but React gives a `mousemove` its
  own priority inside the dispatch, so the render ran in a later task,
  outside the timed window. The "0.1 ms per move" above is the handler
  alone. The page now flushes in its own handler, so the figure is real.
- **Frames on screen (`presented.sh`) counts commits, not pictures.** With
  the 0.01 ms transitions every move made two commits (start, then finish),
  so every frame "changed" even while showing a stale position. Without
  them, a frame in which the bench's timer delivered no new move has
  nothing to commit, and a phase reads 100 to 112 or 120 depending on how
  its timer falls against vsync. Compare builds with the same transitions
  (`leak`), and trust the `probe` figures for lag.
- **A bench command that blocks the main thread shows up as a hitch.**
  `overlay_bench_log` shelling out to `ps` synchronously cost 40 to 50 ms at
  the start of the next phase. It is async now.
- Reading the loupe's pixels straight from the BMP bytes instead of
  `drawImage` plus `getImageData` was tried and dropped: no change in the
  GPU process's CPU or in script time.
- An opaque window once the image is painted (`opaque`) cut WindowServer's
  CPU by 15 to 20% in two runs. Not built: it needs a signal that the image
  is really on screen, or the window flashes black.

New bench switches: `probe` (per frame, is each piece painted at the latest
pointer position), `raw` (dispatch moves without flushing them), `lazy`
(the page does not flush either: React's default), `leak` (the 0.01 ms
transitions back), `opaque`. `run.sh` now also prints each phase with the
CPU spent in it (`phases.py`).

Still not done: **nobody has felt this with a hand on a trackpad**, and the
bench only ever ran with Reduce Motion on. With it off the transitions were
never there, so expect the smaller gain: the layers and the flush.

## Constraints for any change

Keep these behaviours (the user relies on them):

- Clicking a window in region mode captures it; there is no separate mode.
- The blurred, darkened surroundings and violet edge around a hovered window.
- The loupe, the size label, Shift for a square, Space to move the selection.
- Esc and right-click cancel.

Read the "Capture overlay" part of [development.md](../development.md) and
the comments in `app/src/overlay/` and `app/src-tauri/src/overlay.rs` first.

## Machine

- Apple M5 Pro, macOS 27.0.1, built-in Liquid Retina XDR at 120 Hz.
- Scaled to 2056 × 1329 points, so the overlay is 4112 × 2658 px and the
  frozen frame is about 11 Mpx (44 MB as RGBA).
- WebKit has `UseGPUProcessForDOMRenderingEnabled` and
  `UseGPUProcessForCanvasRenderingEnabled` on by default: **painting happens
  in WebKit's GPU process**, not on the page's main thread. Main-thread
  timings in the page do not include paint.

## How it was measured

Computer use was not available, and the agent's process had no
Accessibility permission (`CGPreflightPostEventAccess()` was false), so OS
mouse events could not be posted and Safari's Web Inspector could not be
driven. Instead:

1. **A bench harness inside the real overlay** (`capture-overlay-bench/bench.patch`,
   local only, never commit it). When `GRAB_IT_OVERLAY_BENCH` is set (even
   to `""`), the overlay page, once its image is decoded, replays:
   - a 2.5 s hover sweep: a zig-zag over the whole screen, crossing windows;
   - a 3 s drag: mousedown at (150, 150), then the corner swept around the
     screen;
   - then Esc.

   Events are dispatched at 120 Hz slots on the `.overlay` element inside
   `flushSync`, so the measured time per move includes the handler, React's
   render and commit, and passive effects (the loupe redraw). (It did not
   until round two: see above.) It reports
   through a bench-only `overlay_bench_log` command to stderr:
   - `fps`, `frameP50/P95/Max`: intervals between `requestAnimationFrame`
     callbacks;
   - `missed`: frames over 12.5 ms (1.5 vsyncs at 120 Hz);
   - `scriptPerMove`: mean ms per dispatched move;
   - `renderPerFrame`: ms from a rAF callback to the next task, which
     covers style and layout but not paint (GPU process);
   - `open`: page-side marks in ms after the page's `start()`: `info`,
     `bytes` (image received), `loaded`, `decoded`, `painted`.

   Switches in the same variable turn suspects off: `noloupe`, `nolensdraw`
   (loupe shown, canvas not redrawn), `nodim`, `noguides`, `noblend`,
   `nobackdrop`, `noselection`, `noimage`, `nohint`. Two A/B switches:
   `cap60` keeps WebKit's 60 fps default, and `png` sends a PNG instead of
   a BMP.
2. **CPU time per run** for the app, its WebKit GPU process and WindowServer
   (`capture-overlay-bench/cpu.py`), from `ps` before and after. WebContent
   processes come and go with the overlay windows, so their totals are
   unreliable. WindowServer includes the whole machine: idle, it used
   0.21 s per 7.5 s.
3. **Frames that reach the screen** (`capture-overlay-bench/presented.swift`):
   a ScreenCaptureKit stream of only the "Grab-it capture" window, counting
   frames with status `.complete` (new content) per 250 ms. Capture the
   window, not the display: the overlay is non-opaque, so anything animating
   underneath (a terminal printing) counts as a new display frame.
4. **`GRAB_IT_TRACE_OVERLAY=1`** for the backend's steps.

### Reproducing

From the repository root, on a Mac:

```sh
git apply docs/analysis/capture-overlay-bench/bench.patch
cd app && npm run tauri build -- --no-bundle \
  --config '{"productName":"Grab-it Dev","identifier":"com.kerwincarpede.grabit.dev"}'
cd ..
docs/analysis/capture-overlay-bench/run.sh base "" 3        # 120 Hz, BMP
docs/analysis/capture-overlay-bench/run.sh cap60 cap60 3    # WebKit default
docs/analysis/capture-overlay-bench/run.sh noloupe noloupe 3
docs/analysis/capture-overlay-bench/presented.sh "" 2       # frames on screen
git apply -R docs/analysis/capture-overlay-bench/bench.patch
```

- Quit every running Grab-it first, **including an installed Grab-it Dev**:
  the bench binary uses the same identifier, so it would hand its
  `--open region` triggers to that copy and quit, leaving an overlay on the
  user's screen. `run.sh` and `presented.sh` refuse to start while one runs.
  Each run starts the binary, triggers `grab-it --open region` through the
  single-instance handoff and kills it afterwards.
- The runner never finishes a capture (the bench cancels), so the library is
  untouched.
- The release binary is started from a terminal, so Screen Recording
  permission is the terminal's.
- Use the identifier override as above, so the bench never shares settings
  or hotkeys with the released app.

### Caveats

- `performance.now()` in WebKit is coarsened to 1 ms, so per-move script
  times are means of 0 or 1 ms readings: fine as averages, meaningless
  individually.
- Synthetic events skip WebKit's native event path (hit testing, the UI
  process's mouse-move coalescing). With handlers this cheap that should not
  matter, but **nobody has yet verified with a real hand on a real
  trackpad**, nor in Safari's Web Inspector Timelines. That is worth doing.
- The trigger latency (`presented 3 <binary> <pid>`) includes launching a
  second `grab-it` process for `--open region`. A bare binary on
  `/Volumes/data` measured about 30 ms slower than a bundle in
  `/Applications` for that reason alone. Compare like with like.

## Results

### Drag and hover (medians of 3 to 5 runs)

| Build | Phase | fps | frame p50 / p95 / max | frames > 12.5 ms | script / move | style+layout / frame |
|---|---|---|---|---|---|---|
| PR #72 as first pushed (d973382) | hover | 60.3 | 17 / 18 / 19 ms | 150 of 2.5 s | 0.1 ms | 1.0 ms |
| PR #72 as first pushed (d973382) | drag | 59.8 | 17 / 19 / 21 ms | 178 of 3 s | 0.1 ms | 0.7 ms |
| d0be414 (120 Hz + BMP) | hover | 120.1 | 8 / 9 / 10 ms | 0 | 0.1 ms | 0.7 ms |
| d0be414 (120 Hz + BMP) | drag | 119.9 | 8 / 9 / 15 ms | 1 | 0.0 ms | 0.5 ms |

Frames reaching the screen (overlay window only, per 250 ms bucket, ×4):

| | Hover | Drag |
|---|---|---|
| d0be414 | 120 | 96 to 120, mostly 120 |
| 60 fps cap, with loupe | ~120 | ~120 (loupe layer only) |
| 60 fps cap, no loupe | ~120 (guide lines) | **52 to 64** |

The last two rows are how the cause was pinned down. Under the cap the
page's rAF ran at 60 fps, yet transform-only layers kept updating at
120 Hz while everything needing layout or paint updated at 60 Hz. Why
WebKit commits transform changes outside its 60 fps rendering updates was
not investigated.

### Ablations (all at 120 Hz, PNG transfer, 3 runs each)

| Switched off | drag fps | GPU-process CPU / run | WindowServer CPU / run |
|---|---|---|---|
| nothing (base) | 118.8 | 1050 ms | 2583 ms |
| 60 fps cap kept (`cap60`) | 59.7 | 690 ms | 2497 ms |
| loupe | 119.2 | 487 ms | 2480 ms |
| loupe canvas redraw only | 119.0 | 700 ms | 2590 ms |
| tint (`.overlay-dim`) | 120.0 | 1000 ms | 2680 ms |
| guide lines | 119.7 | 977 ms | 2457 ms |
| guide blend mode | 119.2 | 973 ms | 2597 ms |
| blur canvas | 119.5 | 793 ms | 2530 ms |
| selection box | 119.2 | 870 ms | 2650 ms |
| frozen image | 119.3 | 913 ms | 2607 ms |
| loupe, tint, guides, blur, selection | 120.1 | 110 ms | 460 ms |

A run is about 7.5 s of overlay on screen (5.5 s of motion). Idle
WindowServer used 210 ms per 7.5 s.

- No single suspect affects frame rate.
- The loupe is about half the GPU process's paint work (its canvas redraw
  about 350 ms per run, its moving panel and readout text about 210 ms).
- WindowServer drops only when nothing on screen changes any more. No
  single layer is responsible.

### Opening the overlay

Backend trace, release build, ms after `open()` starts (4 runs):

| Step | d973382 (PNG) | d0be414 (BMP) |
|---|---|---|
| windows listed | 7 | 7 |
| monitors frozen | 65 to 75 | 64 to 68 |
| overlay shown | 65 to 75 | 64 to 68 |
| image encoded | 101 to 110 | 67 to 71 |

Page side, ms after the page's `start()` (about when the window shows):

| Mark | PNG | BMP |
|---|---|---|
| bytes received | 39.5 | 22.5 to 26 |
| `<img>` loaded | 50.5 | 45 to 49 |
| decoded | 145.5 | 76 to 86 |
| first rAF with image | 183 | 119.5 to 128 |

Trigger (`--open region`) to the overlay window's first frame on screen,
both apps bundled in `/Applications` and interleaved: released 0.7.0 about
165 ms median, PR #72 about 167 ms. On macOS the window is see-through and
shown before its image arrives, so the image's arrival is not visible as
such. It gates the loupe (black until then) and the hover blur.

Where a 4112 × 2658 freeze goes (standalone, xcap 0.7.1 path):

| Stage | Time |
|---|---|
| `CGWindowListCreateImage` | 10 to 13 ms |
| `CGDataProvider` copy (materialising the pixels) | ~20 ms |
| xcap: `to_vec`, row repack, BGRA→RGBA swap | ~11 ms |
| `Monitor::capture_image` total, warm | ~45 ms (85 ms cold) |

### BMP layouts macOS ImageIO accepts (4112 × 2658, 32 bpp)

| Header | Layout | Result | Decode |
|---|---|---|---|
| BITMAPV4HEADER (108) | `BI_BITFIELDS` RGBA masks, top-down | **refused** | n/a |
| BITMAPV4HEADER (108) | `BI_BITFIELDS` RGBA masks, bottom-up | **refused** | n/a |
| BITMAPV4HEADER (108) | `BI_BITFIELDS` BGRA masks, top-down | **refused** | n/a |
| BITMAPV5HEADER (124) | `BI_BITFIELDS` RGBA masks, top-down | ok, pixel-exact | 21 to 26 ms |
| BITMAPINFOHEADER + masks (56) | `BI_BITFIELDS` RGBA masks, top-down | ok | 25 ms |
| BITMAPINFOHEADER (40) | `BI_RGB` (BGRX), top-down or bottom-up | ok | 6 to 7 ms |

`encode_bmp` uses V5 with RGBA masks, so writing it is one copy of the
frame. A `BI_RGB` BMP decodes about 15 ms faster but needs the pixels in
BGRA. xcap swaps BGRA→RGBA itself, so taking the frame without that swap
(see below) would make `BI_RGB` free as well.

## What changed in d0be414

- `overlay::render_at_display_rate` (macOS): on each overlay webview, finds
  the `_WKFeature` keyed `PreferPageRenderingUpdatesNear60FPSEnabled` in
  `+[WKPreferences _features]` and sets it off with
  `-[WKPreferences _setEnabled:forFeature:]`.
  - Every private selector is checked with `respondsToSelector:` first, so
    a WebKit without them changes nothing.
  - wry creates a fresh `WKWebViewConfiguration` per webview, so other
    windows keep the default.
- `overlay::encode_for_page`: a V5 BMP on macOS (`encode_bmp`), still a PNG
  elsewhere because BMP was not tried in WebView2 or WebKitGTK. The page
  picks the Blob type from the magic bytes (`imageType` in
  `src/overlay/api.ts`).

## Open opportunities

Ranked by likely payoff. Each says how to measure it with the bench.

1. **WindowServer compositing: about 2.3 s of CPU per 7.5 s overlay.** The
   overlay is a non-opaque window (needed so it can show before its image
   arrives), so WindowServer blends it over the live desktop on every
   frame. With 120 Hz rendering that is about a third of a core while a
   selection is on screen. Ideas:
   - Mark the `NSWindow` opaque (`setOpaque: YES`, opaque background) once
     the page reports the image painted (`overlay_ready` is already called
     then).
   - Fewer full-screen layers that change per frame. The tint's `clip-path`
     changes a full-screen layer; four edge rectangles moved by `transform`
     would not.

   Measure WindowServer CPU per run with `run.sh`, and frames on screen with
   `presented.sh`.
2. **Screen freeze: 45 to 65 ms, the floor of the startup pause.**
   ScreenCaptureKit's `SCScreenshotManager` may return faster
   (IOSurface-backed, no `CGDataProvider` copy). Short of that, a direct
   `CGWindowListCreateImage` that skips xcap's three extra passes saves
   about 11 ms, and skipping the BGRA swap pairs well with a `BI_RGB` BMP.
   Measure with `GRAB_IT_TRACE_OVERLAY=1` ("monitors frozen").
3. **Image decoded to first frame with it: about 40 ms** (`decoded` →
   `painted`). Most of it is probably `drawBackdrop` on the main thread (an
   11 Mpx high-quality downscale plus a box blur), but it was not timed
   separately, and the mark also includes the bench's own
   `overlay_bench_config` call. Time `drawBackdrop` first. Options:
   - Draw it in a worker with `OffscreenCanvas` and `createImageBitmap`
     with `resizeWidth`.
   - Or have Rust send a quarter-size, already-blurred backdrop beside the
     frame.

   Until it is drawn, hovering shows no blur.
4. **Loupe paint cost** (about half the GPU process's work):
   - `getImageData` on every move from a `willReadFrequently` canvas, a
     synchronous round trip to the GPU process.
   - The readout text re-rendering every move.

   The colour under the cursor could be read from a CPU copy of the frozen
   pixels (the BMP bytes are already in the page) instead of from the
   canvas. It doesn't cost frames here, but it is power on battery, and
   possibly frames on slower Macs.
5. **BMP on Windows and Linux.** Chromium's and WebKitGTK's BMP decoders
   should take V5 bit fields with alpha. On those platforms the overlay is
   hidden until its image is painted, so a faster decode shortens the
   visible pause directly. Verify there before switching `encode_for_page`.
6. **Verify by hand.** None of this has been felt with a real trackpad, or
   seen in Safari's Web Inspector (Develop menu, then the overlay's
   webview, in a `npm run tauri dev` build). A Timelines recording while
   dragging would confirm there is no native-path cost the synthetic events
   miss.

## Files

- [`capture-overlay-bench/bench.patch`](capture-overlay-bench/bench.patch): the harness
  (`src/overlay/bench.ts`, hooks in `RegionOverlay.tsx` and `Loupe.tsx`,
  bench commands in `overlay.rs` and `lib.rs`, the `cap60` and `png`
  switches). Applies to this branch.
- [`capture-overlay-bench/run.sh`](capture-overlay-bench/run.sh): runs the bench and prints medians.
- [`capture-overlay-bench/presented.sh`](capture-overlay-bench/presented.sh),
  [`presented.swift`](capture-overlay-bench/presented.swift): frames on screen.
- [`capture-overlay-bench/cpu.py`](capture-overlay-bench/cpu.py): CPU time per process.
- [`capture-overlay-bench/phases.py`](capture-overlay-bench/phases.py): each phase with its CPU.
