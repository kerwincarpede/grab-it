# AGENTS.md

Grab-it is a Tauri 2 desktop app for screenshots and screen recording on Windows, macOS and Linux: a Rust backend in `src/grab-it/src-tauri/`, a React + TypeScript frontend in `src/grab-it/src/`, and a Starlight docs site in `src/grab-it-docs/`. The root is an npm workspace with the one lockfile.

## Rules that are never broken

- **Every merge to `main` ships.** Merges that touch code cut an Edge pre-release that copies on the Edge update channel offer at once; Stable copies get it once the owner promotes it with `promote.yml`. Nothing lands with a failing check.
- **Three platforms, every time.** Code must build and behave on Windows, macOS and Linux (X11 and Wayland). Platform code sits behind `#[cfg(...)]` with a fallback for the others.
- **Users' data survives every update.** Originals are never modified, saved files stay readable, and library migrations are append-only. See [saved data](docs/standards/saved-data.md).
- **Nothing new leaves the computer silently.** No analytics or telemetry. Any new network request must be added to the [privacy page](src/grab-it-docs/src/content/docs/reference/privacy.md).
- **Never touch the signing setup.** Leave the updater key (`plugins.updater.pubkey`), the macOS certificate and their secrets alone. Losing them strands every installed copy.
- **Edit generators, not their output.** `docs/assets/demo.svg`, `demo.gif` and the landing tour SVGs come from `docs/assets/*.py`.

## Checks

Run these before you push. CI runs the same ones:

```sh
npm ci                                   # repository root
cd src/grab-it
npm run lint && npm run test:coverage && npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

`npm run test:coverage` fails below 90% of lines or 83% of branches. CI runs the Rust tests under `cargo llvm-cov` instead of `cargo test`, which needs the `llvm-tools-preview` rustup component.

## Read before you start

Load only what the task touches.

| When you are... | Read |
| --- | --- |
| Changing Rust in `src-tauri/` | [docs/standards/rust.md](docs/standards/rust.md) |
| Changing the frontend in `src/grab-it/src/` | [docs/standards/frontend.md](docs/standards/frontend.md) |
| Touching settings, the Library database, sidecars or files on disk | [docs/standards/saved-data.md](docs/standards/saved-data.md) |
| Writing UI text, docs or a PR title | [docs/standards/writing.md](docs/standards/writing.md) |
| Branching, committing or opening a PR | [docs/standards/pull-requests.md](docs/standards/pull-requests.md) |
| Working on a subsystem (capture, recording, editor, OCR, AI, settings) | Its section under "How it works" in [docs/development.md](docs/development.md) |
| Setting up, running the app, releases, updates, ffmpeg | The matching section of [docs/development.md](docs/development.md) |
| Changing capture overlay performance | [docs/analysis/capture-overlay-performance.md](docs/analysis/capture-overlay-performance.md) |
| Editing the docs site | "Improve these docs" in [contribute/index.md](src/grab-it-docs/src/content/docs/contribute/index.md) |
