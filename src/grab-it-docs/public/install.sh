#!/bin/sh
# Installs the latest Grab-it on macOS or Linux, then opens it.
#
#   curl -fsSL https://kerwincarpede.github.io/grab-it/install.sh | sh
#
# It reads the newest release's latest.json (the same manifest the in-app
# updater uses) and takes the package for this machine from it:
#
#   macOS  the .app.tar.gz, unpacked into /Applications.
#   Linux  the .deb with apt, or the .rpm with dnf or zypper (through sudo
#          unless run as root); otherwise the AppImage in ~/.local/bin with
#          an app menu entry.
#
# Needs curl, tar, and jq or python3. The script is wrapped in main(), so a
# download cut short runs nothing.

set -eu

MANIFEST_URL="https://github.com/kerwincarpede/grab-it/releases/latest/download/latest.json"
RELEASES_URL="https://github.com/kerwincarpede/grab-it/releases/latest"
ICON_URL="https://raw.githubusercontent.com/kerwincarpede/grab-it/main/src/grab-it/src-tauri/icons/128x128.png"
APP_ID="com.kerwincarpede.grabit"

usage() {
  cat <<'EOF'
Install the latest Grab-it on macOS or Linux, then open it.

Usage:
  curl -fsSL https://kerwincarpede.github.io/grab-it/install.sh | sh
  sh install.sh [--help]

macOS: installs Grab-it.app into /Applications.
Linux: installs the .deb (apt) or .rpm (dnf, zypper), using sudo when not
       root; otherwise installs the AppImage into ~/.local/bin and adds
       Grab-it to the app menu.

Needs curl, tar, and jq or python3.
EOF
}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Grab-it install failed: %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

# The latest.json field `.platforms[KEY].url`, or nothing when KEY is absent.
platform_url() {
  if has jq; then
    jq -r --arg key "$1" '.platforms[$key].url // empty' "$MANIFEST"
  else
    python3 - "$1" "$MANIFEST" <<'EOF'
import json, sys
with open(sys.argv[2]) as f:
    entry = json.load(f).get("platforms", {}).get(sys.argv[1]) or {}
print(entry.get("url", ""))
EOF
  fi
}

manifest_version() {
  if has jq; then
    jq -r '.version // empty' "$MANIFEST"
  else
    python3 - "$MANIFEST" <<'EOF'
import json, sys
with open(sys.argv[1]) as f:
    print(json.load(f).get("version", ""))
EOF
  fi
}

download() {
  curl -fsSL --retry 3 -o "$2" "$1" || fail "could not download $1"
}

# Runs a command as root: directly when already root, otherwise with sudo.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

can_be_root() {
  [ "$(id -u)" -eq 0 ] || has sudo
}

has_display() {
  [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]
}

# Starts Grab-it in the background for the desktop user, when there is one.
launch() {
  if [ "$(id -u)" -eq 0 ] || ! has_display; then
    say "Open Grab-it from your app menu."
    return
  fi
  say "Opening Grab-it..."
  nohup "$1" >/dev/null 2>&1 &
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) arch=x86_64 ;;
    arm64 | aarch64) arch=aarch64 ;;
    *) fail "Grab-it has no build for $(uname -m) processors." ;;
  esac
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$os" = darwin ] && [ "$arch" = x86_64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=aarch64
  fi
}

no_build() {
  fail "the latest release ($version) has no $1 for this computer ($os-$arch).
See $RELEASES_URL for the downloads it does have."
}

install_macos() {
  url=$(platform_url "darwin-$arch-app")
  [ -n "$url" ] || no_build "macOS app"

  say "Downloading Grab-it $version for macOS..."
  download "$url" "$tmp/Grab-it.app.tar.gz"
  mkdir "$tmp/app"
  tar -xzf "$tmp/Grab-it.app.tar.gz" -C "$tmp/app"
  app=$(find "$tmp/app" -maxdepth 1 -name '*.app' | head -n 1)
  [ -n "$app" ] || fail "the download has no .app in it."

  dest="/Applications/Grab-it.app"
  run=""
  if [ ! -w /Applications ] || { [ -e "$dest" ] && [ ! -w "$dest" ]; }; then
    say "/Applications is not writable by you, so this step uses sudo."
    run=sudo
  fi

  # Quit a running copy before replacing it.
  if pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1; then
    say "Quitting the running Grab-it..."
    osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
    sleep 2
  fi

  say "Installing into $dest..."
  $run rm -rf "$dest"
  $run mv "$app" "$dest"
  # curl leaves no quarantine flag, but clear any so Gatekeeper never asks.
  $run xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true

  say "Grab-it $version is installed. Opening it..."
  open "$dest"
}

# Sets kind and url to the native package to install: the .deb where apt is,
# the .rpm where dnf or zypper is. Leaves kind empty when there is no package
# manager, no way to become root, or no such package for this machine.
pick_linux_native() {
  kind=""
  url=""
  can_be_root || return 0
  if has apt-get && has dpkg; then
    kind=deb
  elif has dnf || has zypper; then
    kind=rpm
  else
    return 0
  fi
  url=$(platform_url "linux-$arch-$kind")
  [ -n "$url" ] || kind=""
}

# .deb with apt, or .rpm with dnf or zypper, as chosen by pick_linux_native.
install_linux_native() {
  say "Downloading Grab-it $version (.$kind)..."
  pkg="$tmp/grab-it.$kind"
  download "$url" "$pkg"
  # apt reads local packages as its unprivileged _apt user.
  chmod 755 "$tmp"
  chmod 644 "$pkg"

  [ "$(id -u)" -eq 0 ] || say "Installing the package needs sudo."
  case "$kind" in
    deb)
      as_root apt-get install -y "$pkg"
      bin=$(dpkg-deb -c "$pkg" | awk '{print $NF}' | sed -n 's|^\./usr/bin/|/usr/bin/|p' | head -n 1)
      ;;
    rpm)
      if has dnf; then
        as_root dnf install -y "$pkg"
      else
        # The .rpm is not GPG-signed; its download is verified by HTTPS.
        as_root zypper --non-interactive install --allow-unsigned-rpm "$pkg"
      fi
      bin=$(rpm -qlp "$pkg" 2>/dev/null | grep '^/usr/bin/' | head -n 1 || true)
      ;;
  esac

  say "Grab-it $version is installed."
  launch "${bin:-/usr/bin/grab-it}"
}

install_linux_appimage() {
  url=$(platform_url "linux-$arch-appimage")
  [ -n "$url" ] || no_build "Linux package"

  bin_dir="$HOME/.local/bin"
  apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  icon_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/128x128/apps"
  appimage="$bin_dir/Grab-it.AppImage"

  say "Downloading Grab-it $version (AppImage)..."
  download "$url" "$tmp/Grab-it.AppImage"
  chmod 755 "$tmp/Grab-it.AppImage"
  mkdir -p "$bin_dir" "$apps_dir" "$icon_dir"
  # A new file in its place, so a running copy keeps working until it quits.
  mv -f "$tmp/Grab-it.AppImage" "$appimage"

  # The icon is cosmetic; a failed download leaves the menu's default.
  curl -fsSL -o "$icon_dir/grab-it.png" "$ICON_URL" 2>/dev/null ||
    say "Could not download the icon; the app menu shows a default one."

  cat >"$apps_dir/grab-it.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Grab-it
Comment=Screenshot, annotate, record and search your captures
Exec="$appimage"
Icon=grab-it
Terminal=false
Categories=Utility;
EOF
  if has update-desktop-database; then
    update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
  fi

  say "Grab-it $version is installed at $appimage."
  launch "$appimage"
}

main() {
  case "${1:-}" in
    "") ;;
    -h | --help)
      usage
      return 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac

  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "this installer is for macOS and Linux. Download Grab-it for $(uname -s) from $RELEASES_URL." ;;
  esac
  detect_arch

  has curl || fail "curl is required."
  has tar || fail "tar is required."
  has jq || has python3 || fail "jq or python3 is required to read the release manifest."

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t grab-it)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  MANIFEST="$tmp/latest.json"
  download "$MANIFEST_URL" "$MANIFEST"
  version=$(manifest_version)
  [ -n "$version" ] || fail "the release manifest has no version."

  if [ "$os" = darwin ]; then
    install_macos
  else
    pick_linux_native
    if [ -n "$kind" ]; then
      install_linux_native
    else
      install_linux_appimage
    fi
  fi
}

main "$@"
