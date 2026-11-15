---
title: AI descriptions
description: Describe captures and tidy up captured text with Claude Code, Codex or a local model.
sidebar:
  order: 1
---

If you have [Claude Code](https://claude.com/claude-code) installed, Grab-it uses it to describe each new capture: a sentence or two, a category and a few tags, so you can search for what a screenshot *shows* and filter by category in the [Library](/grab-it/library/find-it-again/). It turns this on by itself the first time it finds Claude Code, and the Library says so once. Those screenshots go to Anthropic under your Claude account.

## Tidied-up text

The same AI tidies up [**Capture text**](/grab-it/capture/more-tricks/). The text is copied the moment it's read, then the AI reads it again from the image. It fixes what was misread, and lays out JSON (valid and indented), code (with its indentation) and tables (as Markdown). The tidied text replaces what was copied, unless you've copied something else since. **Copy as read** on the card gets the original back. Turn it off under **Tidy up captured text**.

## Providers and turning it off

To turn it off, or use another provider such as a local [Ollama](https://ollama.com) model that keeps everything on your computer, open **Settings** → **AI descriptions**.

Without Claude Code but with [Codex](https://developers.openai.com/codex/cli) installed, Grab-it uses Codex the same way, and those screenshots go to OpenAI under your ChatGPT or OpenAI account. With neither, describing stays off until you turn it on there.
