import Foundation
import os
import Testing

@testable import WeCookedKit

/// A fake clock: `sleep` records the duration and advances `now`, so 300 s of
/// schedule run in microseconds and the wall-clock timeout is still exercised.
final class Recorder: Sendable {
	let log = OSAllocatedUnfairLock<[Duration]>(initialState: [])
	let clock = OSAllocatedUnfairLock(initialState: ContinuousClock.now)
	func sleep(_ d: Duration) {
		log.withLock { $0.append(d) }
		clock.withLock { $0 = $0.advanced(by: d) }
	}
	var now: ContinuousClock.Instant { clock.withLock { $0 } }
}

struct JobPollerTests {
	/// A poller whose `fetch` replays a script and whose `sleep` only records.
	static func poller(
		script: @escaping @Sendable (Int) throws -> JobPoll
	) -> (JobPoller, Recorder) {
		let sleeps = Recorder()
		let calls = OSAllocatedUnfairLock(initialState: 0)
		let p = JobPoller(
			fetch: { _ in
				let n = calls.withLock { $0 += 1; return $0 }
				return try script(n)
			},
			sleep: { d in sleeps.sleep(d) },
			now: { sleeps.now })
		return (p, sleeps)
	}

	static func poll(_ s: JobStatus, ref: String? = nil) -> JobPoll {
		JobPoll(status: s, errorCode: nil, errorText: nil, resultRef: ref)
	}

	@Test func cadenceIsOnePointFiveThenFiveThenGivesUp() async throws {
		let (p, sleeps) = Self.poller { _ in Self.poll(.running) }
		let outcome = try await p.wait(for: "j")
		#expect(outcome == .timedOut)
		let s = sleeps.log.withLock { $0 }
		#expect(s.prefix(20).allSatisfy { $0 == .milliseconds(1500) })
		#expect(s.dropFirst(20).allSatisfy { $0 == .seconds(5) })
		#expect(s.count == 20 + 54)
		#expect(s.reduce(Duration.zero, +) == .seconds(300))
	}

	@Test func returnsTheResultRefWhenDone() async throws {
		let (p, sleeps) = Self.poller { n in n < 3 ? Self.poll(.queued) : Self.poll(.done, ref: "v2") }
		#expect(try await p.wait(for: "j") == .done(resultRef: "v2"))
		#expect(sleeps.log.withLock { $0.count } == 2)
	}

	@Test func failureCarriesTheServersCopy() async throws {
		let (p, _) = Self.poller { _ in
			JobPoll(status: .failed, errorCode: .fetchBlocked, errorText: "blocked", resultRef: nil)
		}
		#expect(try await p.wait(for: "j") == .failed(code: .fetchBlocked, text: "blocked"))
	}

	@Test func unknownStatusKeepsWaiting() async throws {
		let (p, _) = Self.poller { n in n < 3 ? Self.poll(.unknown("paused")) : Self.poll(.done) }
		#expect(try await p.wait(for: "j") == .done(resultRef: nil))
	}

	@Test func aDroppedConnectionIsRetriedButNotForever() async throws {
		let (p, _) = Self.poller { n in
			if n <= 2 { throw APIError.transport(.notConnectedToInternet) }
			return Self.poll(.done)
		}
		#expect(try await p.wait(for: "j") == .done(resultRef: nil))
		let (q, _) = Self.poller { _ in throw APIError.transport(.notConnectedToInternet) }
		await #expect(throws: APIError.self) { try await q.wait(for: "j") }
	}

	@Test func timeoutCountsWallClockNotSleeps() async throws {
		let sleeps = Recorder()
		let p = JobPoller(
			fetch: { _ in Self.poll(.running) },
			sleep: { _ in sleeps.clock.withLock { $0 = $0.advanced(by: .seconds(3600)) } },
			now: { sleeps.now })
		#expect(try await p.wait(for: "j") == .timedOut, "one sleep that spanned an hour of wall clock ends the wait")
	}

	@Test func unauthorizedEndsTheWait() async {
		let (p, _) = Self.poller { _ in throw APIError.unauthorized }
		await #expect(throws: APIError.unauthorized) { try await p.wait(for: "j") }
	}
}
