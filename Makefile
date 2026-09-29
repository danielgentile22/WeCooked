# One command per check a reviewer reruns. `make ios-build` and `make ios-test`
# generate the project first, so a clean checkout works.

SIM ?= platform=iOS Simulator,name=iPhone 17e
PROJECT = WeCooked.xcodeproj
SCHEME = WeCooked

.PHONY: ios-generate ios-build ios-test ios-ui-test ios-ui-test-unit5 ios-ui-test-unit6 kit-test server-test

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

kit-test:
	cd WeCookedKit && swift test

server-test:
	cd server && npm test
