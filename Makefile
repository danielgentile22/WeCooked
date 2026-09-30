# One command per check a reviewer reruns. `make ios-build` and `make ios-test`
# generate the project first, so a clean checkout works.

SIM_NAME ?= iPhone 17e
SIM ?= platform=iOS Simulator,name=$(SIM_NAME)
PROJECT = WeCooked.xcodeproj
SCHEME = WeCooked

.PHONY: ios-generate ios-build ios-test ios-ui-test ios-ui-test-unit5 ios-ui-test-unit6 ios-ui-test-unit7 ios-ui-test-unit8 kit-test server-test

ios-generate:
	xcodegen generate

ios-build: ios-generate
	xcodebuild build -project $(PROJECT) -scheme $(SCHEME) -destination '$(SIM)' | tail -20

# The package tests on the simulator. The UI tests need a seeded server, so
# they are their own target below.
ios-test: ios-generate
	set -o pipefail; xcodebuild test -project $(PROJECT) -scheme $(SCHEME) -destination '$(SIM)' \
		-skip-testing:WeCookedUITests | tail -20

# Needs the dev server on :5173 with seeded recipes. Screenshots land in
# docs/port/screenshots: xcodebuild passes TEST_RUNNER_-prefixed variables from
# its own environment (not build settings) to the runner, prefix stripped.
ios-ui-test: ios-generate
	set -o pipefail; TEST_RUNNER_WC_SCREENSHOT_DIR=$(CURDIR)/docs/port/screenshots \
		xcodebuild test -project $(PROJECT) -scheme $(SCHEME) -destination '$(SIM)' \
		-only-testing:WeCookedUITests | tail -40

# Unit 5's variation tests, each after its forged server state: spends up to 5 Claude calls.
ios-ui-test-unit5: ios-generate
	SIM='$(SIM)' WeCookedUITests/run-unit5.sh

# Free by default; WC_CLAUDE=1 make ios-ui-test-unit6 adds the tests that spend Claude calls.
ios-ui-test-unit6: ios-generate
	SIM='$(SIM)' WeCookedUITests/run-unit6.sh

# Free; each test runs after unit7-prep.mjs forges its trash state.
ios-ui-test-unit7: ios-generate
	SIM='$(SIM)' WeCookedUITests/run-unit7.sh

# Free and needs no prep. Runs twice, the simulator switched to light and then
# to dark, because iOS apps follow the phone and ignore launch arguments for it.
unit8 = TEST_RUNNER_WC_SCREENSHOT_DIR=$(CURDIR)/docs/port/screenshots \
	xcodebuild test -project $(PROJECT) -scheme $(SCHEME) -destination '$(SIM)' $(1) 2>&1 \
	| grep -E "Test Case|error:|XCTAssert|Executed|\*\* TEST" | tail -60

ios-ui-test-unit8: ios-generate
	xcrun simctl bootstatus '$(SIM_NAME)' -b >/dev/null
	xcrun simctl ui '$(SIM_NAME)' appearance light
	set -o pipefail; $(call unit8,-only-testing:WeCookedUITests/Unit8Tests -skip-testing:WeCookedUITests/Unit8Tests/testRow69Dark)
	xcrun simctl ui '$(SIM_NAME)' appearance dark
	set -o pipefail; TEST_RUNNER_WC_APPEARANCE=dark $(call unit8,-only-testing:WeCookedUITests/Unit8Tests/testRow69Dark); \
		status=$$?; xcrun simctl ui '$(SIM_NAME)' appearance light; exit $$status

kit-test:
	cd WeCookedKit && swift test

server-test:
	cd server && npm test
