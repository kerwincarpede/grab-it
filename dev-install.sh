#!/usr/bin/env bash
# Builds Grab-it from this checkout as "Grab-it Dev" and (re)installs it in
# /Applications, next to the released Grab-it.
#
# The dev copy has its own name and bundle identifier, so its settings,
# library and macOS permissions are its own and the real Grab-it is never
# touched. It is stamped with the latest release's version, so its update
# check never offers to replace it with the released app.
#
# It is signed with the same identity every time, so macOS keeps its Screen
# Recording permission across reinstalls: an Apple Development or Developer
# ID certificate in your keychain if you have one, otherwise a local
# self-signed certificate this script makes once and keeps. Set
# GRAB_IT_SIGNING_IDENTITY to pick another identity.
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

# --- Signing ------------------------------------------------------------
# macOS remembers Screen Recording permission by the app's code signature.
# An ad-hoc signature is a hash of one exact build, so every reinstall
# looked like a new app; a certificate gives every build the same identity.

LOCAL_IDENTITY="Grab-it Dev Local Signing"
LOCAL_KEYCHAIN="$HOME/Library/Keychains/grab-it-dev-signing.keychain-db"
LOCAL_SECRETS="$HOME/Library/Application Support/Grab-it Dev Signing"

# Makes the local self-signed identity once, in a keychain of its own so
# codesign can use it without asking. Keep it: a new one means granting
# Screen Recording once more.
make_local_identity() {
  echo "==> Making a local signing certificate (once): ${LOCAL_IDENTITY}"
  mkdir -p "$LOCAL_SECRETS"
  chmod 700 "$LOCAL_SECRETS"
  local work password
  work="$(mktemp -d)"
  password="$(/usr/bin/openssl rand -base64 24)"
  (
    umask 077
    printf '%s\n' "$password" > "$LOCAL_SECRETS/keychain-password"
  )
  cat > "$work/cert.cnf" <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${LOCAL_IDENTITY}
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  # /usr/bin/openssl (LibreSSL) writes the older PKCS#12 that `security
  # import` reads; a Homebrew OpenSSL 3 would not by default.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 7300 \
    -config "$work/cert.cnf" -extensions ext \
    -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
  /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
    -name "$LOCAL_IDENTITY" -out "$work/identity.p12" -passout "pass:$password"
  security create-keychain -p "$password" "$LOCAL_KEYCHAIN"
  security set-keychain-settings "$LOCAL_KEYCHAIN"
  security unlock-keychain -p "$password" "$LOCAL_KEYCHAIN"
  security import "$work/identity.p12" -k "$LOCAL_KEYCHAIN" -f pkcs12 \
    -P "$password" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$password" "$LOCAL_KEYCHAIN" >/dev/null
  rm -rf "$work"
}

# Unlocks the local keychain and puts it where codesign looks.
use_local_identity() {
  [[ -f "$LOCAL_KEYCHAIN" ]] || make_local_identity
  security unlock-keychain -p "$(cat "$LOCAL_SECRETS/keychain-password")" "$LOCAL_KEYCHAIN"
  if ! security list-keychains -d user | grep -q "grab-it-dev-signing"; then
    # shellcheck disable=SC2046 # the existing list, one keychain per word
    security list-keychains -d user -s "$LOCAL_KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  fi
}

if [[ -n "${GRAB_IT_SIGNING_IDENTITY:-}" ]]; then
  identity="$GRAB_IT_SIGNING_IDENTITY"
else
  # An Apple-issued certificate already has a lasting identity.
  identity="$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -oE '"(Apple Development|Developer ID Application): [^"]+"' | head -n 1 | tr -d '"' || true)"
  if [[ -z "$identity" ]]; then
    use_local_identity
    identity="$LOCAL_IDENTITY"
  fi
fi
echo "==> Signing as: ${identity}"

echo "==> Building ${APP_NAME} ${version} from $(git -C "$root" rev-parse --abbrev-ref HEAD) ($(git -C "$root" rev-parse --short HEAD))"
[[ -d node_modules ]] || npm ci
APPLE_SIGNING_IDENTITY="$identity" npm run tauri build -- --bundles app --config \
  "{\"productName\":\"${APP_NAME}\",\"version\":\"${version}\",\"identifier\":\"${IDENTIFIER}\"}"

bundle="$root/app/src-tauri/target/release/bundle/macos/${APP_NAME}.app"
[[ -d "$bundle" ]] || { echo "The build did not produce ${bundle}." >&2; exit 1; }

# Ad-hoc would mean granting Screen Recording again after every reinstall.
requirement="$(codesign -d -r- "$bundle" 2>&1 || true)"
if [[ "$requirement" == *"cdhash"* ]] || ! codesign --verify --strict "$bundle" 2>/dev/null; then
  echo "The app was not signed with a lasting identity (${identity}):" >&2
  echo "$requirement" >&2
  exit 1
fi

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

echo "If macOS asks for Screen Recording again, allow it once: this signature is kept from now on."

if [[ $open_after -eq 1 ]]; then
  echo "==> Opening ${APP_NAME} (it starts in the menu bar)"
  open "$DEST"
fi
echo "Done."
