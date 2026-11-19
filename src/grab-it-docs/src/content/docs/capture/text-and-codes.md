---
title: Text and codes
description: Copy the text in any part of the screen, or read a QR code or barcode, without saving a screenshot.
sidebar:
  order: 8
---

**Capture text** copies words you can see but can't select: text in an image, a video, a screen share or an error dialog. Press `Shift + PrintScreen` (on macOS `⌘ ⇧ 1`), or pick **Capture text** in the tray menu.

1. The screen freezes, and the hint reads *"Drag over the text to copy it."*
2. Drag over the text. `Shift` and `Space` work as they do for a [region](/grab-it/capture/region/).
3. Let go. The text is read and copied, ready to paste, and the Quick Access card shows what was found.

Nothing is saved: Capture text never adds a screenshot to your folder or Library.

:::note
The first text capture after Grab-it starts is a little slower while it loads its text-reading models. After that, it's quick. Grab-it reads text on your own computer, so it works offline: on macOS and Windows with the text recognition built into the system, and on Linux with models it comes with. Windows needs the text recognition for one of your languages installed; without it, Grab-it uses its own models there too. Short bits that are probably icons are left out.
:::

## Tidy it up with AI

With [AI](/grab-it/ai/descriptions/) turned on, the text read on your computer is copied straight away, then the AI reads the area again and tidies it up: misread characters are fixed, and JSON, code and tables come out properly laid out. Its text then takes the place of the first one on the card, and on your clipboard too, unless you've copied something else in the meantime.

## QR codes and barcodes

Drag over a QR code or barcode, no phone needed. Grab-it looks for codes before it reads any text, and when it finds one, the code's **contents** are copied instead of the text around it.

- It reads 2D codes (QR, Data Matrix, Aztec, PDF417, MaxiCode) and barcodes (Code 128, EAN, UPC and the rest).
- An area with several codes gives you all of them, one per line.
- **Copy text** on the card copies the words around the code instead.
- **Open link** opens a web link in your browser. Grab-it never opens a link unless you click.

Codes found this way aren't tidied by AI; they're copied exactly as they are.

## From Capture & record…

**Text** in the [Capture & record…](/grab-it/capture/all-in-one/) toolbar (key `4`) does the same. There, the area you drag stays selected, so you can adjust it and then press **Copy text** or `Enter`.

:::tip
Every screenshot you save has its text read in the background too, so you can search for it in the [Library](/grab-it/library/) later.
:::
