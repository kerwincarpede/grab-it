# Writing standards

This covers UI text, the docs site, `docs/development.md` and PR titles.

## Voice

- Plain words, short sentences, written to the person using it: "Drag a box over anything you don't want to share."
- Use British spelling in prose: colour, licence, organise. Code identifiers keep their own spelling (`color` in CSS and TypeScript).
- Name UI elements exactly as they appear, in bold: **Settings → AI descriptions**, **Check for updates…**.
- Write keys as they are labelled, in code: `PrintScreen`, `⌘ ⇧ 2`, `Ctrl Alt PrintScreen`. Give each platform's key where they differ.

## Keep the docs true

- A change users can see updates the docs site (`src/grab-it-docs/src/content/docs/`) in the same PR: the feature's page, plus `reference/keyboard-shortcuts.md`, `reference/settings.md` or `reference/privacy.md` if it touches them.
- A change to how something works updates its section of `docs/development.md`, which is the developer reference for every subsystem.
- Describe what Grab-it does today. Check every claim against the code, and leave out plans and history.

## PR titles

- A PR title becomes a line in the release notes that the update prompt shows. Write it as a short sentence a user would understand: "Add the Magnify tool", "Select several Library items and act on them together".
- Release notes drop `ci`, `docs`, `chore`, `build`, `refactor`, `style` and `test` changes (see "Updates" in [development.md](../development.md)).
