---
title: Troubleshooting
description: Fixes for the most common Grab-it hiccups.
sidebar:
  order: 3
---

## I can't see Grab-it anywhere

It runs in the menu bar or system tray. Look for its icon near the clock (on Windows, check the **^** overflow arrow). On a Mac it's also in the Dock unless you turned that off. Opening Grab-it again from your app menu opens the Grab-it window.

## My PrintScreen key opens a different screenshot tool

Another app (or the operating system) has claimed that key. Either pick a different shortcut in Grab-it's [Settings](/grab-it/reference/settings/), or turn off the other tool's shortcut. On Windows 11, turn off the *Print screen key* option (it opens the Snipping Tool) under **Settings → Accessibility → Keyboard**.

## macOS captures only show my wallpaper, or nothing

Grab-it needs **Screen Recording** permission. Open **System Settings → Privacy & Security → Screen Recording**, turn on Grab-it, then quit and reopen it.

## On Linux (Wayland), the desktop asks me to pick an area itself

That's normal on Wayland: only the desktop is allowed to read the screen, so captures go through its own screenshot picker. *Repeat last region* and *Record GIF* aren't available there. If your desktop doesn't support global shortcuts for apps, use the tray menu.

## macOS captures show only my wallpaper again after an update

Updating from an older version can make macOS treat the updated app as a new one, once. Turn Grab-it off and on again under **System Settings → Privacy & Security → Screen Recording** (or remove it with **−** and add it back), then reopen it. Later updates keep the permission.

## Searching doesn't find text in an old capture

Grab-it reads captures one at a time in the background, newest first, so give it a moment. If the text-recognition download failed, the Library shows a **Retry** button.

## Still stuck?

[Open an issue](https://github.com/kerwincarpede/grab-it/issues/new) and tell us what happened.
