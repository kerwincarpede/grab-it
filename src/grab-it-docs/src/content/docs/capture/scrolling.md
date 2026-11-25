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

A panel headed **Scrolling capture** walks you through the setup. It shows the step you're on, ticks the steps you've done, and reminds you that `Esc` cancels. With more than one display, it shows on the display the pointer is on, or on the one where you picked an area. It sits at the bottom of the screen and stays there while you adjust the area. It moves to the top only if the area you pick lies under it.

1. **Click a window or drag over an area.** Pick the part of the screen that scrolls.
2. **Trim the edges** (optional). Drag the edges in if you want less. Fixed headers and sidebars are fine: they appear once, at the top.
3. **Start.** Choose **Start scrolling** or press `Enter`.

The image starts at the top edge of the area, marked **Image starts here**, from what's on screen now. Grab-it doesn't scroll to the top first, so if the page isn't at the top, press `Esc`, scroll up, and start again.

**How scrolling capture works** at the foot of the panel closes Capture & record… and opens this page.

## Choose who scrolls

Under **Who scrolls?** pick one of two cards. Grab-it remembers your choice for the next capture. **What happens** below them lists what to expect from the one you picked.

| Card | Pick it for | What happens |
| --- | --- | --- |
| **Grab-it** (the default) | Hands-free capture. Best for most pages. | An arrow on the area says **Grab-it scrolls down to the end**. Grab-it moves the pointer to the middle of the area and scrolls it. Keep your hands off the mouse and trackpad. It stops at the end and saves on its own, even if something on the page keeps animating. |
| **Me** | Pages that load more as you scroll, or apps Grab-it can't scroll. | Scroll at a steady pace. If the bar says you went too fast, scroll back a little. Choose **Done** on the bar at the top of the screen when you reach the end. |

## If you move the mouse

Moving the pointer more than 8 points from where Grab-it placed it hands scrolling to you for the rest of that capture. The bar says **You moved the mouse, so you're scrolling now. Keep going, then choose Done.** If you scroll so fast that the views no longer overlap, it says **Too fast to join. Scroll back a little.** Scroll back until the image grows again.

If the page doesn't move when Grab-it scrolls, or moves but the views don't line up, the bar asks you to scroll it yourself and choose **Done**.

## Finish

While it runs, a capture bar at the top of the screen shows who is scrolling (**Grab-it is scrolling** or **You're scrolling**), a stripe for how far the image is toward its 30,000 px limit, the size so far, a live preview of the newest part and what to do next. The bar stays out of the image. **Done** saves one stitched image and shows **Saving…** until it is saved; **Cancel** or `Esc` throws it away. At 30,000 px along the scroll direction the image stops growing and the bar says **Reached the 30,000 px limit. Choose Done to save it.**

On Linux (X11) the bar moves outside the area you chose. When the area leaves it no room, it hides briefly for each view Grab-it reads.

## What it joins

- Content that moves with the page is joined in order, each part once.
- Sidebars, sticky or changing headers, and a tab title that changes don't stop it. A sidebar that never scrolls appears once, at the top, and the rest of its column is filled with its background colour.
- Floating elements such as chat bubbles can repeat in the image.

## Permissions and platforms

On macOS, Grab-it needs **Accessibility** permission to scroll for you. When it is off, the **Grab-it** card says **Needs Accessibility permission.**, a banner at the foot of the guide offers **Open Settings**, and you scroll. See [Permissions](/grab-it/recording/permissions/#automatic-scrolling).

Scrolling capture is not available on Wayland.
