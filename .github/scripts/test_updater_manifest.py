"""Tests for updater_manifest.py: python3 -m unittest discover .github/scripts"""

import tempfile
import unittest
from pathlib import Path

import updater_manifest as manifest

BODY = """## Install

Download the installer.

## What's Changed
* feat: check for updates by @someone in https://github.com/o/r/pull/23
* fix(editor)!: keep the crop when undoing by @someone in https://github.com/o/r/pull/24
* ci: release manually by @someone in https://github.com/o/r/pull/17
* docs(readme): a new GIF by @someone in https://github.com/o/r/pull/22
* Browse captures in a library by @someone in https://github.com/o/r/pull/6

## New Contributors
* @someone made their first contribution in https://github.com/o/r/pull/1

**Full Changelog**: https://github.com/o/r/compare/v0.3.0...v0.4.0
"""


def release(version, body="", **extra):
    return {"id": version, "tag_name": f"v{version}", "body": body, **extra}


class ChangeItems(unittest.TestCase):
    def test_lists_what_users_see_without_prefixes_or_credits(self):
        self.assertEqual(
            manifest.change_items(BODY),
            [
                "Check for updates",
                "Keep the crop when undoing",
                "Browse captures in a library",
            ],
        )

    def test_a_body_without_changes_has_none(self):
        self.assertEqual(manifest.change_items(None), [])
        self.assertEqual(manifest.change_items("## Install\n* not a change"), [])


class Changes(unittest.TestCase):
    def test_newest_first_skipping_drafts_prereleases_and_later_versions(self):
        history = [
            release("0.2.0", "## What's Changed\n* feat: two"),
            release("0.10.0", "## What's Changed\n* feat: ten"),
            release("0.3.0", "## What's Changed\n* feat: three"),
            release("0.3.1", draft=True),
            release("0.3.2", prerelease=True),
        ]
        got = manifest.changes(release("0.4.0", BODY), history)
        self.assertEqual([c["version"] for c in got], ["0.4.0", "0.3.0", "0.2.0"])
        self.assertEqual(got[1]["items"], ["Three"])

    def test_keeps_only_recent_versions(self):
        history = [release(f"0.1.{n}") for n in range(40)]
        got = manifest.changes(release("0.2.0"), history)
        self.assertEqual(len(got), manifest.HISTORY)
        self.assertEqual(got[-1]["version"], "0.1.21")


class Platforms(unittest.TestCase):
    def test_maps_each_package_to_its_targets(self):
        with tempfile.TemporaryDirectory() as sigs:
            for name in [
                "Grab-it_aarch64.app.tar.gz",
                "Grab-it_0.4.0_amd64.AppImage",
                "Grab-it_0.4.0_amd64.deb",
                "Grab-it-0.4.0-1.x86_64.rpm",
                "Grab-it_0.4.0_x64-setup.exe",
                "Grab-it_0.4.0_x64_en-US.msi",
            ]:
                Path(sigs, f"{name}.sig").write_text(f"sig {name}\n")
            found = manifest.platforms(sigs, "https://dl")
        self.assertEqual(found["darwin-aarch64"], found["darwin-aarch64-app"])
        self.assertEqual(
            found["windows-x86_64"]["url"], "https://dl/Grab-it_0.4.0_x64-setup.exe"
        )
        self.assertEqual(
            found["windows-x86_64-msi"]["signature"], "sig Grab-it_0.4.0_x64_en-US.msi"
        )
        self.assertEqual(found["linux-x86_64"], found["linux-x86_64-appimage"])
        self.assertIn("linux-x86_64-deb", found)
        self.assertIn("linux-x86_64-rpm", found)
        self.assertTrue(set(manifest.REQUIRED) <= set(found))


if __name__ == "__main__":
    unittest.main()
