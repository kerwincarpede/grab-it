#!/usr/bin/env python3
"""Chooses the Edge release to promote to Stable, and prints its outputs.

    promote.py --releases RELEASES.json [--version VERSION] --body BODY.md

--releases holds every release (as `GET /releases` returns them, all pages
in one array). --version names the Edge release to promote, with or
without its "v"; without it, the newest Edge pre-release is chosen.

A release is refused when it is a draft, is not a v* release, or is not
newer than the current Stable release (the newest published release that
is not a pre-release). The rolling `edge` release is never chosen.

Prints `id=`, `tag=` and `version=` lines for $GITHUB_OUTPUT, and writes
the release's notes to --body without the "Edge build" paragraph that
release.yml put at their top.
"""

import argparse
import json
import re
import sys
from pathlib import Path

# Release tags: "v1.2.3". The rolling "edge" release is not one.
VERSION_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")

# The paragraph release.yml opens an Edge release's notes with.
EDGE_NOTE = "**Edge build.**"


class Refused(Exception):
    pass


def version_key(release):
    match = VERSION_TAG.match(release.get("tag_name", ""))
    return tuple(int(part) for part in match.groups()) if match else None


def stable(releases):
    """The current Stable release, or None before the first one."""
    published = [
        r
        for r in releases
        if not r.get("draft") and not r.get("prerelease") and version_key(r)
    ]
    return max(published, key=version_key, default=None)


def choose(releases, version=None):
    """The release to promote; raises Refused when there is none."""
    if version:
        tag = "v" + version.strip().removeprefix("v")
        matches = [r for r in releases if r.get("tag_name") == tag]
        if not matches:
            raise Refused(f"there is no release {tag}")
        if any(r.get("draft") for r in matches):
            raise Refused(f"{tag} is a draft, not a published Edge release")
        chosen = matches[0]
        if not version_key(chosen):
            raise Refused(f"{tag} is not a version")
    else:
        edge = [
            r
            for r in releases
            if r.get("prerelease") and not r.get("draft") and version_key(r)
        ]
        if not edge:
            raise Refused("there is no Edge release to promote")
        chosen = max(edge, key=version_key)

    current = stable(releases)
    if current and version_key(chosen) <= version_key(current):
        raise Refused(
            f"{chosen['tag_name']} is not newer than Stable "
            f"({current['tag_name']})"
        )
    return chosen


def stable_body(body):
    """The release notes without the Edge build paragraph."""
    lines = (body or "").splitlines()
    kept = [line for line in lines if not line.strip().startswith(EDGE_NOTE)]
    text = "\n".join(kept).strip("\n")
    return text + "\n" if text else ""


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--releases", required=True)
    parser.add_argument("--version", default="")
    parser.add_argument("--body", required=True)
    args = parser.parse_args()

    releases = json.loads(Path(args.releases).read_text())
    try:
        chosen = choose(releases, args.version)
    except Refused as refusal:
        sys.exit(f"Cannot promote: {refusal}.")
    Path(args.body).write_text(stable_body(chosen.get("body")))
    print(f"id={chosen['id']}")
    print(f"tag={chosen['tag_name']}")
    print(f"version={chosen['tag_name'].removeprefix('v')}")


if __name__ == "__main__":
    main()
