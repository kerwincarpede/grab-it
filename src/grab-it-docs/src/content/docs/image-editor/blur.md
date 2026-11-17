---
title: Blur
description: Hide emails, names and passwords, pixelated or smoothly blurred.
sidebar:
  order: 20
---

**Key: `B`**

Drag a box over anything you don't want to share. Everything under it is hidden. Hold **`Shift`** for a square.

![An API key pixelated with Blur.](../../../assets/image-editor/blur.png)

## Pixelate or Smooth

The top bar has two styles:

| Style | Looks like |
| --- | --- |
| **Pixelate** (the default) | Large blocks of colour |
| **Smooth** | A soft blur |

Switch with a blur selected to change it, or before you draw to change the next ones. Blur has no colour or width.

## Blur private details

**Blur private details** in the top bar finds the private details in your screenshot and blurs each one for you:

- email addresses
- phone numbers with at least 7 digits, such as `+44 20 7946 0958` or `(555) 123-4567`
- card numbers (checked, so ordinary long numbers are left alone)
- street addresses, such as `221B Baker Street`
- faces

The button is there whatever tool you have picked. While it looks, it is greyed out; the first time it reads the text in a screenshot that the Library has not read yet, that takes a few seconds. If there is nothing to hide, the status bar says **No private details found**.

Each detail gets an ordinary blur, in the style you have picked, that you can move, resize or delete like any other. All of them are added as one step, so **Undo** removes them together. Click **Blur private details** again to turn it off: the blurs it added that are still there are removed, and blurs you drew yourself stay. Blurs it added stay in your screenshot when you close the editor, and the button starts off the next time you open it.

Always check the result before you share: text that is hard to read, such as tiny or stylised print, can be missed.

## Blur a word everywhere

With Blur picked, **click** a word instead of dragging. That word, and every other place it appears in the screenshot, is blurred, ignoring upper and lower case and the punctuation around it. Clicking `Acme` blurs `Acme`, `ACME` and `Acme,`, but not `Acmes`. One **Undo** removes them all. Dragging still draws a blur as usual.

:::note
Everything is found on your computer. Your screenshot is never sent anywhere to find private details.
:::

:::tip
Blur hides the screenshot underneath it. Anything you draw after the blur sits on top of it and stays sharp, so you can blur an email address and still label it.
:::

The blur is applied when you copy or export. Your original screenshot is never changed, so you can always move or remove a blur later. See [Your original is safe](/grab-it/image-editor/non-destructive/).
