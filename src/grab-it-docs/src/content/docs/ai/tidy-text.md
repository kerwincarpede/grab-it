---
title: Tidy up text
description: How AI fixes what Capture text misread and lays out JSON, code and tables properly.
sidebar:
  order: 2
---

[Capture text](/grab-it/capture/more-tricks/) reads text on your computer and copies it the moment it's read. With AI on, Grab-it then sends the area you dragged, with what was read, to the same provider that describes your captures. The AI reads the text again from the image and:

- fixes what was misread, such as `0` for `O` or `l` for `1`;
- works out what the text is: plain text, JSON, YAML, XML, SQL, code or a table;
- lays it out the way it belongs: JSON valid and indented, code with its line breaks and indentation, tables as Markdown tables.

The tidied text then replaces what was copied, so pasting gives you the clean version. The Quick Access card shows what it found, such as the language for code.

## Get the original back

- **Copy as read** on the card copies the text exactly as Grab-it first read it.
- If you copied something else while the AI was working, Grab-it leaves your clipboard alone. The tidied text is still on the card; click **Copy** to take it.
- If the AI fails, what was read stays on your clipboard, and the card says the provider *could not tidy it up*.

When the dragged area holds a QR code or barcode, its value is copied instead, and isn't tidied.

## Turn it off

Turn off **Tidy up captured text** in **Settings → AI descriptions**. It's on by default, and only works while **Describe captures with AI** is on.

Tidying waits up to two minutes for an answer.
