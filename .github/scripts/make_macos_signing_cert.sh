#!/usr/bin/env bash
# Makes the self-signed certificate CI signs the macOS app with, and
# optionally stores it as the MACOS_CERTIFICATE and MACOS_CERTIFICATE_PASSWORD
# repository secrets.
#
# macOS remembers privacy permissions (Screen Recording, keychain access) by
# the app's code signature. An ad-hoc signature is a hash of that exact build,
# so every update looked like a new app. A certificate, even a self-signed one,
# gives every build the same identity, so permissions survive updates.
#
# Run this once. Reusing the same certificate is what keeps permissions, so
# keep the .p12 and its password somewhere safe: replacing it makes every
# installed copy ask for permissions once more.
#
#   .github/scripts/make_macos_signing_cert.sh <output-dir> [--set-secrets]
#
# Needs openssl (and gh for --set-secrets). Works on Linux and macOS.
set -euo pipefail

NAME="Grab-it Self-Signed Code Signing"
DAYS=7300 # 20 years: the certificate cannot be swapped without a re-grant.

out=${1:?usage: $0 <output-dir> [--set-secrets]}
set_secrets=${2:-}

mkdir -p "$out"
chmod 700 "$out"
umask 077
if [[ -e "$out/grab-it-signing.p12" ]]; then
  echo "$out/grab-it-signing.p12 already exists; refusing to replace it." >&2
  exit 1
fi

password=$(openssl rand -base64 24)

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
  -keyout "$out/key.pem" -out "$out/cert.pem" \
  -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" 2>/dev/null

# macOS `security import` reads only the older PKCS#12 encryption.
openssl pkcs12 -export -legacy \
  -inkey "$out/key.pem" -in "$out/cert.pem" -name "$NAME" \
  -out "$out/grab-it-signing.p12" -passout "pass:$password"

printf '%s\n' "$password" > "$out/grab-it-signing.password"
rm "$out/key.pem"

echo "Wrote $out/grab-it-signing.p12 and $out/grab-it-signing.password"
openssl x509 -in "$out/cert.pem" -noout -subject -enddate -fingerprint -sha256

if [[ "$set_secrets" == "--set-secrets" ]]; then
  base64 < "$out/grab-it-signing.p12" | tr -d '\n' | gh secret set MACOS_CERTIFICATE
  gh secret set MACOS_CERTIFICATE_PASSWORD < "$out/grab-it-signing.password"
  echo "Set the MACOS_CERTIFICATE and MACOS_CERTIFICATE_PASSWORD secrets."
fi

echo "Back up the .p12 and its password; CI cannot recover them."
