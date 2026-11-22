import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('packaging_route.sh').resolve()


class PackagingRouteTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def route(self, event, manual=''):
        env = dict(os.environ, GITHUB_EVENT_NAME=event, MANUAL_PACKAGE=manual,
                   RUNNER_TEMP=str(self.root))
        return subprocess.check_output(['bash', SCRIPT], cwd=self.root,
                                       env=env, text=True).strip()

    def git(self, *args):
        subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
                        '-c', 'commit.gpgsign=false', *args], cwd=self.root, check=True,
                       stdout=subprocess.DEVNULL)

    def test_pr_changes(self):
        self.git('init', '-q')
        asset = self.root / 'src/grab-it/src-tauri/face-models/LICENSE'
        asset.parent.mkdir(parents=True)
        asset.write_text('license')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        front = self.root / 'src/grab-it/src/main.ts'
        front.parent.mkdir(parents=True)
        front.write_text('change')
        self.git('add', '.')
        self.git('commit', '-qm', 'ordinary')
        self.assertEqual(self.route('pull_request'), 'package=false')
        asset.rename(self.root / 'LICENSE')
        self.git('add', '-A')
        self.git('commit', '-qm', 'move bundle input')
        self.assertEqual(self.route('pull_request'), 'package=true')

    def test_dispatch_and_release(self):
        self.assertEqual(self.route('workflow_dispatch', 'false'), 'package=false')
        self.assertEqual(self.route('workflow_dispatch', 'true'), 'package=true')
        self.assertEqual(self.route('push'), 'package=true')
