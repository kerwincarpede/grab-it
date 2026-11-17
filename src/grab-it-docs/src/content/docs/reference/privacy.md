---
title: Privacy
description: What stays on your computer, and the few things Grab-it sends over the internet.
sidebar:
  order: 8
---

Grab-it has no account, no analytics and no tracking. Your captures stay on your computer unless you choose an AI provider in the cloud.

## What stays on your computer

- **Your captures and recordings**: files in your save folder.
- **The Library**: its index, thumbnails, tags and notes, in Grab-it's app data folder and your save folder.
- **Reading text in images**, and reading QR codes and barcodes. Grab-it does this on your computer: on macOS with the text recognition built into macOS, which runs on your Mac, and elsewhere by itself.
- **Settings**: `settings.json` in Grab-it's app data folder. An endpoint API key goes in your system keychain instead, where there is one.

## What goes over the internet

| What | When | Where to |
| --- | --- | --- |
| Update check | Shortly after Grab-it starts, then every few hours, and when you click **Check for updates…** or the refresh button next to the version | GitHub, for the latest Grab-it release |
| ffmpeg | Once, the first time you record an MP4, if your computer has no ffmpeg that works (not on macOS) | A pinned FFmpeg-Builds release on GitHub, checked against a checksum built into Grab-it |
| Your screenshots, with their text, app and window title | Only with AI descriptions on, for each capture described or text tidied, and for each click in a [step capture](/grab-it/capture/step-capture/): its screenshot with the step's badge drawn on it | Your chosen [AI provider](/grab-it/ai/providers/#what-goes-where) |

**Show in folder**, **Open link** on a scanned QR code, and the links in Grab-it open in your own apps and browser, and only when you click them.

## AI

AI descriptions are off until you, or Grab-it on its first start, pick a provider. Grab-it turns them on by itself only when it finds Claude Code or Codex installed and you've never set them up, and the Library says so once, with where your screenshots go:

- **Claude Code**: to Anthropic, under your Claude account.
- **Codex**: to OpenAI, under your ChatGPT or OpenAI account.
- **An endpoint on your computer**, such as Ollama: nowhere.
- **A cloud endpoint**: to that provider.

Turn describing off in **Settings → AI descriptions** and nothing more is sent. See [AI](/grab-it/ai/).

## AI agents

[AI agents](/grab-it/ai/agents/) can take screenshots only after you turn on **Settings → AI agents → Let AI agents use Grab-it**; it's off by default. The commands reach only the Grab-it running as you, on this computer: through a socket file only you can open on Linux and macOS, and a pipe only you can connect to on Windows. Every screenshot an agent takes shows a notice and is tagged **agent** in your Library. Grab-it sends nothing over the internet for them; what the agent does with a screenshot is up to the agent.

## Recordings

Microphone, system sound and webcam are off by default, and recorded only when you turn them on in [Settings → Recording](/grab-it/reference/settings/#recording). **Show keystrokes** draws the keys you press into the recording. On macOS, keys typed into a password field are left out; on Windows and Linux they aren't, so turn it off before you type a password.
