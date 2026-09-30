#!/usr/bin/env bash
# Runs the unit 6 UI tests one at a time, each after the prep that forges its
# shopping list. Needs the dev server on :5173 with seeded recipes. The free
# tests spend nothing; WC_CLAUDE=1 adds the gated ones, which spend up to four
# Claude calls. Pass test names to run a subset (still with their prep).
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=WeCooked.xcodeproj
SCHEME=WeCooked
SIM="${SIM:-platform=iOS Simulator,name=iPhone 17e}"
FREE=(
	testRows54To56ListSectionsAndHeader
	testRow57TickSyncsBothWays
	testRow58PickMode
	testRow59BuildingBannerAndSkeletons
	testRow60RebuildNoticeShownOnce
	testRow61FailedBuildShowsRetry
	testRow62AddManualLine
	testRow63DoneShoppingAsksThenClears
	testRow64EmptyState
	testRow76ShareDisabledOnEmptyList
)
GATED=(
	testRow59BuildCompletes
	testRow60RebuildKeepsAndResets
	testRow61RetryAfterFailure
)

prep() { node server/scripts/unit6-prep.mjs "$@"; }

prep_for() {
	case "$1" in
	testRows54To56ListSectionsAndHeader | testRow57TickSyncsBothWays | testRow58PickMode | \
		testRow62AddManualLine | testRow63DoneShoppingAsksThenClears) prep forge-list ;;
	testRow59BuildingBannerAndSkeletons) prep stuck-build ;;
	testRow60RebuildNoticeShownOnce) prep rebuild-result ;;
	testRow61FailedBuildShowsRetry | testRow61RetryAfterFailure) prep fail-build ;;
	testRow64EmptyState | testRow76ShareDisabledOnEmptyList | testRow59BuildCompletes | testRow60RebuildKeepsAndResets) prep clear ;;
	*) echo "Unknown test: $1" >&2 && return 1 ;;
	esac
}

selected=("$@")
if [ ${#selected[@]} -eq 0 ]; then
	selected=("${FREE[@]}")
	[ "${WC_CLAUDE:-}" = 1 ] && selected+=("${GATED[@]}")
fi

xcodegen generate
xcodebuild build-for-testing -project "$PROJECT" -scheme "$SCHEME" -destination "$SIM" | tail -20

failed=()
for test in "${selected[@]}"; do
	echo "== $test"
	if prep_for "$test" && TEST_RUNNER_WC_CLAUDE="${WC_CLAUDE:-}" TEST_RUNNER_WC_SCREENSHOT_DIR="$PWD/docs/port/screenshots" \
		xcodebuild test-without-building -project "$PROJECT" -scheme "$SCHEME" -destination "$SIM" \
		-only-testing:"WeCookedUITests/Unit6Tests/$test" | tail -40; then
		echo "== $test passed"
	else
		failed+=("$test")
	fi
done

if [ ${#failed[@]} -gt 0 ]; then
	echo "Failed: ${failed[*]}" >&2
	exit 1
fi
