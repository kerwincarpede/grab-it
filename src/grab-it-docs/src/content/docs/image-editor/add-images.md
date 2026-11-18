---
title: Add images
description: Drop or paste other images onto a screenshot, such as a before and after side by side.
sidebar:
  order: 23
---

Put more than one screenshot in a single image: a before and after, or the steps of a guide.

- **Drop an image file** onto the editor. It lands centred where you let go.
- **Paste an image** with `Ctrl/⌘ + V`. It lands just right of the screenshot and of any images you added before, level with the screenshot's top.

Either way, it comes in at its own size in pixels and stays selected. PNG, JPEG, WebP and GIF images work.

## Move, resize and order

An added image is selected, moved and deleted like anything you've drawn (see [Select](/grab-it/image-editor/select/)):

- **Drag it** to move it, or nudge it with the arrow keys.
- **Drag a corner** to resize it. It keeps its shape; hold `Shift` to stretch it.
- **Duplicate it** with `Ctrl/⌘ + D`, and delete it with `Delete` or the trash button.

Images and annotations are drawn in the order you added them, the newest on top. To change that, select one and click **Bring forward** or **Send backward** next to the trash button in the top bar, or press `Ctrl/⌘ + Alt + ]` and `Ctrl/⌘ + Alt + [`. This works for any annotation, not only images. Added images always sit above the screenshot itself.

## The canvas grows to fit

Move an image past the edge of the screenshot and the canvas grows to take it in. It always fits the screenshot and every image, and shrinks again as you move them back. The status bar shows the canvas's size; hover over it to see the screenshot's own. Copy and export put out the whole canvas, unless you [crop](/grab-it/image-editor/crop/) it.

The rest of the editor works on the whole canvas too:

- **Crop** reaches past the screenshot, up to the canvas's edges, and its edges snap to the screenshot's borders as well as the canvas's.
- **Rotate and flip** turn the whole canvas, so a pair side by side turns into one above the other.
- **A [backdrop](/grab-it/image-editor/backdrop/)** pads around the whole canvas. Its shadow falls only under the screenshot and the images, **Blurred capture** blurs the screenshot alone, and **Balance** pads evenly once the canvas reaches past the screenshot.

Where nothing covers the canvas it stays transparent in a PNG and on the clipboard, and white in a JPEG. With a backdrop, the backdrop shows through there.

[Blur](/grab-it/image-editor/blur/) and [Spotlight](/grab-it/image-editor/spotlight/) act on the screenshot only, not on added images.

## Where they are kept

Grab-it keeps its own copy of each image in a folder beside the screenshot, named after it with `.assets` on the end. So an image stays even if you move or delete the file you dropped. Deleting the screenshot deletes that folder too.
