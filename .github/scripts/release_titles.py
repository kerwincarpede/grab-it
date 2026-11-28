#!/usr/bin/env python3
"""Names Edge releases and finds abandoned drafts.

    release_titles.py title --releases RELEASES.json --version VERSION
    release_titles.py stale-drafts --releases RELEASES.json --version VERSION

--releases holds every release (as `GET /releases` returns them, all pages
in one array). --version is the version being published, such as 0.15.9.

`title` prints `name=0.15.9 · Edge RC 3`: the Nth Edge release since the
current Stable one. Lower versions still being built count too, so two
overlapping releases never share a number. promote.yml renames a promoted
release to `0.15.9 · Stable`.

`stale-drafts` prints the ids of drafts for lower versions that are more
than a day old. Their runs failed and nothing is building them; retrying
such a commit reserves its version again.
"""

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

VERSION_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")

# How long a draft may belong to a run that is still queued or building.
DRAFT_LIFETIME = timedelta(days=1)


def version_key(release):
    match = VERSION_TAG.match(release.get("tag_name", ""))
    return tuple(int(part) for part in match.groups()) if match else None


def parse_version(version):
    return version_key({"tag_name": "v" + version.strip().removeprefix("v")})


def created(release):
    return datetime.fromisoformat(release["created_at"].replace("Z", "+00:00"))


def edge_title(releases, version, now):
    """The title for the Edge release of `version`."""
    version = version.strip().removeprefix("v")
    key = parse_version(version)
    stable = max(
        (
            version_key(r)
            for r in releases
            if not r.get("draft") and not r.get("prerelease") and version_key(r)
        ),
        default=None,
    )
    earlier = [
        r
        for r in releases
        if version_key(r)
        and version_key(r) < key
        and (stable is None or version_key(r) > stable)
        and (
            r.get("prerelease") and not r.get("draft")
            or r.get("draft") and now - created(r) < DRAFT_LIFETIME
        )
    ]
    return f"{version} · Edge RC {len(earlier) + 1}"


def stale_drafts(releases, version, now):
    """Drafts for lower versions whose runs have long stopped."""
    key = parse_version(version)
    return [
        r["id"]
        for r in releases
        if r.get("draft")
        and version_key(r)
        and version_key(r) < key
        and now - created(r) >= DRAFT_LIFETIME
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=["title", "stale-drafts"])
    parser.add_argument("--releases", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    releases = json.loads(Path(args.releases).read_text())
    now = datetime.now(timezone.utc)
    if args.command == "title":
        print("name=" + edge_title(releases, args.version, now))
    else:
        for draft in stale_drafts(releases, args.version, now):
            print(draft)


if __name__ == "__main__":
    main()
