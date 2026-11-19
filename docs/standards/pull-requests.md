# Branch and pull request standards

## Branches

- Name a branch `<type>/<issue>-<short-description>`, or `<type>/<short-description>` when there is no issue. `<type>` is `feature` or `fix`. Examples: `feature/166-ocr-word-boxes`, `fix/duplicate-gtk-dep`.
- Branch from the latest `origin/main`. Give each change its own branch.

## Scope

- One PR does one thing a user (or a developer) would notice. Keep refactors out of feature PRs unless the feature needs them.
- Code, tests and docs ship together (see [writing.md](writing.md)). A PR with nothing to test says why.

## The PR body

- Link the issue: `Closes #123`, or `Part of #123` when the work is split across PRs.
- List what changed in a few bullets that a reviewer can check against the diff.
- Point at the part that most needs a careful look.

## Before merging

- Every check in CI is green. That covers the checks in [AGENTS.md](../../AGENTS.md) and the installer builds on all three platforms.
- A code PR merged to `main` is released right away (see "Releases" in [development.md](../development.md)). Merge only what is ready for users.
- Version bumps are automatic. Don't edit the version in `tauri.conf.json` or `Cargo.toml` by hand.
