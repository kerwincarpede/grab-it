---
title: Recording options
description: Format, microphone, system sound, webcam, clicks, keys and the countdown, on the setup toolbar and in Settings.
sidebar:
  order: 2
---

The recording setup toolbar holds the options you change most. Hover an icon for its name and whether it's on; an option that's on is tinted. Every change is saved to **Settings → Recording**, so the next recording starts the same way, and Settings has a few more.

## Format

The first chip picks what the recording is saved as:

| Choice | What you get |
| --- | --- |
| **MP4 · 30 fps** | The default. Any length, with sound if you want it. |
| **MP4 · 60 fps** | Smoother scrolling and pointer movement, in bigger files. |
| **GIF · silent, 1 min** | An animated GIF at about ten frames a second. No sound, and it stops by itself after one minute. |

Recordings wider than 1280 pixels are scaled down to 1280 wide, keeping their shape, so HiDPI recordings stay a sensible size.

An MP4 needs ffmpeg. Grab-it uses one already on your computer, or downloads one in the background (on macOS, Settings asks you to install Homebrew's). Until ffmpeg is ready, a recording is saved as a GIF and its card says why; **Settings → Recording** shows the progress.

**Settings → Recording → Quality** (Low, Medium or High, High by default) sets how sharp an MP4 is, and so how big. It applies to [exports from the video editor](/grab-it/video-editor/export/) too.

## Microphone

The microphone chip records your voice with an MP4:

- **No microphone**,
- **Default microphone**: the input chosen in your system's sound settings,
- or any microphone connected, by name.

A GIF is silent, so the chip says **No sound** and can't be changed.

## System sound

The speaker icon records what your computer plays, such as a video's sound or a notification. With the microphone on too, both are mixed into one track.

It's offered on Windows, Linux and macOS 13 or later. A GIF is silent, so it's turned off for one.

## Webcam

The camera icon shows your webcam in a bubble over the recorded area. The bubble is part of the screen, so it's recorded with it. It opens at the bottom-right corner of the area; drag it anywhere while you record.

**Settings → Recording** picks the **Camera** (the system default unless you choose one) and the **Webcam shape**: **Round** or **Rounded square**. You can hide and show the bubble while you record from the [toolbar's menu](/grab-it/recording/toolbar/#the-menu).

## Clicks

The pointer icon draws a ring wherever you click, which grows and fades in half a second. It's drawn into the recording itself, not shown on your screen.

## Keys

The keyboard icon shows the keys you press as a label at the bottom centre of the recording, like `⌘ ⇧ 4` on macOS or `Ctrl Shift 4` on Windows and Linux. A modifier pressed on its own shows nothing. The label stays for a moment after the last key, then fades.

:::caution
On macOS, keys typed into a password field are left out. Windows and Linux can't tell when you're typing a password, so turn **Keys** off before you type one.
:::

## Countdown

The timer button steps through **Off**, **3 s**, **5 s** and **10 s**. With a countdown, the recording toolbar counts down and the number shows big in the middle of the area, giving you time to get ready. Press **Cancel** on the toolbar during the countdown and nothing is recorded.

## Only in Settings

**Settings → Recording** also has:

- **Show cursor**: on by default. Turn it off to leave the pointer out of the recording.
- **Frame rate** and **Audio**: the same choices as the setup toolbar's format and sound.

See [Settings](/grab-it/reference/settings/) for the rest.
