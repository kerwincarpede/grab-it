import unittest

from check_manifest import validate
from updater_manifest import REQUIRED


class Manifest(unittest.TestCase):
    def manifest(self):
        return {"version": "1.2.3", "platforms": {
            target: {"signature": "sig", "url": "https://github.com/package"}
            for target in REQUIRED
        }}

    def test_reuses_a_complete_manifest(self):
        validate(self.manifest(), "1.2.3")

    def test_refuses_wrong_version_missing_platform_and_unsigned_package(self):
        with self.assertRaises(ValueError):
            validate(self.manifest(), "1.2.4")
        manifest = self.manifest()
        del manifest["platforms"][REQUIRED[0]]
        with self.assertRaises(ValueError):
            validate(manifest, "1.2.3")
        manifest = self.manifest()
        manifest["platforms"][REQUIRED[0]]["signature"] = ""
        with self.assertRaises(ValueError):
            validate(manifest, "1.2.3")
