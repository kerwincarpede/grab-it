---
title: Updates
description: How Grab-it keeps itself up to date.
sidebar:
  order: 2
---

Once installed, Grab-it keeps itself up to date. About half a minute after it starts, and every few hours after that, it checks for a new release and asks before installing it, listing what's new since your version. Choose **Install and restart**, or **Later** to be asked again the next time Grab-it starts. **Check for updates…** in the tray menu, or the refresh button next to the version at the bottom of the Grab-it window's sidebar, checks right away.

If the Library was open when you chose **Install and restart**, Grab-it reopens it after the update, even if it was minimised. Later launches follow your usual startup behaviour.

You can also read what changed in each version on the [Grab-it releases page](https://github.com/kerwincarpede/grab-it/releases).

## Stable and Edge

Grab-it updates from one of two channels. Pick one with **Update channel** in **Settings → General → Updates**:

- **Stable**, the default: releases that have been tried out first. Best for everyday use.
- **Edge**: every change as soon as it is built. New features come first, and so can new bugs. The Grab-it window's sidebar shows an **Edge** badge next to the version.

Switching channel forgets any update the old channel offered and checks the new one straight away. Grab-it never installs an older version, so moving from Edge back to Stable keeps the version you have until Stable passes it.

:::note[Older Edge copies]
If checking for updates on Edge fails, [download the newest versioned release from GitHub](https://github.com/kerwincarpede/grab-it/releases) and install it once. Older Edge copies read an update address that cannot be repaired because GitHub locked that release. Current copies find the newest published version directly.
:::

## Packages

Updates install the same kind of package you installed: the `.deb` or `.rpm` asks for your password, like `apt` or `dnf` would.

:::note
On macOS, updating from an older version can make macOS ask for Screen Recording permission again, once. See [Troubleshooting](/grab-it/reference/troubleshooting/#macos-captures-show-only-my-wallpaper-again-after-an-update).
:::
