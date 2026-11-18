#!/usr/bin/env python3
"""Reserve versions in commit order, even when release builds overlap.

Published tags and draft releases are anchors. Replay first-parent commits
after the nearest anchor, skipping docs-only changes just as release.yml does.
The version job is serialised; builds need not be. Failed drafts keep their
reservation so a retry gets the same version and later versions never move.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

VERSION = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def bump(version, kind, message=""):
    major, minor, patch = version
    if kind == "auto":
        if re.search(r"^[a-z]+(?:\([^\n]*\))?!:", message, re.M) or "BREAKING CHANGE:" in message:
            kind = "major"
        elif re.search(r"^feat(?:\([^\n]*\))?:", message, re.M):
            kind = "minor"
        else:
            kind = "patch"
    return {
        "major": (major + 1, 0, 0),
        "minor": (major, minor + 1, 0),
        "patch": (major, minor, patch + 1),
    }[kind]


def code_change(paths):
    return any(
        not (p.startswith(("docs/", "src/grab-it-docs/")) or p.endswith(".md"))
        for p in paths
    )


def choose(commits, anchors, initial, kind="auto"):
    """commits is oldest first, with sha/message/paths; anchors maps sha to version."""
    target = commits[-1]["sha"]
    if target in anchors:
        if kind != "auto":
            raise ValueError("This commit already has a version reservation; retry with auto.")
        return anchors[target]
    version = None
    for commit in commits:
        sha = commit["sha"]
        if sha in anchors:
            version = anchors[sha]
        elif code_change(commit["paths"]) or sha == target:
            version = initial if version is None else bump(
                version, kind if sha == target else "auto", commit["message"]
            )
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--releases", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--bump", choices=["auto", "major", "minor", "patch"], default="auto")
    args = parser.parse_args()
    releases = json.loads(Path(args.releases).read_text())
    anchors = {}
    published = set()
    for tag in git("tag", "--list", "v*").splitlines():
        if match := VERSION.fullmatch(tag):
            sha = git("rev-parse", f"{tag}^{{commit}}")
            anchors[sha] = tuple(map(int, match.groups()))
            published.add(sha)
    for release in releases:
        if release.get("draft") and (match := VERSION.fullmatch(release["tag_name"])):
            anchors[release["target_commitish"]] = tuple(map(int, match.groups()))
    if args.sha in published:
        sys.exit("This commit is already released; push new commits to main first.")
    # An explicit bump cannot invalidate versions already reserved for descendants.
    if args.bump != "auto":
        for sha in anchors:
            if sha != args.sha and subprocess.run(
                ["git", "merge-base", "--is-ancestor", args.sha, sha],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            ).returncode == 0:
                sys.exit("Newer commits already have versions; force a bump on a new commit instead.")
    commits = []
    for sha in git("rev-list", "--first-parent", "--reverse", args.sha).splitlines():
        commits.append({
            "sha": sha,
            "message": git("show", "-s", "--format=%B", sha),
            "paths": git("diff-tree", "--root", "--first-parent", "--no-commit-id", "--name-only", "-r", sha).splitlines(),
        })
    initial = tuple(map(int, json.loads(Path("src/grab-it/src-tauri/tauri.conf.json").read_text())["version"].split(".")))
    try:
        version = choose(commits, anchors, initial, args.bump)
    except ValueError as error:
        sys.exit(str(error))
    # The version must not collide with a reservation on another commit.
    if any(value == version and sha != args.sha for sha, value in anchors.items()):
        sys.exit("This version is reserved for another commit; inspect the release drafts.")
    print("version=" + ".".join(map(str, version)))


if __name__ == "__main__":
    main()
