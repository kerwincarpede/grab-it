#!/usr/bin/env python3
"""Install CI dependencies with bounded downloads and a second Ubuntu mirror."""

import os
import platform
import re
import subprocess
import sys
from pathlib import Path

APT = ["apt-get", "-o", "Acquire::Retries=1", "-o", "Acquire::http::Timeout=20",
       "-o", "Acquire::https::Timeout=20"]


def sources(text, mirror, arch):
    # ubuntu.sources uses deb822. Hosted runners may use mirror+file: URIs,
    # so replace its URI lines rather than only matching http:// hostnames.
    # Third-party sources live in other files and are left alone.
    if arch in ("aarch64", "arm64"):
        if mirror != "archive.ubuntu.com":
            return text  # Fall back to the runner's original ports mirror.
        uri = "https://ports.ubuntu.com/ubuntu-ports/"
    else:
        uri = f"https://{mirror}/ubuntu/"
    return re.sub(r"(?m)^URIs:.*$", f"URIs: {uri}", text)


def install(packages, source=Path("/etc/apt/sources.list.d/ubuntu.sources")):
    original = source.read_text()
    for mirror in ("archive.ubuntu.com", "azure.archive.ubuntu.com"):
        source.write_text(sources(original, mirror, platform.machine()))
        try:
            subprocess.run([*APT, "update", "--error-on=any"], check=True, timeout=120)
            # Bound only downloads: interrupting dpkg can leave packages half installed.
            subprocess.run([*APT, "install", "-y", "--no-install-recommends", "--download-only", *packages],
                           check=True, timeout=180)
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            print(f"::warning::Downloads from {mirror} failed; trying the next mirror.", flush=True)
    else:
        raise RuntimeError("Could not download Linux build dependencies from either mirror")
    subprocess.run([*APT, "install", "-y", "--no-install-recommends", "--no-download", *packages], check=True)


if __name__ == "__main__":
    os.environ["DEBIAN_FRONTEND"] = "noninteractive"
    install(sys.argv[1:])
