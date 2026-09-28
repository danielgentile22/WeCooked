# One command per check a reviewer reruns. `make ios-build` and `make ios-test`
# generate the project first, so a clean checkout works.

SIM ?= platform=iOS Simulator,name=iPhone 17e
PROJECT = WeCooked.xcodeproj
SCHEME = WeCooked

.PHONY: ios-generate ios-build ios-test kit-test server-test

ios-generate:
	xcodegen generate

ios-build: ios-generate
	xcodebuild build -project $(PROJECT) -scheme $(SCHEME) -destination '$(SIM)' | tail -20

ios-test: ios-generate
	xcodebuild test -project $(PROJECT) -scheme $(SCHEME) -destination '$(SIM)' | tail -20

kit-test:
	cd WeCookedKit && swift test

server-test:
	cd server && npm test
