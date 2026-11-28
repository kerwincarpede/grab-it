"""Tests for release_titles.py: python3 -m unittest discover .github/scripts"""

import unittest
from datetime import datetime, timedelta, timezone

import release_titles

NOW = datetime(2026, 11, 28, 12, tzinfo=timezone.utc)


def release(tag, age=timedelta(days=3), **extra):
    return {
        "id": tag,
        "tag_name": tag,
        "created_at": (NOW - age).isoformat().replace("+00:00", "Z"),
        **extra,
    }


class EdgeTitle(unittest.TestCase):
    def title(self, releases, version):
        return release_titles.edge_title(releases, version, NOW)

    def test_counts_edge_releases_since_stable(self):
        releases = [
            release("v0.15.0", prerelease=True),
            release("v0.15.1"),
            release("v0.15.2", prerelease=True),
            release("v0.15.3", prerelease=True),
        ]
        self.assertEqual(self.title(releases, "0.15.4"), "0.15.4 · Edge RC 3")

    def test_starts_at_one_after_a_promotion(self):
        releases = [release("v0.15.1", prerelease=True), release("v0.15.2")]
        self.assertEqual(self.title(releases, "0.15.3"), "0.15.3 · Edge RC 1")

    def test_counts_from_the_start_before_any_stable(self):
        releases = [release("v0.1.0", prerelease=True)]
        self.assertEqual(self.title(releases, "0.1.1"), "0.1.1 · Edge RC 2")

    def test_a_lower_version_still_building_keeps_its_number(self):
        # 0.15.4 finishes first while 0.15.3 is still building.
        releases = [release("v0.15.2"), release("v0.15.3", age=timedelta(minutes=20), draft=True)]
        self.assertEqual(self.title(releases, "0.15.4"), "0.15.4 · Edge RC 2")

    def test_ignores_abandoned_drafts_higher_versions_and_other_tags(self):
        releases = [
            release("v0.15.2"),
            release("v0.15.3", draft=True),
            release("v0.15.5", prerelease=True),
            release("edge", prerelease=True),
        ]
        self.assertEqual(self.title(releases, "0.15.4"), "0.15.4 · Edge RC 1")

    def test_accepts_a_leading_v(self):
        self.assertEqual(self.title([], "v0.2.0"), "0.2.0 · Edge RC 1")


class StaleDrafts(unittest.TestCase):
    def test_lists_old_drafts_for_lower_versions_only(self):
        releases = [
            release("v0.11.4", draft=True),
            release("v0.11.5", age=timedelta(hours=2), draft=True),
            release("v0.12.1", draft=True),
            release("v0.11.3", prerelease=True),
            release("edge", draft=True),
        ]
        self.assertEqual(
            release_titles.stale_drafts(releases, "0.12.0", NOW), ["v0.11.4"]
        )


if __name__ == "__main__":
    unittest.main()
