---
title: Highlighter
description: Mark text the way a highlighter pen does.
sidebar:
  order: 19
---

**Key: `H`**

Drag over text to highlight it, like a highlighter pen. Pick orange or green from the colours for the classic look, or choose yellow from the colour picker on the last swatch.

The highlighter keeps its own colour and **Width** between strokes, after switching tools and when you reopen the editor. Until you pick a colour with the highlighter, it uses your drawing colour. Selecting an existing highlight shows its own colour and width; changing it with **Select** leaves your defaults for new highlights alone.

![An orange highlighter stroke over a line of text.](../../../assets/image-editor/highlighter.png)

Drag along a line of text, roughly level, and the highlight snaps to it when you let go: a straight bar centred on the text, as tall as the text plus your chosen **Width**. Change **Width** afterwards and it grows or shrinks while staying fitted to the text.

Drag roughly level where there is no text and the highlight still straightens into a level bar. Drag at a steeper angle or along a curve and you keep the shape you drew, smoothed like a [Freehand](/grab-it/image-editor/freehand/) line.

A highlight that is not fitted to text is drawn wider than the width you pick (`3 × width + 6` pixels: 9 px at **Width** 1, 18 px at the default **Width** 4, up to 78 px at **Width** 24), so every step visibly changes its thickness. Change it with **Width**, `[` and `]`, or `Alt/⌥ + scroll`.
