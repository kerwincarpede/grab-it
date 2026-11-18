#!/usr/bin/env python3
"""Check that an immutable release can update every supported platform."""

import json
import sys
from pathlib import Path

from updater_manifest import REQUIRED


def validate(manifest, version):
    if manifest.get("version") != version:
        raise ValueError("The updater manifest has the wrong version")
    platforms = manifest.get("platforms", {})
    for target in REQUIRED:
        entry = platforms.get(target, {})
        if not entry.get("signature") or not entry.get("url", "").startswith("https://"):
            raise ValueError(f"No signed HTTPS update package for {target}")


if __name__ == "__main__":
    validate(json.loads(Path(sys.argv[1]).read_text()), sys.argv[2])
