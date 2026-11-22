---
title: Providers
description: Describe captures with Claude Code, Codex, or an OpenAI-compatible endpoint such as Ollama, LM Studio, OpenAI, Anthropic or OpenRouter, and what each one sends where.
sidebar:
  order: 3
---

Pick who describes your captures in **Settings → AI integration → Described by**, then press **Save**. **Test connection** sends a tiny test image with the settings as typed, without saving them, and tells you whether the model answered.

![Settings open at AI descriptions, with the switches and Claude Code picked as the provider.](../../../assets/ai/ai-settings.png)

## Claude Code

Uses the `claude` command you already have and are signed in to. Nothing to set up or download.

- **Model**: `haiku` (the default) is the fastest and cheapest; `sonnet` and `opus` write more detail. A full model name works too.
- Grab-it finds `claude` even when it was started from Finder or a launcher, by asking your login shell for its `PATH`.
- It runs Claude Code in an empty temporary folder with no tools, so it can only look at the screenshot.
- Signing in is up to Claude Code. If it isn't signed in, describing stops and the Library shows its message. Run `claude` in a terminal to check.

If Settings says *Grab-it cannot find Claude Code*, install Claude Code and sign in, then reopen Settings.

## Codex

Uses the `codex` command you already have and are signed in to, the same way as Claude Code.

- **Model**: leave it empty to use the model set up in Codex itself, or type one.

## OpenAI-compatible endpoint

Any API that speaks OpenAI's `/chat/completions`, on your computer or in the cloud. Pick a **Preset** to fill in the URL and a model, or type your own (the preset menu then says *Custom*):

| Preset | Endpoint URL | Model |
| --- | --- | --- |
| Ollama | `http://localhost:11434/v1` | `qwen3-vl:4b` |
| OpenAI | `https://api.openai.com/v1` | `gpt-5-mini` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-haiku-5-5` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-5-mini` |

- **Endpoint URL**: such as Ollama, LM Studio, llama.cpp's server, or a cloud provider.
- **Model**: it must accept images.
- **API key**: only cloud providers need one. Leave it empty for Ollama. It's kept in your system keychain (Keychain on macOS, Credential Manager on Windows, the Secret Service on Linux), for that endpoint's address only: change the endpoint and Grab-it asks for the key again. On a computer with no keychain Grab-it can use, Settings says it's kept in plain text in Grab-it's settings file instead.

These fields save when you press **Save**, or when you press **Test connection**.

### Run a model on your computer with Ollama

1. Install [Ollama](https://ollama.com).
2. Download the default model in a terminal:

   ```sh
   ollama pull qwen3-vl:4b
   ```

3. In **Settings → AI integration**, choose **OpenAI-compatible endpoint** and the **Ollama** preset, then **Test connection**.

The first answer can take a while as Ollama loads the model.

## What goes where

| Provider | Your screenshots, their text, app and window title go to |
| --- | --- |
| Claude Code | Anthropic, under your Claude account |
| Codex | OpenAI, under your ChatGPT or OpenAI account |
| Endpoint on this computer (`localhost` or `127.x`) | Nowhere. Nothing leaves your computer. |
| Cloud endpoint | That provider, under your API key |

Settings shows the same note under the provider you picked. With describing off, nothing is sent anywhere. See [Privacy](/grab-it/reference/privacy/) for everything else Grab-it does over the network.
