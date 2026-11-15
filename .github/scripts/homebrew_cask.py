#!/usr/bin/env python3
"""Writes the Homebrew cask for a release, and prints it.

    homebrew_cask.py --version VERSION --url DMG_URL --sha256 SHA256

The cask installs the release's universal .dmg, which runs on Apple
silicon and Intel Macs. It lives in the kerwincarpede/homebrew-tap repo as
Casks/grab-it.rb, so users install with

    brew install --cask kerwincarpede/tap/grab-it

Grab-it updates itself, so the cask sets `auto_updates`: `brew upgrade`
leaves a running copy alone. The app is not notarized, so the postflight
clears the quarantine flag Homebrew puts on the download, and Grab-it
opens without the Gatekeeper prompt.
"""

import argparse
import re
import sys

APP = "Grab-it.app"
IDENTIFIER = "com.kerwincarpede.grabit"

VERSION = re.compile(r"^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
# An https URL that is safe inside a Ruby double-quoted string.
URL = re.compile(r'^https://[^\s"\\#]+\.dmg$')

TEMPLATE = """\
cask "grab-it" do
  version "{version}"
  sha256 "{sha256}"

  url "{url}"
  name "Grab-it"
  desc "Screenshot, annotate and paste anywhere"
  homepage "https://kerwincarpede.github.io/grab-it/"

  auto_updates true

  app "{app}"

  # Grab-it is not notarized: clear the quarantine flag so it opens without
  # the Gatekeeper prompt.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{{appdir}}/{app}"]
  end

  zap trash: [
    "~/Library/Application Support/{identifier}",
    "~/Library/Caches/{identifier}",
    # "Start at login" registers a LaunchAgent named after the app.
    "~/Library/LaunchAgents/Grab-it.plist",
    "~/Library/Preferences/{identifier}.plist",
    "~/Library/Saved Application State/{identifier}.savedState",
    "~/Library/WebKit/{identifier}",
  ]
end
"""


def render(version, url, sha256):
    """The cask's Ruby source; raises ValueError on an input it can't hold."""
    version = version.removeprefix("v")
    sha256 = sha256.lower()
    if not VERSION.match(version):
        raise ValueError(f"not a version: {version!r}")
    if not URL.match(url):
        raise ValueError(f"not an https .dmg URL: {url!r}")
    if not SHA256.match(sha256):
        raise ValueError(f"not a sha256: {sha256!r}")
    return TEMPLATE.format(
        version=version, url=url, sha256=sha256, app=APP, identifier=IDENTIFIER
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--version", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    try:
        cask = render(args.version, args.url, args.sha256)
    except ValueError as error:
        sys.exit(str(error))
    sys.stdout.write(cask)


if __name__ == "__main__":
    main()
