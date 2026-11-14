#!/usr/bin/env python3
"""Writes the updater's latest.json for a release, and prints it.

    updater_manifest.py --sigs DIR --release RELEASE.json \\
        --history RELEASES.json --download-base URL

--sigs holds the release's `.sig` assets, named as they are on the
release. Each one signs the asset of the same name without `.sig`, which
is downloaded from <download-base>/<name>.

--release is the GitHub release being published (as `GET
/releases/{id}` returns it) and --history the releases before it (as `GET
/releases` returns them). Their generated notes become `changes`: what
each recent version brought, newest first, so Grab-it can list everything
an update brings, however many versions behind it is. `notes` repeats this
release's list as Markdown, for anything that reads only the standard
fields.

Grab-it's updater looks for `<os>-<arch>-<installer>` first, so each kind
of install updates with its own kind of package, and then `<os>-<arch>`.
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
REQUIRED = ["darwin-aarch64", "linux-x86_64", "windows-x86_64"]

# How many versions `changes` covers, this one included.
HISTORY = 20

# Conventional-commit types that change nothing a user sees.
UNSEEN = {"build", "chore", "ci", "docs", "refactor", "style", "test"}

# "feat(library)!: " -> type "feat"
PREFIX = re.compile(r"^(?P<type>[a-z]+)(\([^)]*\))?!?:\s*")
# GitHub's " by @someone in https://github.com/.../pull/12"
CREDIT = re.compile(r"\s+by @\S+ in https://\S+$")


def arch_of(name):
    if re.search(r"(aarch64|arm64)", name):
        return "aarch64"
    if re.search(r"(x86_64|x64|amd64)", name):
        return "x86_64"
    return None


def platforms(sig_dir, download_base):
    found = {}
    for sig in sorted(Path(sig_dir).glob("*.sig")):
        package = sig.name[: -len(".sig")]
        for suffix, os_name, installer, default in PACKAGES:
            if not package.endswith(suffix):
                continue
            arch = arch_of(package)
            if arch is None:
                sys.exit(f"cannot tell the architecture of {package}")
            entry = {
                "signature": sig.read_text().strip(),
                "url": f"{download_base}/{quote(package)}",
            }
            found[f"{os_name}-{arch}-{installer}"] = entry
            if default:
                found[f"{os_name}-{arch}"] = entry
            break
    return found


def change_items(body):
    """The user-facing entries of a release's generated "What's Changed"."""
    items = []
    in_changes = False
    for line in (body or "").splitlines():
        line = line.strip()
        if line.startswith("#"):
            in_changes = line.lstrip("#").strip().lower() == "what's changed"
            continue
        if not in_changes or not line.startswith(("* ", "- ")):
            continue
        text = CREDIT.sub("", line[2:].strip())
        prefix = PREFIX.match(text)
        if prefix:
            if prefix.group("type") in UNSEEN:
                continue
            text = text[prefix.end() :]
        if text:
            items.append(text[0].upper() + text[1:])
    return items


def version_of(release):
    return release["tag_name"].removeprefix("v")


def version_key(version):
    return tuple(int(part) for part in re.findall(r"\d+", version)[:3])


def changes(release, history):
    earlier = [
        r
        for r in history
        if not r.get("draft")
        and not r.get("prerelease")
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
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
