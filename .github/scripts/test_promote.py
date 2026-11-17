"""Tests for promote.py: python3 -m unittest discover .github/scripts"""

import unittest

import promote


def release(tag, **extra):
    return {"id": tag, "tag_name": tag, "body": "", **extra}


RELEASES = [
    release("v0.4.0"),
    release("v0.3.0"),
    release("v0.4.1", prerelease=True),
    release("v0.4.2", prerelease=True),
    release("v0.4.3", draft=True),
    release("edge", prerelease=True),
]


class Choose(unittest.TestCase):
    def test_picks_the_newest_edge_release(self):
        self.assertEqual(promote.choose(RELEASES)["tag_name"], "v0.4.2")

    def test_never_picks_a_draft_or_the_rolling_edge_release(self):
        releases = [
            release("v0.4.0"),
            release("v0.5.0", prerelease=True, draft=True),
            release("edge", prerelease=True),
        ]
        with self.assertRaises(promote.Refused):
            promote.choose(releases)

    def test_promotes_a_named_version_with_or_without_its_v(self):
        self.assertEqual(promote.choose(RELEASES, "0.4.1")["tag_name"], "v0.4.1")
        self.assertEqual(promote.choose(RELEASES, "v0.4.1")["tag_name"], "v0.4.1")

    def test_refuses_a_draft(self):
        with self.assertRaisesRegex(promote.Refused, "draft"):
            promote.choose(RELEASES, "0.4.3")

    def test_refuses_versions_not_above_stable(self):
        with self.assertRaisesRegex(promote.Refused, "not newer than Stable"):
            promote.choose(RELEASES, "0.4.0")
        with self.assertRaisesRegex(promote.Refused, "not newer than Stable"):
            promote.choose(RELEASES, "0.3.0")
        releases = [release("v0.5.0"), release("v0.4.9", prerelease=True)]
        with self.assertRaisesRegex(promote.Refused, "not newer than Stable"):
            promote.choose(releases)

    def test_refuses_a_missing_version_or_a_tag_that_is_not_one(self):
        with self.assertRaisesRegex(promote.Refused, "no release"):
            promote.choose(RELEASES, "9.9.9")
        with self.assertRaisesRegex(promote.Refused, "not a version"):
            promote.choose([release("vnext", prerelease=True)], "next")

    def test_compares_versions_as_numbers(self):
        releases = [release("v0.9.0"), release("v0.10.0", prerelease=True)]
        self.assertEqual(promote.choose(releases)["tag_name"], "v0.10.0")

    def test_promotes_before_any_stable_release(self):
        releases = [release("v0.1.0", prerelease=True)]
        self.assertEqual(promote.choose(releases)["tag_name"], "v0.1.0")


class Stable(unittest.TestCase):
    def test_is_the_newest_published_full_release(self):
        self.assertEqual(promote.stable(RELEASES)["tag_name"], "v0.4.0")

    def test_is_none_before_the_first(self):
        self.assertIsNone(promote.stable([release("v0.1.0", prerelease=True)]))


class StableBody(unittest.TestCase):
    def test_drops_the_edge_build_paragraph(self):
        body = (
            "**Edge build.** Copies on Edge offer this update.\n\n"
            "## Install\n\nDownload it.\n\n## What's Changed\n* feat: one\n"
        )
        self.assertEqual(
            promote.stable_body(body),
            "## Install\n\nDownload it.\n\n## What's Changed\n* feat: one\n",
        )

    def test_keeps_notes_without_one(self):
        self.assertEqual(promote.stable_body("## Install\n"), "## Install\n")
        self.assertEqual(promote.stable_body(None), "")


if __name__ == "__main__":
    unittest.main()
