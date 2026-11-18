---
title: Wayland
description: What works differently on Linux desktops running Wayland, and why.
sidebar:
  order: 12
---

Most Linux desktops today (GNOME and KDE Plasma among them) run **Wayland**. Wayland doesn't let any app read the screen or listen for keys by itself. Only the desktop may, and apps ask it through *desktop portals*. Grab-it does that, so it works on Wayland, with a few differences.

:::tip
Not sure? Run `echo $XDG_SESSION_TYPE` in a terminal. It prints `wayland` or `x11`. On X11 everything works as described on the other pages.
:::

## Hotkeys

Grab-it's hotkeys are registered through your desktop's global shortcuts, so the first time your desktop may ask you to confirm them. You can change them there. A hotkey you change in Grab-it's [Settings](/grab-it/reference/settings/) takes effect only after you restart Grab-it and confirm it in your desktop's shortcut settings. If your desktop doesn't support this, the tray menu still starts every capture.

## Captures

Your desktop's own screenshot picker shows instead of Grab-it's overlay:

| Capture | On Wayland |
| --- | --- |
| **Region**, **Window**, **Monitor**, **Text** | The desktop's picker asks for the area, window or monitor |
| **Screen** | Captures straight away, with no picker |
| **Capture & record…** | The desktop's picker shows instead, as for Region; there's no toolbar |
| **Pick a colour** | The desktop's own colour picker shows |
| **Repeat last region** | Not available: the desktop always asks you to pick |
| **Record** | Not available yet |
| **Step capture** | Not available: apps can't watch clicks |

Backing out of the desktop's picker simply cancels; it isn't an error.

The finished capture is copied, saved and shown on the Quick Access card as usual. Grab-it keeps its own copy and removes the file the desktop wrote.
