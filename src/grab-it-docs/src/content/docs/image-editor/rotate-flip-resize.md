---
title: Rotate, flip and resize
description: Turn the screenshot a quarter turn, mirror it, or change its output size.
sidebar:
  order: 31
---

## Rotate and flip

The top bar's turn and flip buttons:

| Button | Key | What it does |
| --- | --- | --- |
| **Rotate left** | `Ctrl/⌘ + [` | A quarter turn anticlockwise |
| **Rotate right** | `Ctrl/⌘ + ]` | A quarter turn clockwise |
| **Flip horizontal** | | Mirrors it left to right |
| **Flip vertical** | | Mirrors it top to bottom |

Your annotations and crop turn and mirror with the screenshot, so everything stays where you put it. Text and step numbers stay upright and readable. After a quarter turn the view fits the screenshot again, since its width and height have swapped.

Each turn or flip is one step you can undo. The flip buttons stay highlighted while the screenshot is mirrored.

## Resize

**Resize** changes the size of what you copy and export. Click it and set:

- a **Width** or **Height** in pixels: the other follows, since the aspect ratio stays locked,
- a **Percent**, from 10% to 400%,
- or one of the presets: **25%**, **50%**, **75%**, **100%** or **200%**.

Typing shows the other fields change as you go; press `Enter` or leave the field to keep it. The note at the bottom of the panel shows the size you're resizing from.

Resize scales the whole result, backdrop included. While it's set, the **Resize** button stays highlighted and the status bar shows the **Output** size. Set it back to 100% to undo it, or use `Ctrl/⌘ + Z`.

## In what order

When you copy or export, the editor builds the image in this order: the [crop](/grab-it/image-editor/crop/), then rotate and flip, then the [backdrop](/grab-it/image-editor/backdrop/), then resize. So the crop turns with the screenshot: a 16:9 crop comes out 9:16 after a quarter turn. And a 50% resize halves the backdrop's padding too.
