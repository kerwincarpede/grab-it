---
title: Troubleshooting
description: Fixes for the most common Grab-it hiccups.
sidebar:
  order: 6
---

## I can't see Grab-it anywhere

It runs in the menu bar or system tray. Look for its icon near the clock (on Windows, check the **^** overflow arrow). On a Mac it has no Dock icon unless you turn on **Settings → Show Grab-it in the Dock**. Opening Grab-it again from your app menu opens the Grab-it window.

## My PrintScreen key opens a different screenshot tool

Another app (or the operating system) has claimed that key. Either pick a different shortcut in Grab-it's [Settings](/grab-it/reference/settings/), or turn off the other tool's shortcut.

On Windows 11, the **Use the Print screen key to open screen capture** setting opens Windows' own screen capture, so `PrintScreen` switches between it and Grab-it. When that setting is on and a Grab-it hotkey is `PrintScreen` on its own, the welcome page and **Settings → Capture hotkeys** show a notice:

- **Use PrintScreen for Grab-it** turns the Windows setting off, so `PrintScreen` opens Grab-it. If Windows still has it on afterwards, the notice says so.
- **Open Windows settings** opens **Settings → Accessibility → Keyboard**, where you can turn it off yourself.

The notice goes away once nothing clashes. To keep Windows' tool on `PrintScreen`, give Grab-it's region capture another hotkey in Settings instead. Combinations such as `Alt PrintScreen` don't clash.

## macOS captures only show my wallpaper, or nothing

Grab-it needs **Screen Recording** permission. Grab-it asks for it, with every other permission, the first time you open it; if you skipped that, it opens **Set up Grab-it** again when you next open it. Or open **System Settings → Privacy & Security → Screen Recording**, turn on Grab-it, then quit and reopen it.

## macOS asks to bypass the system private window picker

On macOS 15 and later, macOS asks about once a month: *"Grab-it" is requesting to bypass the system private window picker and directly access your screen and audio.* It asks even with Screen Recording on, and no app can ask for it ahead of time. Grab-it brings it up as it reopens after setup, then macOS asks again on a capture about a month later.

- **Allow For One Month**: captures, recordings and system sound carry on, and macOS asks again in about a month.
- **Open System Settings**: opens **Privacy & Security → Screen Recording** instead, without allowing it. macOS asks again on your next capture; choose **Allow For One Month** then.

## On Linux (Wayland), the desktop asks me to pick an area itself

That's normal on Wayland: only the desktop is allowed to read the screen, so captures go through its own screenshot picker. *Repeat last region* and recording aren't available there yet. If your desktop doesn't support global shortcuts for apps, use the tray menu.

## macOS captures show only my wallpaper again after an update

Updating from an older version can make macOS treat the updated app as a new one, once. Turn Grab-it off and on again under **System Settings → Privacy & Security → Screen Recording** (or remove it with **−** and add it back), then reopen it. Later updates keep the permission.

## Searching doesn't find text in an old capture

Grab-it reads captures one at a time in the background, newest first, so give it a moment. If the Library says it could not load the text recognition models, reinstall Grab-it: they come with it.

## A hotkey does nothing

Another app may hold it. Open [Settings → Hotkeys](/grab-it/reference/settings/#hotkeys) and press **Save hotkeys**: Settings says which hotkey couldn't be registered. Pick other keys, or use the tray menu. On Wayland, your desktop binds the hotkeys: restart Grab-it after changing them, then confirm them in your desktop's shortcut settings.

## Recordings come out as GIFs, not MP4s

MP4 needs ffmpeg. Open **Settings → Recording** and look at **Video encoder**:

- *Downloading ffmpeg…*: wait for it to finish.
- *MP4 needs ffmpeg* on macOS: install it with `brew install ffmpeg`, then press **Retry**.
- *Could not set up ffmpeg*: check your internet connection and press **Retry**.

Until ffmpeg works, recordings are saved as GIFs.

## The Library says "Could not describe captures"

The AI provider didn't answer.

- **Claude Code or Codex**: run `claude` (or `codex`) in a terminal to check it's installed and signed in. If Settings says *Grab-it cannot find Claude Code*, install it, sign in, and reopen Settings.
- **An endpoint**: check the URL and model in **Settings → AI integration**, and that the server (such as LM Studio or Ollama) is running. **Test connection** says whether the server, the API key or the model is the problem. See [When the test fails](/grab-it/ai/providers/#when-the-test-fails).

Describing carries on by itself once the provider works, or straight away when you change a setting. See [AI descriptions](/grab-it/ai/descriptions/#when-it-cant-describe).

## Recordings don't show my clicks or keystrokes on macOS

They need **Input Monitoring** permission. Turn on Grab-it under **System Settings → Privacy & Security → Input Monitoring**, then quit and reopen it.

## Still stuck?

In the tray menu, choose **Send feedback → Report a problem…**. Your browser opens a GitHub issue form with your Grab-it version and system already filled in; tell us what happened and submit it. **Suggest an idea…** opens the same kind of form for an idea.

You can also [open an issue](https://github.com/kerwincarpede/grab-it/issues/new/choose) on GitHub yourself.
