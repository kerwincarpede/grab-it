---
title: AI descriptions
description: A short description, a category and tags for each capture, so you can search for what it shows.
sidebar:
  order: 1
---

With **Use an AI provider** and **Describe captures with AI** on in **Settings → AI integration**, every new screenshot is described in the background, newest first, one at a time, once Grab-it has read its text. The Library shows *Describing 3 of 12…* while it works.

## What you get

For each screenshot the AI writes:

- **A description**: one or two sentences on what the screenshot shows and what it's about, naming the app, site, product, error or topic you might search for. It's in the details panel under **Description**.
- **A category**: one of the list below. It's in the details panel, and you can filter by it.
- **Up to three tags**: short, lowercase, most specific first, such as the app, product, language or topic. They're marked **✦** in the details, and work like your own tags in search, the sidebar and **Filters → Tag**. Remove any you don't want.

Search then finds a capture by its description too: `invoice` finds a receipt even if the word *invoice* isn't in it.

Recordings aren't described.

## Categories

| Category | For |
| --- | --- |
| Code | Source code in an editor or on a page |
| Terminal | A shell or command output |
| Browser / web page | A website |
| Chat | Slack, Teams, Messages and the like |
| Document | Docs, PDFs, spreadsheets |
| Design | Figma, mockups, artwork |
| Error / dialog | Error messages, alerts and dialogs |
| Receipt | Receipts, invoices, orders |
| Photo | Photographs |
| Other | Anything else, or a category the AI made up |

## What the AI is sent

Each screenshot goes scaled down to at most 1568 pixels on its long edge, with up to 2,000 characters of the text Grab-it read in it, the app name and the window title. Where it goes depends on the [provider](/grab-it/ai/providers/#what-goes-where).

## Old captures

**Only describe new captures** is on by default, so turning describing on leaves earlier captures alone. Turn it off to describe the whole library; **Save** first says how many screenshots that is and waits for you to confirm.

**Re-describe all…** under **Your library** describes every capture again, replacing the current descriptions. It's useful after switching to a better model. It asks first, saying how many screenshots it will describe.

To redo one capture, click **Redo** next to its **Description** in the details panel. **Clear** removes its description, category and AI tags.

## When it can't describe

If the provider can't be reached, times out, or isn't signed in, describing pauses and the Library says *Could not describe captures*, with the reason and an **Open Settings** button. Captures wait their turn; Grab-it tries again with the next capture, no sooner than a minute later, or straight away when you change the AI settings. A capture whose answer can't be used is skipped, and the rest carry on.

A local model on a slow computer can take minutes for one image, so Grab-it gives an endpoint up to five minutes without progress before it gives up.

## Turn it off

Open **Settings → AI integration**, turn off **Describe captures with AI** and press **Save**. Nothing more is sent for descriptions. Captures still waiting are left undescribed. Descriptions already written stay until you **Clear** them.
