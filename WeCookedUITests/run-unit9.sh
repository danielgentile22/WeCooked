#!/usr/bin/env bash
# Runs the unit 9 UI tests one at a time, each after the prep that seeds a
# choosing generation. Needs the dev server on :5173 with seeded recipes,
# restarted after migration 002. All are free. Pass test names to run a subset
# (still with their prep). Leaves local.db reset.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=WeCooked.xcodeproj
SCHEME=WeCooked
SIM="${SIM:-platform=iOS Simulator,name=iPhone 17e}"
TESTS=(
	testRowDeckRendersThreeCards
	testPickLandsOnTheReviewForm
	testGenerateScreen
)

prep() { node server/scripts/unit9-prep.mjs "$@"; }
trap 'prep reset >/dev/null' EXIT

selected=("$@")
[ ${#selected[@]} -eq 0 ] && selected=("${TESTS[@]}")

xcodegen generate
xcodebuild build-for-testing -project "$PROJECT" -scheme "$SCHEME" -destination "$SIM" | tail -20

failed=()
for test in "${selected[@]}"; do
	echo "== $test"
	if prep choosing && TEST_RUNNER_WC_SCREENSHOT_DIR="$PWD/docs/port/screenshots" \
		xcodebuild test-without-building -project "$PROJECT" -scheme "$SCHEME" -destination "$SIM" \
		-only-testing:"WeCookedUITests/Unit9Tests/$test" | tail -40; then
		echo "== $test passed"
	else
		failed+=("$test")
	fi
done

if [ ${#failed[@]} -gt 0 ]; then
	echo "Failed: ${failed[*]}" >&2
	exit 1
fi
