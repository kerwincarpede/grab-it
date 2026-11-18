---
title: Capture & record…
description: One toolbar for every capture mode, with a Timer, resize handles, exact sizes and ratio locks.
sidebar:
  order: 10
---

Open **Capture & record…** from the tray menu, the hub below **Capture region**, or **More captures** in the Library. Its global shortcut is `Ctrl + Alt + PrintScreen` by default (`⌘ ⇧ A` on macOS). The menus show the shortcut currently bound on your desktop.

The screen freezes with one toolbar at the top. Press the same shortcut again to cancel without capturing. A third press opens a fresh chooser.

![The Capture & record… toolbar over a held region, with its size fields and ratio locks.](../../../assets/capture/all-in-one-toolbar.png)

## The toolbar

From left to right:

- **Region**, **Window** and **Screen**: what to capture.
- **Text**, **Colour**, **Record** and **Scroll**: the tools.
- A middle section that changes with what you're doing: the selection's width, height and ratio once you've selected a region, or the colour under the pointer in **Colour**.
- **Timer**, then the main button, named for the mode: **Capture**, **Capture in 3 s**, **Copy text**, **Copy colour** or **Start scrolling**. It's dimmed until there's something to act on.
- **×** to cancel.

Point at any item, or move to it with `Tab`, to see a tooltip with its name, its key in the chooser, its global shortcut if it has one, and what it does. A dimmed main button's tooltip says what to do first, for example *Drag an area or click a window first.*

`Tab` moves into the toolbar and `←` `→` move between the buttons of a group. The first `Esc` leaves the toolbar; the next one cancels.

If a selected region is under the toolbar, the toolbar moves to the bottom edge of the screen. On a narrower display the modes you haven't picked shrink to their icon and key, the ratios fold into one menu, and on the narrowest the size and ratio move to a second row of the toolbar.

## Modes

Click a mode, or press its number while the chooser is open. You can switch modes as often as you like before you capture.

| Key | Mode | What it does |
| --- | --- | --- |
| `1` | **Region** | Drag a region, or click a window ([Region](/grab-it/capture/region/)) |
| `2` | **Window** | Click a window, or press `Enter` for the one under the pointer ([Window](/grab-it/capture/window/)) |
| `3` | **Screen** | Captures every monitor straight away, as it was frozen ([Screen and monitor](/grab-it/capture/screen/)) |
| `4` | **Text** | Drag over text or a code to copy it ([Text and codes](/grab-it/capture/text-and-codes/)) |
| `5` | **Colour** | Click a pixel, or press `Enter`, to copy the colour under the pointer ([Pick a colour](/grab-it/capture/colour/)) |
| `6` | **Record** | Choose what to record and start a recording ([Recording](/grab-it/recording/record/)) |
| `7` | **Scroll** | Choose an area or window and stitch a scrolling capture (see below) |
| `8` | **Timer** | Steps through off, 3, 5 and 10 seconds (see below) |

`Esc` or right-click cancels at any point.

## The Timer

The **Timer** button, beside the main button, shows *Timer*, or the delay it's set to, like *5 s*. Each click (or press of `8`) steps it on: off, 3 s, 5 s, 10 s, then off again. While it's set, the main button reads **Capture in 5 s**. It works with **Region**, **Window** and **Screen**, and is hidden for **Text**, **Colour**, **Record** and **Scroll**.

With the Timer on, you pick the area first. The overlay then closes, and when the time is up Grab-it captures that area **as the screen looks then**. Handy for opening a menu inside the area you chose. See [Timed capture](/grab-it/capture/timed/).

## Adjust the selection

In **Region** and **Text**, a region you drag doesn't capture when you let go. It stays selected so you can get it just right, and the main button lights up.

| To | Do this |
| --- | --- |
| Resize it | Drag a handle on any corner or edge |
| Move it | Drag inside it |
| Start over | Drag anywhere outside it |
| Pick a window instead | Click outside it to let it go, then click a window |
| Capture it | Press `Enter`, or the **Capture** button in the toolbar (**Copy text** in Text mode) |

`Shift` keeps a new drag square and `Space` moves it while you drag, as for a [region](/grab-it/capture/region/).

### Exact size

In the middle of the toolbar are the selection's **width** and **height**. Type an exact size, such as `1280` × `720`, and press `Enter` or click away to apply it. The size is in the pixels the capture will have, so on a Retina or high-DPI screen it's the real image size, not the size in points. A size that would run off the screen moves the selection back onto it, and one larger than the screen is cut to fit.

`Enter` in a size field only sets the size. Press `Enter` again (outside the field) to capture.

### Ratio locks

Next to the size are **Free**, **16:9**, **4:3** and **1:1**, or one **Aspect ratio** menu on a narrower display. Pick a ratio and the selection is reshaped to it around its centre, as large as its width allows. While a ratio is locked, dragging a handle keeps that shape: a corner grows from the opposite corner, and an edge from the opposite edge. **Free** unlocks it again.

## Your last region

The last region you captured starts out selected on the monitor it was on, ready to capture again with `Enter`, or to adjust first. Drag anywhere else for a new one, or click away to let it go, then click a window to pick it instead.

## Record

**Record** shows the recording setup toolbar under the Capture & record… toolbar, with a hint under it. Pick a region, a window or a screen and the recording options, then press **Record** or `Enter`. Press the Capture & record… shortcut again to stop the recording. See [Record your screen](/grab-it/recording/record/).

## Scroll

Choose **Scroll**, drag an area or click a window, then press **Start scrolling** or `Enter`. Grab-it moves the pointer to the middle of the area and tries scrolling down. Once content has scrolled, it saves when several wheel steps move no new content. The first detected movement sets the direction. If nothing scrolls automatically, the card asks you to scroll by hand instead of saving. You can scroll horizontal-only content by hand, then choose **Done**.

Move the mouse more than 8 px from where Grab-it placed it to pause automatic scrolling for the rest of that capture. The card changes to **Scroll by hand**. Scroll slowly by hand vertically or horizontally, keeping some content visible between movements. Keep the content still apart from scrolling.

The Quick Access card shows the image size so far. **Done** saves one stitched image; **Cancel** discards it. At 30,000 px along the scroll direction, the image stops growing and the card shows the cap was reached. Choose **Done** or **Cancel** to finish.

On macOS, automatic scrolling asks for **Accessibility** permission. If you don't allow it, capture continues by hand and the card explains why. See [Permissions](/grab-it/recording/permissions/#automatic-scrolling).

Scroll capture is not available on Wayland.

:::note
On Wayland your desktop's own picker shows instead of the chooser toolbar, as for a region. See [Wayland](/grab-it/capture/wayland/).
:::
