#!/usr/bin/env bash
# Runs the unit 7 UI tests one at a time, each after the prep that forges its
# Trash. Needs the dev server on :5173 with seeded recipes. All are free. Pass
# test names to run a subset (still with their prep). Leaves local.db reset.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=WeCooked.xcodeproj
SCHEME=WeCooked
SIM="${SIM:-platform=iOS Simulator,name=iPhone 17e}"
TESTS=(
	testRow65TwoGroupsAndRows
	testRow66RestoreRecipeShowsRestored
	testRow66RestoreVariationDisplaces
	testRow67RestoreErrorShown
)

prep() { node server/scripts/unit7-prep.mjs "$@"; }
trap 'prep reset >/dev/null' EXIT

prep_for() {
	case "$1" in
	testRow65TwoGroupsAndRows | testRow66RestoreRecipeShowsRestored | testRow66RestoreVariationDisplaces) prep reset ;;
	testRow67RestoreErrorShown) prep forge-clash ;;
	*) echo "Unknown test: $1" >&2 && return 1 ;;
	esac
}

selected=("$@")
[ ${#selected[@]} -eq 0 ] && selected=("${TESTS[@]}")

xcodegen generate
xcodebuild build-for-testing -project "$PROJECT" -scheme "$SCHEME" -destination "$SIM" | tail -20

failed=()
for test in "${selected[@]}"; do
	echo "== $test"
	if prep_for "$test" && TEST_RUNNER_WC_SCREENSHOT_DIR="$PWD/docs/port/screenshots" \
		xcodebuild test-without-building -project "$PROJECT" -scheme "$SCHEME" -destination "$SIM" \
		-only-testing:"WeCookedUITests/Unit7Tests/$test" | tail -40; then
		echo "== $test passed"
	else
		failed+=("$test")
	fi
done

if [ ${#failed[@]} -gt 0 ]; then
	echo "Failed: ${failed[*]}" >&2
	exit 1
fi
