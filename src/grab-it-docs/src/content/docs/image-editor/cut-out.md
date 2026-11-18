---
title: Cut out
description: Take a strip out of the middle of a tall or wide screenshot and join the parts.
sidebar:
  order: 23
---

**Key: `X`**

Long screenshots often have a dull middle. Cut out removes a strip from it and joins the two parts, so the parts that matter stay big enough to read.

## Cut a strip

1. Pick **Cut out** in the tool rail, below Crop.
2. In the top bar, pick **Horizontal** for a strip that runs across the screenshot, or **Vertical** for one that runs down it.
3. Pick the edge the join gets: **Straight**, **Zigzag** or **Torn**.
4. Drag across the part you want to remove. It's shaded while you drag.
5. Let go. The strip is gone and the two parts are joined.

You can cut as many strips as you like, one at a time. Each one is a step you can undo.

Horizontal and Vertical mean as the screenshot shows, even after you [rotate or flip](/grab-it/image-editor/rotate-flip-resize/) it.

## Edges

| Edge | How the parts meet |
| --- | --- |
| **Straight** | Seamlessly, with no gap |
| **Zigzag** | Along even teeth, with a small gap between the parts |
| **Torn** | Along a torn-paper edge, with a small gap between the parts |

The gap is see-through in a PNG and white in a JPG. With a [backdrop](/grab-it/image-editor/backdrop/) on, the backdrop shows through it. A torn edge looks the same every time you open the screenshot.

## Your annotations move too

Everything below (or beside) the strip moves to close the gap, and so does the crop:

- A shape wholly inside the strip is removed with it. Undo brings it back.
- A shape that crosses the strip is shortened to the join.
- The crop shrinks by the part of it that was cut out.

## Snapping

The strip's edges snap to strong edges in the screenshot, such as window borders, panels and toolbars, as crop edges do. Hold **`Alt/⌥`** while you drag to cut without snapping.

A strip too thin to see, or one that would leave nothing on one side, is ignored. To trim an edge off, use [Crop](/grab-it/image-editor/crop/) instead.

## Put the strips back

**Restore strips**, in the top bar while Cut out is picked, puts every strip back and moves your annotations back with them, as one undo step. Shapes that were removed or shortened stay as they are.

Cutting never changes the screenshot file. See [Your original is safe](/grab-it/image-editor/non-destructive/).
