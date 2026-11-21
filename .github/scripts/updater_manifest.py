#!/usr/bin/env python3
"""Writes the updater's latest.json for a release, and prints it.

    updater_manifest.py --sigs DIR --release RELEASE.json \\
        --history RELEASES.json --download-base URL [--release-notes FILE]

--sigs holds the release's `.sig` assets, named as they are on the
release. Each one signs the asset of the same name without `.sig`, which
is downloaded from <download-base>/<name>.

--release is the GitHub release being published (as `GET
/releases/{id}` returns it) and --history the releases before it (as `GET
/releases` returns them). Their generated notes become `changes`: what
each recent version brought, newest first, so Grab-it can list everything
an update brings, however many versions behind it is. Edge pre-releases
count, so a Stable release lists the Edge versions since the last one; the
rolling `edge` release, whose tag is not a version, does not. `notes` repeats this
release's list as Markdown, for anything that reads only the standard
fields.

--release-notes writes the cleaned release body for the GitHub release page.

Grab-it's updater looks for `<os>-<arch>-<installer>` first, so each kind
of install updates with its own kind of package, and then `<os>-<arch>`.
A universal macOS package runs on both Apple silicon and Intel, so it is
listed under both darwin architectures.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

# Package suffix -> (os, installer, whether it is the os's default package).
PACKAGES = [
    (".app.tar.gz", "darwin", "app", True),
    (".AppImage", "linux", "appimage", True),
    (".deb", "linux", "deb", False),
    (".rpm", "linux", "rpm", False),
    ("-setup.exe", "windows", "nsis", True),
    (".msi", "windows", "msi", False),
]

# Every release must update these, or it is not published.
REQUIRED = [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-x86_64",
]

# How many versions `changes` covers, this one included.
HISTORY = 50

# Conventional-commit types that change nothing a user sees.
UNSEEN = {"build", "chore", "ci", "docs", "refactor", "style", "test"}
VISIBLE_TYPES = {"feat", "fix", "perf", "revert"}

# "feat(library)!: " -> type "feat"
PREFIX = re.compile(r"^(?P<type>[a-z]+)(\([^)]*\))?!?:\s*", re.I)
# GitHub's " by @someone in https://github.com/.../pull/12"
CREDIT = re.compile(r"\s+by @\S+ in https://\S+$")


def arches_of(name):
    """The architectures a package runs on; empty when its name doesn't say."""
    if "universal" in name:
        return ["aarch64", "x86_64"]
    if re.search(r"(aarch64|arm64)", name):
        return ["aarch64"]
    if re.search(r"(x86_64|x64|amd64)", name):
        return ["x86_64"]
    return []


def platforms(sig_dir, download_base):
    found = {}
    for sig in sorted(Path(sig_dir).glob("*.sig")):
        package = sig.name[: -len(".sig")]
        for suffix, os_name, installer, default in PACKAGES:
            if not package.endswith(suffix):
                continue
            arches = arches_of(package)
            if not arches:
                sys.exit(f"cannot tell the architecture of {package}")
            entry = {
                "signature": sig.read_text().strip(),
                "url": f"{download_base}/{quote(package)}",
            }
            for arch in arches:
                found[f"{os_name}-{arch}-{installer}"] = entry
                if default:
                    found[f"{os_name}-{arch}"] = entry
            break
    return found


def split_change_section(body):
    """Find GitHub's generated heading and bullet list within the release body."""
    lines = (body or "").splitlines(keepends=True)
    for start, line in enumerate(lines):
        if not (line.startswith("#") and line.lstrip("#").strip().lower() == "what's changed"):
            continue
        end = start + 1
        while end < len(lines):
            text = lines[end].strip()
            if text and not text.startswith(("* ", "- ")):
                break
            end += 1
        return lines[:start], lines[start:end], lines[end:]
    return lines, [], []


def visible_changes(section):
    for line in section[1:]:
        line = line.strip()
        if not line.startswith(("* ", "- ")):
            continue
        text = line[2:].strip()
        credit = CREDIT.search(text)
        if credit:
            text = text[:credit.start()]
        prefix = PREFIX.match(text)
        if prefix:
            kind = prefix.group("type").lower()
            if kind in UNSEEN:
                continue
            if kind in VISIBLE_TYPES:
                text = text[prefix.end():]
        if text:
            yield line[:2], text[0].upper() + text[1:], credit.group() if credit else ""


def change_items(body):
    """The release changes shown in the in-app update prompt."""
    _, section, _ = split_change_section(body)
    return [title for _, title, _ in visible_changes(section)]


def public_release_notes(body):
    """The GitHub release body with readable change titles and PR credits."""
    before, section, after = split_change_section(body)
    bullets = [f"{bullet}{title}{credit}\n" for bullet, title, credit in visible_changes(section)]
    if bullets:
        before.extend([section[0], *bullets, "\n"])
    return "".join(before + after)


def version_of(release):
    return release["tag_name"].removeprefix("v")


def version_key(version):
    return tuple(int(part) for part in re.findall(r"\d+", version)[:3])


# Release tags: "v1.2.3". The rolling "edge" release is not one.
VERSION_TAG = re.compile(r"^v\d+\.\d+\.\d+$")


def is_version(release):
    return bool(VERSION_TAG.match(release.get("tag_name", "")))


def changes(release, history):
    earlier = [
        r
        for r in history
        if not r.get("draft")
        and is_version(r)
        and r.get("id") != release.get("id")
        and version_key(version_of(r)) < version_key(version_of(release))
    ]
    earlier.sort(key=lambda r: version_key(version_of(r)), reverse=True)
    return [
        {"version": version_of(r), "items": change_items(r.get("body"))}
        for r in [release, *earlier][:HISTORY]
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sigs", required=True)
    parser.add_argument("--release", required=True)
    parser.add_argument("--history", required=True)
    parser.add_argument("--download-base", required=True)
    parser.add_argument("--release-notes", type=Path)
    args = parser.parse_args()

    release = json.loads(Path(args.release).read_text())
    history = json.loads(Path(args.history).read_text())
    found = platforms(args.sigs, args.download_base.rstrip("/"))
    missing = [target for target in REQUIRED if target not in found]
    if missing:
        sys.exit(f"no signed update package for {', '.join(missing)}")
    recent = changes(release, history)
    manifest = {
        "version": version_of(release),
        "notes": "\n".join(f"- {item}" for item in recent[0]["items"]),
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": dict(sorted(found.items())),
        "changes": recent,
    }
    if args.release_notes:
        args.release_notes.write_text(public_release_notes(release.get("body")), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
