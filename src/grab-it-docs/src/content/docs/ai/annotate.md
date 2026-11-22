---
title: Annotate with AI
description: Describe the boxes, arrows and labels you want on a screenshot, preview what AI suggests, and keep only what you apply.
sidebar:
  order: 3
---

In the [image editor](/grab-it/image-editor/), **Annotate with AI** marks up a capture the way you describe it. Type something like *Box the provider controls, point an arrow at Test connection and label it*, then press **Suggest** (or ⌘/Ctrl+Enter).

## Preview, then apply

The suggestions show faded on the capture and are listed in the panel. Nothing is added to your capture yet:

- **×** beside a suggestion discards just that one.
- **Discard** drops them all.
- **Apply** adds every suggestion still listed, drawn with the colour and widths your Rectangle, Arrow and Text tools use now.

Applied suggestions are ordinary boxes, arrows and text: select them to move, restyle or retype them. One **Undo** takes away everything one **Apply** added. They're saved with your other edits and come back when you open the capture again.

AI can only box, point at and label things. When it suggests something Grab-it can't place, such as a label that matches more than one piece of text, or a shape outside the capture, it's left out and the panel says how many.

## No provider yet?

Annotate with AI uses the provider you chose in **Settings → AI integration**. If you haven't chosen one, the panel says so and **Open AI integration** opens Settings at AI integration. The editor stays open with your request typed in, so press **Suggest** again once you've saved a provider.

**Cancel** stops waiting for an answer. Anything that arrives afterwards is ignored. Suggesting gives up when the provider goes two minutes without answering.

Models that reason before they answer are slower and less reliable here. If one spends its whole reply budget thinking, Grab-it asks once more with a larger budget, so the wait can pass two minutes: nearly three has been seen. It can also think through both budgets and send no answer, and the panel then says to choose a model without reasoning or turn reasoning off in the server. For Annotate with AI, turn reasoning off if your server allows it.

## What is sent

Each **Suggest** sends your [provider](/grab-it/ai/providers/#what-goes-where):

- the capture as it was taken, scaled down to at most 1568 pixels on its long side, without your edits;
- the text Grab-it read in it, line by line, with where each line is;
- your request.

The text was read on your computer, the same text the Library searches. If none was read, the capture and your request still go, and AI places shapes by where it sees things. Nothing is sent until you press **Suggest**.
