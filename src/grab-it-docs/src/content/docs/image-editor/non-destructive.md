---
title: Your original is safe
description: How the editor saves your edits beside the screenshot, so you can change them any time.
sidebar:
  order: 33
---

The editor **never changes your screenshot**. Everything you do, every arrow, blur, crop, cut-out strip, turn, backdrop and resize, is kept separately and only applied when you copy, export or pin. So you can always come back and move an arrow, take out a blur or undo a crop, even weeks later.

## Saved as you go

There's no Save button. A moment after each change, your edits are saved to a small file beside the screenshot: `2026-11-15 14-05-09.png` gets `2026-11-15 14-05-09.annotations.json`. The status bar says *Saving…*, then *Annotations saved*. If you close the editor straight after a change, it finishes saving first.

To pick up where you left off, open the capture again from the [Library](/grab-it/library/) or the Quick Access card. Everything is there, still editable.

## Undo

`Ctrl/⌘ + Z` undoes, and `Ctrl/⌘ + Shift + Z` or `Ctrl/⌘ + Y` redoes, up to 200 steps back. The top bar has **Undo** and **Redo** buttons too. Each drawing, move, style change, crop, cut, turn, backdrop change and resize is one step.

## What stays unchanged

- **The screenshot file** itself, and the copy that went to your clipboard when you took it.
- **Its text**, as the Library read it, and so what search finds.

What you **copy**, **export** or **pin** from the editor is the finished image. Export writes a new file, so the original is still there beside it.

:::note
Deleting the `.annotations.json` file removes your edits for good. The screenshot then opens without them.
:::
