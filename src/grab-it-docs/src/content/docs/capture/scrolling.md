---
title: Scrolling capture
description: Capture a whole long page or list as one image. Grab-it scrolls it for you and joins the views, or you scroll by hand.
sidebar:
  order: 11
---

Scrolling capture saves a page, document or list that is longer than the screen as one tall image. Grab-it scrolls the area and joins what it sees, so a docs page with a fixed sidebar comes out whole, with the sidebar shown once at the top.

## Start it

| From | Do this |
| --- | --- |
| The tray menu | Choose **Scrolling capture…** |
| The hub | Choose **Scrolling capture** |
| The Library | Open the menu beside **New capture** and choose **Scrolling capture** |
| Capture & record… | Choose **Scroll**, or press `7` |
| A hotkey | Set one under **Settings → Capture hotkeys → Scrolling capture**. It has none by default. |

Each one opens Capture & record… with **Scroll** already picked.

## Follow the guide

A panel walks you through three steps:

1. **Choose a window, or drag an area.** Click the window you want, or drag over the part of the screen that scrolls.
2. **Adjust it.** Drag the edges to keep the whole window or just the part that scrolls.
3. **Start.** Press **Start scrolling** or `Enter`.

Before you start, choose who scrolls:

- **Scroll for me** (the default): Grab-it moves the pointer to the middle of the area and scrolls it. Leave the mouse and trackpad alone until it finishes. It saves once the page stops moving, even if something on the page keeps animating.
- **I'll scroll myself**: scroll the page at a steady pace, then choose **Done**.

## If you move the mouse

Moving the pointer more than 8 points from where Grab-it placed it switches that capture to scrolling by hand. Keep scrolling yourself, then choose **Done**. If you scroll so fast that the views no longer overlap, the card says **Scrolled too fast. Scroll back a little.** Scroll back until it grows again.

## Finish

The card shows the size of the image so far. **Done** saves one stitched image; **Cancel** throws it away. At 30,000 px along the scroll direction the image stops growing; choose **Done** or **Cancel**.

## What it joins

- Content that moves with the page is joined in order, each part once.
- Sidebars, sticky or changing headers, and a tab title that changes don't stop it. A sidebar that never scrolls appears once, at the top, and the rest of its column is filled with its background colour.
- Floating elements such as chat bubbles can repeat in the image.

## Permissions and platforms

On macOS, Grab-it needs **Accessibility** permission to scroll for you. When it is off, the guide says so and offers **Open Settings**, and the capture runs by hand. See [Permissions](/grab-it/recording/permissions/#automatic-scrolling).

Scrolling capture is not available on Wayland.
