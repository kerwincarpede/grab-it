"""Exercise mirror fallback without changing this machine's package manager."""

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import install_linux_deps as deps

SOURCE = "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\n"


class Downloads(unittest.TestCase):
    def test_handles_hosted_mirror_lists_and_security_sources(self):
        result = deps.sources(SOURCE, "archive.ubuntu.com", "x86_64")
        self.assertEqual(result.count("URIs: https://archive.ubuntu.com/ubuntu/"), 2)
        self.assertIn("Suites: noble-security", result)
        self.assertNotIn("mirror+file", result)

    def test_arm_uses_ports_then_original_runner_mirror(self):
        self.assertIn("https://ports.ubuntu.com/ubuntu-ports/", deps.sources(SOURCE, "archive.ubuntu.com", "aarch64"))
        self.assertEqual(deps.sources(SOURCE, "azure.archive.ubuntu.com", "aarch64"), SOURCE)

    @patch.object(deps.subprocess, "run")
    def test_timeout_falls_back_before_installing_without_network(self, run):
        run.side_effect = [None, subprocess.TimeoutExpired("apt-get", 180), None, None, None]
        with tempfile.TemporaryDirectory() as folder, patch.object(deps.platform, "machine", return_value="x86_64"):
            source = Path(folder) / "ubuntu.sources"
            source.write_text(SOURCE)
            deps.install(["libwebkit2gtk-4.1-dev"], source)
            self.assertIn("azure.archive.ubuntu.com", source.read_text())
        self.assertEqual(len(run.call_args_list), 5)
        self.assertIn("--download-only", run.call_args_list[1].args[0])
        self.assertIn("--no-download", run.call_args_list[-1].args[0])
        self.assertNotIn("timeout", run.call_args_list[-1].kwargs)

    @patch.object(deps.subprocess, "run")
    def test_both_mirrors_failing_does_not_run_dpkg(self, run):
        run.side_effect = subprocess.CalledProcessError(100, "apt-get")
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "ubuntu.sources"
            source.write_text(SOURCE)
            with self.assertRaises(RuntimeError):
                deps.install(["libwebkit2gtk-4.1-dev"], source)
        self.assertEqual(len(run.call_args_list), 2)
        self.assertTrue(all("--no-download" not in call.args[0] for call in run.call_args_list))
