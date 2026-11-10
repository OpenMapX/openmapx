#!/bin/sh
# Renders /.well-known/apple-app-site-association and /.well-known/assetlinks.json
# from the well-known service's settings, then runs the given command (nginx).
#
# Settings, all optional:
#   MOBILE_APPLE_TEAM_ID        ten-character Apple Team ID
#   MOBILE_IOS_BUNDLE_IDS       comma-separated iOS bundle identifiers
#   MOBILE_ANDROID_PACKAGES     comma-separated Android application ids
#   MOBILE_ANDROID_CERT_SHA256  comma-separated SHA-256 certificate fingerprints
#
# With nothing set, both files are valid and claim nothing. A platform that is
# only partly configured, or a malformed value, stops the container: an
# association that silently fails to verify is worse than a visible error.

set -eu
umask 022

out=${OPENMAPX_APP_LINKS_DIR:-/var/lib/openmapx/app-links}

fail() {
  printf 'well-known: %s\n' "$1" >&2
  exit 1
}

# Splits a comma-separated setting into one trimmed, non-empty value per line.
values() {
  printf '%s\n' "$1" | tr ',' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' |
    grep -v '^$' || true
}

matches() {
  printf '%s\n' "$1" | grep -Eq "$2"
}

# The paths the app is willing to open. Everything else stays a web link.
COMPONENTS='{ "/": "/" }, { "/": "/navigation/active" }, { "/": "/mobile-auth" }, { "/": "/mobile-auth/callback" }'
APP_ID='^[A-Za-z][A-Za-z0-9]*([.][A-Za-z][A-Za-z0-9]*){2,}$'
FINGERPRINT='^([0-9A-F]{2}:){31}[0-9A-F]{2}$'

team=$(printf '%s' "${MOBILE_APPLE_TEAM_ID:-}" | tr -d '[:space:]')
bundles=$(values "${MOBILE_IOS_BUNDLE_IDS:-}")
packages=$(values "${MOBILE_ANDROID_PACKAGES:-}")
fingerprints=$(values "${MOBILE_ANDROID_CERT_SHA256:-}" | tr '[:lower:]' '[:upper:]')

apple_ids=""
if [ -n "$team" ] || [ -n "$bundles" ]; then
  [ -n "$team" ] || fail "MOBILE_IOS_BUNDLE_IDS is set but MOBILE_APPLE_TEAM_ID is not"
  [ -n "$bundles" ] || fail "MOBILE_APPLE_TEAM_ID is set but MOBILE_IOS_BUNDLE_IDS is not"
  matches "$team" '^[A-Z0-9]{10}$' || fail "MOBILE_APPLE_TEAM_ID must be ten uppercase letters or digits"
  for bundle in $bundles; do
    matches "$bundle" "$APP_ID" || fail "MOBILE_IOS_BUNDLE_IDS contains an invalid bundle identifier: $bundle"
    apple_ids="${apple_ids:+$apple_ids, }\"$team.$bundle\""
  done
fi

statements=""
if [ -n "$packages" ] || [ -n "$fingerprints" ]; then
  [ -n "$packages" ] || fail "MOBILE_ANDROID_CERT_SHA256 is set but MOBILE_ANDROID_PACKAGES is not"
  [ -n "$fingerprints" ] || fail "MOBILE_ANDROID_PACKAGES is set but MOBILE_ANDROID_CERT_SHA256 is not"
  certs=""
  for fingerprint in $fingerprints; do
    matches "$fingerprint" "$FINGERPRINT" ||
      fail "MOBILE_ANDROID_CERT_SHA256 must hold colon-separated SHA-256 fingerprints"
    certs="${certs:+$certs, }\"$fingerprint\""
  done
  for package in $packages; do
    matches "$package" "$APP_ID" || fail "MOBILE_ANDROID_PACKAGES contains an invalid application id: $package"
    statements="${statements:+$statements,
}  {
    \"relation\": [\"delegate_permission/common.get_login_creds\", \"delegate_permission/common.handle_all_urls\"],
    \"target\": { \"namespace\": \"android_app\", \"package_name\": \"$package\", \"sha256_cert_fingerprints\": [$certs] }
  }"
  done
fi

mkdir -p "$out"
if [ -n "$apple_ids" ]; then
  apple="{
  \"applinks\": { \"details\": [{ \"appIDs\": [$apple_ids], \"components\": [$COMPONENTS] }] },
  \"webcredentials\": { \"apps\": [$apple_ids] }
}"
else
  apple='{ "applinks": { "details": [] }, "webcredentials": { "apps": [] } }'
fi
if [ -n "$statements" ]; then
  android="[
$statements
]"
else
  android='[]'
fi
printf '%s\n' "$apple" >"$out/apple-app-site-association.tmp"
printf '%s\n' "$android" >"$out/assetlinks.json.tmp"
mv "$out/apple-app-site-association.tmp" "$out/apple-app-site-association"
mv "$out/assetlinks.json.tmp" "$out/assetlinks.json"

if [ "$#" -gt 0 ]; then exec "$@"; fi
