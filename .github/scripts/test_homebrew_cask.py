"""Tests for homebrew_cask.py: python3 -m unittest discover .github/scripts"""

import unittest

import homebrew_cask as cask

VERSION = "0.4.0"
URL = (
    "https://github.com/kerwincarpede/grab-it/releases/download/"
    "v0.4.0/Grab-it_0.4.0_universal.dmg"
)
SHA256 = "ab" * 32


class Render(unittest.TestCase):
    def setUp(self):
        self.rb = cask.render(VERSION, URL, SHA256)

    def test_names_the_release_and_its_dmg(self):
        self.assertTrue(self.rb.startswith('cask "grab-it" do\n'))
        self.assertIn('  version "0.4.0"\n', self.rb)
        self.assertIn(f'  sha256 "{SHA256}"\n', self.rb)
        self.assertIn(f'  url "{URL}"\n', self.rb)
        self.assertIn('  app "Grab-it.app"\n', self.rb)
        self.assertTrue(self.rb.endswith("\nend\n"))

    def test_leaves_updates_to_the_app(self):
        self.assertIn("  auto_updates true\n", self.rb)

    def test_clears_quarantine_after_installing(self):
        self.assertIn("  postflight do\n", self.rb)
        self.assertIn('system_command "/usr/bin/xattr"', self.rb)
        self.assertIn(
            'args: ["-dr", "com.apple.quarantine", "#{appdir}/Grab-it.app"]', self.rb
        )

    def test_zaps_the_app_data(self):
        self.assertIn(
            '"~/Library/Application Support/com.kerwincarpede.grabit",', self.rb
        )

    def test_zaps_the_login_item(self):
        self.assertIn('"~/Library/LaunchAgents/Grab-it.plist",', self.rb)

    def test_blocks_are_balanced(self):
        opened = sum(line.rstrip().endswith((" do", "[")) for line in self.rb.splitlines())
        closed = sum(line.strip() in ("end", "]") for line in self.rb.splitlines())
        self.assertEqual(opened, closed)

    def test_accepts_a_tag_and_an_uppercase_hash(self):
        self.assertEqual(cask.render("v0.4.0", URL, SHA256.upper()), self.rb)


class Rejects(unittest.TestCase):
    def test_a_bad_version(self):
        for version in ["", "latest", "0.4", '0.4.0"']:
            with self.subTest(version=version), self.assertRaises(ValueError):
                cask.render(version, URL, SHA256)

    def test_a_bad_url(self):
        for url in [
            "http://example.com/Grab-it.dmg",
            "https://example.com/Grab-it.zip",
            'https://example.com/"#{x}".dmg',
        ]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                cask.render(VERSION, url, SHA256)

    def test_a_bad_hash(self):
        for sha256 in ["", "ab" * 31, "zz" * 32]:
            with self.subTest(sha256=sha256), self.assertRaises(ValueError):
                cask.render(VERSION, URL, sha256)


if __name__ == "__main__":
    unittest.main()
