"""Version reservations must survive retries and builds finishing out of order."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from release_version import bump, choose, code_change


def commit(sha, message="fix: something", paths=None):
    return {"sha": sha, "message": message, "paths": paths or ["src/app.rs"]}


class Versions(unittest.TestCase):
    def test_later_run_can_reserve_before_earlier_run(self):
        commits = [commit("base"), commit("one"), commit("two")]
        anchors = {"base": (0, 7, 57)}
        self.assertEqual(choose(commits, anchors, (0, 2, 0)), (0, 7, 59))
        anchors["two"] = (0, 7, 59)
        self.assertEqual(choose(commits[:2], anchors, (0, 2, 0)), (0, 7, 58))

    def test_publishing_or_reserving_an_earlier_commit_changes_nothing(self):
        commits = [commit("base"), commit("one", "feat(editor): one"), commit("two")]
        self.assertEqual(choose(commits, {"base": (0, 7, 57)}, (0, 2, 0)), (0, 8, 1))
        self.assertEqual(choose(commits, {"base": (0, 7, 57), "one": (0, 8, 0)}, (0, 2, 0)), (0, 8, 1))

    def test_failed_draft_keeps_its_version_on_retry(self):
        self.assertEqual(choose([commit("one")], {"one": (1, 2, 3)}, (0, 2, 0)), (1, 2, 3))
        with self.assertRaises(ValueError):
            choose([commit("one")], {"one": (1, 2, 3)}, (0, 2, 0), "minor")

    def test_docs_only_merges_do_not_consume_a_version(self):
        commits = [commit("base"), commit("docs", paths=["docs/a.md", "src/grab-it-docs/a.ts"]), commit("one")]
        self.assertEqual(choose(commits, {"base": (0, 7, 57)}, (0, 2, 0)), (0, 7, 58))
        self.assertFalse(code_change(["README.md"]))
        self.assertTrue(code_change(["README.md", ".github/workflows/ci.yml"]))

    def test_first_release_uses_config_and_dispatch_can_release_docs(self):
        self.assertEqual(choose([commit("one")], {}, (0, 2, 0)), (0, 2, 0))
        self.assertEqual(choose([commit("base"), commit("docs", paths=["README.md"])],
                                {"base": (1, 2, 3)}, (0, 2, 0), "minor"), (1, 3, 0))

    def test_conventional_messages_and_explicit_bumps(self):
        self.assertEqual(bump((1, 2, 3), "auto", "feat!: breaking"), (2, 0, 0))
        self.assertEqual(bump((1, 2, 3), "auto", "fix: one\n\nBREAKING CHANGE: two"), (2, 0, 0))
        self.assertEqual(bump((1, 2, 3), "auto", "feat(editor): one"), (1, 3, 0))
        self.assertEqual(bump((1, 2, 3), "patch", "feat!: one"), (1, 2, 4))


class GitHistory(unittest.TestCase):
    def test_cli_replays_real_history_and_reuses_an_out_of_order_reservation(self):
        script = Path(__file__).with_name("release_version.py").resolve()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            env = {**os.environ, "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
                   "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com"}

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, env=env, text=True).strip()

            def save(path, text, message):
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(text)
                git("add", ".")
                git("commit", "-qm", message)
                return git("rev-parse", "HEAD")

            git("init", "-q")
            save("src/grab-it/src-tauri/tauri.conf.json", '{"version":"0.2.0"}', "base")
            git("tag", "v1.2.3")
            save("README.md", "docs", "docs: one")
            one = save("src/app.rs", "one", "feat: one")
            # A real merge commit: diff-tree must compare its first parent.
            tree = git("rev-parse", "HEAD^{tree}")
            parent = git("rev-parse", "HEAD^")
            merged = git("commit-tree", tree, "-p", parent, "-p", one, "-m", "feat: merged")
            releases = root / "releases.json"
            releases.write_text("[]")

            def version(sha):
                return subprocess.check_output([
                    "python3", str(script), "--releases", str(releases), "--sha", sha,
                ], cwd=root, text=True).strip()

            self.assertEqual(version(merged), "version=1.3.0")
            two = save("src/app.rs", "two", "fix: two")
            self.assertEqual(version(two), "version=1.3.1")
            releases.write_text(json.dumps([{
                "draft": True, "tag_name": "v1.3.1", "target_commitish": two,
            }]))
            self.assertEqual(version(one), "version=1.3.0")
            self.assertEqual(version(two), "version=1.3.1")
