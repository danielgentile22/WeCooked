#!/bin/bash
# Signs build/WeCooked.xcarchive for the App Store and, unless --no-upload, sends it to
# TestFlight, with no Apple ID in Xcode and no prompt on screen. The export signs manually
# with the "We Cooked App Store <bundle id> 2026-11-01" profiles named in
# Config/ExportOptions.plist and the distribution certificate in the shared tvhome-signing
# keychain, which SIGNING_KEYCHAIN_PASSWORD in server/.env unlocks (sent to `security -i`
# on stdin, so it never shows in the process list) and which is locked again on every exit.
# The upload uses the App Store Connect API key in server/.env.
#
#   scripts/ios-export.sh              # export and upload
#   scripts/ios-export.sh --no-upload  # export only (build/export/WeCooked.ipa)
set -euo pipefail
cd "$(dirname "$0")/.."
env_value() { sed -n "s/^$1=//p" server/.env | tr -d '\r'; }
for name in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_PATH SIGNING_KEYCHAIN_PASSWORD; do
  [ -n "$(env_value "$name")" ] || { echo "error: $name is missing from server/.env" >&2; exit 1; }
done
key_path=$(env_value ASC_KEY_PATH)
key_path=${key_path/#\~/$HOME}
keychain=$HOME/Library/Keychains/tvhome-signing.keychain-db

# Quotes a word for `security -i`, which reads backslash escapes inside double quotes.
security_quote() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
trap 'security lock-keychain "$keychain"' EXIT
printf 'unlock-keychain -p %s %s\n' "$(security_quote "$(env_value SIGNING_KEYCHAIN_PASSWORD)")" \
  "$(security_quote "$keychain")" | security -i

team=$(sed -n 's/^DEVELOPMENT_TEAM *= *//p' Config/Local.xcconfig)
sed "s/\$(DEVELOPMENT_TEAM)/$team/" Config/ExportOptions.plist > build/ExportOptions.plist
rm -rf build/export
# Apple's openrsync runs `rsync` from PATH, and Homebrew's rejects its options ("Copy failed").
PATH=/usr/bin:/bin:/usr/sbin:/sbin xcodebuild -exportArchive -archivePath build/WeCooked.xcarchive \
  -exportPath build/export -exportOptionsPlist build/ExportOptions.plist -quiet
[ "${1:-}" = --no-upload ] && { echo "Exported $PWD/build/export/WeCooked.ipa (not uploaded)"; exit 0; }
xcrun altool --upload-app -t ios -f build/export/WeCooked.ipa --apiKey "$(env_value ASC_KEY_ID)" \
  --apiIssuer "$(env_value ASC_ISSUER_ID)" --p8-file-path "$key_path"
