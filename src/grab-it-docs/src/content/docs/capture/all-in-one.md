---
title: All-in-one
description: One shortcut for every capture mode, with a Timer, resize handles, exact sizes and ratio locks.
sidebar:
  order: 10
---

**All-in-one** is one shortcut for everything. Press `Ctrl + Alt + PrintScreen` (on macOS `⌘ ⇧ A`), or pick **All-in-one** in the tray menu. The screen freezes, with a toolbar at the top.

## Modes

Click a mode, or press its number. You can switch modes as often as you like before you capture.

| Key | Mode | What it does |
| --- | --- | --- |
| `1` | **Region** | Drag a region, or click a window ([Region](/grab-it/capture/region/)) |
| `2` | **Window** | Click a window ([Window](/grab-it/capture/window/)) |
| `3` | **Screen** | Captures every monitor straight away, as it was frozen ([Screen and monitor](/grab-it/capture/screen/)) |
| `4` | **Text** | Drag over text or a code to copy it ([Text and codes](/grab-it/capture/text-and-codes/)) |
| `5` | **Colour** | Click a pixel to copy its colour ([Pick a colour](/grab-it/capture/colour/)) |
| `6` | **Record** | Choose what to record and start a recording ([Recording](/grab-it/recording/record/)) |
| `7` | **Timer** | Steps through off, 3, 5 and 10 seconds (see below) |

`Esc` or right-click cancels at any point. The hint under the toolbar lists the keys you can use right now.

## The Timer

The **Timer** button shows *Timer off*, or the delay it's set to, like *Timer 5 s*. Each click (or press of `7`) steps it on: off, 3 s, 5 s, 10 s, then off again. It works with **Region**, **Window** and **Screen**; it's greyed out for the other modes.

With the Timer on, you pick the area first. The overlay then closes, and when the time is up Grab-it captures that area **as the screen looks then**. Handy for opening a menu inside the area you chose. See [Timed capture](/grab-it/capture/timed/).

## Adjust the selection

In **Region** and **Text**, a region you drag doesn't capture when you let go. It stays selected so you can get it just right. The hint reads *"Drag the handles to adjust, then press Enter."*

| To | Do this |
| --- | --- |
| Resize it | Drag a handle on any corner or edge |
| Move it | Drag inside it |
| Start over | Drag anywhere outside it |
| Pick a window instead | Click outside it |
| Capture it | Press `Enter`, or the **Capture** button beside it (**Copy text** in Text mode) |

`Shift` keeps a new drag square and `Space` moves it while you drag, as for a [region](/grab-it/capture/region/).

### Exact size

Beside the selection are its **width** and **height**. Type an exact size, such as `1280` × `720`, and press `Enter` or click away to apply it. The size is in the pixels the capture will have, so on a Retina or high-DPI screen it's the real image size, not the size in points. A size that would run off the screen moves the selection back onto it, and one larger than the screen is cut to fit.

`Enter` in a size field only sets the size. Press `Enter` again (outside the field) to capture.

### Ratio locks

Next to the size are **Free**, **16:9**, **4:3** and **1:1**. Pick a ratio and the selection is reshaped to it around its centre, as large as its width allows. While a ratio is locked, dragging a handle keeps that shape: a corner grows from the opposite corner, and an edge from the opposite edge. **Free** unlocks it again.

## Your last region

The last region you captured starts out selected on the monitor it was on, ready to capture again with `Enter`, or to adjust first. Drag anywhere else for a new one, or click away to pick a window instead.

## Record

**Record** shows the recording setup toolbar under the mode toolbar. Pick a region, a window or a screen and the recording options, then press **Record** or `Enter`. Press the All-in-one shortcut again to stop the recording. See [Record your screen](/grab-it/recording/record/).

:::note
On Wayland your desktop's own picker shows instead of All-in-one's toolbar, as for a region. See [Wayland](/grab-it/capture/wayland/).
:::
