---
title: AI agents
description: Let Claude Code, Codex and other AI agents take screenshots with Grab-it, and install the skill that teaches them how.
sidebar:
  order: 4
---

AI agents such as [Claude Code](https://claude.com/claude-code) and [Codex](https://developers.openai.com/codex/cli) can take screenshots with Grab-it: to see the app they're building, check a page they changed, or show you what they found. They use Grab-it's [command line](/grab-it/reference/command-line/#commands), and a skill teaches them its commands.

## Set it up

1. Open **Settings → AI agents**.
2. Turn on **Let AI agents use Grab-it**. It's off until you turn it on.
3. Click **Install skill**. Grab-it writes its skill to `~/.agents/skills/grab-it` and `~/.claude/skills/grab-it`, where Codex, Claude Code and other agents look for skills. The skill has the full path to Grab-it in it, so agents find it even when it isn't on your `PATH`.

Start a new session in your agent, then ask it, say, to *take a screenshot of the Firefox window*.

If you move or reinstall Grab-it somewhere else, Settings says the skill is installed for Grab-it in another place: click **Install skill** again.

## What an agent can do

- **List your displays and windows**, with their names and where they are on screen.
- **Take a screenshot** of every display, one display, one window (by id, or by its app's name or title) or a region, after a delay if it wants, scaled down to a width it picks.

It can't annotate, read your Library, or search it.

## What you see

Each screenshot an agent takes:

- is saved to your save folder and Library like any other, tagged **agent**, so you can find them all by that tag in the Library,
- shows a short **Captured by an agent** notice in the corner,
- isn't copied to the clipboard, and doesn't open Quick Access or the editor.

Grab-it can't tell one agent from another, or an agent from a script: anything that runs as you on this computer can use the commands while access is on.

## Turning it off

Turn **Let AI agents use Grab-it** off and every command fails at once, with a message telling the agent where to turn it back on. The skill can stay installed.

## Privacy

The commands only reach the Grab-it running as you on this computer: on Linux and macOS through a socket file only you can open, on Windows through a pipe only you can connect to. Nothing is sent over the internet. What the agent does with a screenshot afterwards is up to the agent: Claude Code and Codex send what they look at to Anthropic or OpenAI, as with any file they read.

:::note[Linux on Wayland]
Agents can't take screenshots on Wayland, where only your desktop may read the screen. The commands fail with a message saying so.
:::
