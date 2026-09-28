# Rubric for the iOS shape arena

Score each candidate 0 to 3 per criterion, with a one-line reason citing a file.

1. Instant reopen. Tapping a recipe already seen shows it with no spinner, then refreshes. The trace from tap to pixels must be visible in the types (a cache keyed by recipe id that the screen reads synchronously, then a refresh that updates the same value). "We will add a cache later" scores 0.
2. One job poller. Calculate, capture, stale refresh, reconvert and shopping build all use one piece with the 1.5 s then 5 s cadence and the 5 minute timeout, and a screen can resume polling a job it finds in a server reply after relaunch.
3. Fixture-driven models. Every fixture in WeCookedKit/Tests/Fixtures decodes through the real model types in a test, unknown enum values from the server do not crash decoding, and RecipeInput encodes to exactly the JSON the server validates.
4. Editor payload rule as a pure function with its cases listed (both bodies changed, only other changed, neither, only source changed, counterpart null on source change).
5. Shared state is separated. Per-device state (units, strikes, drafts, seen build) has one owner each, ticks from two phones reconcile at the read boundary without a lock, and Swift 6 strict concurrency holds without @unchecked Sendable or MainActor sprinkled as escape hatches.
6. Reader load. A screen's data path is traceable in at most three files. Fewer files with clear boundaries beat many thin ones. project.yml builds an app, a package, package tests and a share extension placeholder with an app group.
