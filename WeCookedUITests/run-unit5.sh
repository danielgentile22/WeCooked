#!/usr/bin/env bash
# Runs the unit 5 UI tests one at a time, each after the prep that forges its
# server state. Needs the dev server on :5173 with seeded recipes. Spends up to
# five Claude calls. Pass test names to run a subset (still with their prep).
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=WeCooked.xcodeproj
SCHEME=WeCooked
SIM="${SIM:-platform=iOS Simulator,name=iPhone 17e}"
TESTS=(
	testRow20PendingCalculationResumes
	testRow21FailedCalculationRetried
	testRows19And16CalculateThenDeleteVariation
	testRow22StaleUntouchedRefresh
	testRow23KeepMine
	testRow23Recalculate
	testRow25ReconvertBannersAndEditorBanner
)

prep() { node server/scripts/unit5-prep.mjs "$@"; }

prep_for() {
	case "$1" in
	testRow20PendingCalculationResumes) prep reset Shakshuka && prep stuck-scale Shakshuka 6 ;;
	testRow21FailedCalculationRetried) prep reset Shakshuka && prep fail-scale Shakshuka 6 ;;
	testRows19And16CalculateThenDeleteVariation) prep reset "Buttermilk pancakes" ;;
	testRow22StaleUntouchedRefresh) prep stale Shakshuka ;;
	testRow23KeepMine) prep hand-edit Shakshuka 6 && prep stale Shakshuka ;;
	testRow23Recalculate) prep hand-edit Shakshuka 6 && prep stale Shakshuka ;;
	testRow25ReconvertBannersAndEditorBanner) prep reset "Sunday ragù" && prep fail-reconvert "Sunday ragù" ;;
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
	if prep_for "$test" && TEST_RUNNER_WC_CLAUDE=1 TEST_RUNNER_WC_SCREENSHOT_DIR="$PWD/docs/port/screenshots" \
		xcodebuild test-without-building -project "$PROJECT" -scheme "$SCHEME" -destination "$SIM" \
		-only-testing:"WeCookedUITests/Unit5Tests/$test" | tail -40; then
		echo "== $test passed"
	else
		failed+=("$test")
	fi
done

if [ ${#failed[@]} -gt 0 ]; then
	echo "Failed: ${failed[*]}" >&2
	exit 1
fi
