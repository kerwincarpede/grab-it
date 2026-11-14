#!/usr/bin/env bash
# Builds Grab-it from this checkout as "Grab-it Dev" and (re)installs it in
# /Applications, next to the released Grab-it.
#
# The dev copy has its own name and bundle identifier, so its settings,
# library and macOS permissions are its own and the real Grab-it is never
# touched. It is stamped with the latest release's version, so its update
# check never offers to replace it with the released app.
#
# Usage: ./dev-install.sh [--no-open] [--version X.Y.Z]
#   --no-open        install without starting it
#   --version X.Y.Z  stamp this version instead of the latest release tag
set -euo pipefail

APP_NAME="Grab-it Dev"
IDENTIFIER="com.kerwincarpede.grabit.dev"
DEST="/Applications/${APP_NAME}.app"

open_after=1
version=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-open) open_after=0 ;;
    --version)
      version="${2:-}"
      [[ -n "$version" ]] || { echo "--version needs a value, such as 0.5.2" >&2; exit 2; }
      shift
      ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script installs a macOS app; run it on a Mac." >&2
  exit 1
fi

root="$(cd "$(dirname "$0")" && pwd)"
cd "$root/app"

# A shell that did not load your profile may not have Rust on its PATH.
export PATH="$HOME/.cargo/bin:$PATH"
for tool in cargo npm; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed or not on PATH." >&2; exit 1; }
done

if [[ -z "$version" ]]; then
  version="$(git -C "$root" tag --list 'v*' --sort=-v:refname | head -n 1)"
  version="${version#v}"
  if [[ -z "$version" ]]; then
    version="$(node -p 'require("./package.json").version')"
  fi
fi

echo "==> Building ${APP_NAME} ${version} from $(git -C "$root" rev-parse --abbrev-ref HEAD) ($(git -C "$root" rev-parse --short HEAD))"
[[ -d node_modules ]] || npm ci
npm run tauri build -- --bundles app --config \
  "{\"productName\":\"${APP_NAME}\",\"version\":\"${version}\",\"identifier\":\"${IDENTIFIER}\"}"

bundle="$root/app/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
[[ -d "$bundle" ]] || { echo "The build did not produce ${bundle}." >&2; exit 1; }

if pgrep -f "${DEST}/Contents/MacOS/" >/dev/null; then
  echo "==> Quitting the running ${APP_NAME}"
  osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    pgrep -f "${DEST}/Contents/MacOS/" >/dev/null || break
    sleep 0.25
  done
  pkill -f "${DEST}/Contents/MacOS/" 2>/dev/null || true
fi

echo "==> Installing ${DEST}"
rm -rf "$DEST"
ditto "$bundle" "$DEST"

if pgrep -fx "target/debug/grab-it" >/dev/null || pgrep -f "/Grab-it.app/Contents/MacOS/" >/dev/null; then
  echo "Note: another Grab-it is running. Quit it first, or the two will fight over the hotkeys."
fi

if [[ $open_after -eq 1 ]]; then
  echo "==> Opening ${APP_NAME} (it starts in the menu bar)"
  open "$DEST"
fi
echo "Done."
