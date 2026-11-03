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
			fetch: { _, _ in
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

	/// A poller whose server holds each request for the whole wait it was
	/// given (the long-poll timing out) unless `script` answers with a change.
	static func heldPoller(
		script: @escaping @Sendable (Int) -> (JobPoll, held: Bool)
	) -> (JobPoller, Recorder, OSAllocatedUnfairLock<[Duration]>) {
		let sleeps = Recorder()
		let waits = OSAllocatedUnfairLock<[Duration]>(initialState: [])
		let p = JobPoller(
			fetch: { _, wait in
				let n = waits.withLock { $0.append(wait); return $0.count }
				let (poll, held) = script(n)
				if held { sleeps.clock.withLock { $0 = $0.advanced(by: wait) } }
				return poll
			},
			sleep: { d in sleeps.sleep(d) },
			now: { sleeps.now })
		return (p, sleeps, waits)
	}

	@Test func asksTheServerToHoldEachRequestAndNeverSleeps() async throws {
		let (p, sleeps, waits) = Self.heldPoller { n in (Self.poll(n < 4 ? .running : .done, ref: "v2"), n > 1 && n < 4) }
		#expect(try await p.wait(for: "j") == .done(resultRef: "v2"))
		#expect(waits.withLock { $0 } == Array(repeating: PollSchedule.longPoll, count: 4))
		#expect(sleeps.log.withLock { $0 }.isEmpty, "a held reply or a changed status is re-asked at once")
	}

	@Test func aStatusChangeIsReAskedAtOnce() async throws {
		let statuses: [JobStatus] = [.queued, .running, .done]
		let (p, sleeps, waits) = Self.heldPoller { n in (Self.poll(statuses[n - 1]), false) }
		#expect(try await p.wait(for: "j") == .done(resultRef: nil))
		#expect(waits.withLock { $0.count } == 3)
		#expect(sleeps.log.withLock { $0 }.isEmpty)
	}

	@Test func heldRequestsGiveUpAtFiveMinutesAndNeverWaitPastIt() async throws {
		let (p, sleeps, waits) = Self.heldPoller { _ in (Self.poll(.running), true) }
		#expect(try await p.wait(for: "j") == .timedOut)
		let w = waits.withLock { $0 }
		#expect(w.reduce(Duration.zero, +) == PollSchedule.timeout)
		#expect(w.allSatisfy { $0 <= PollSchedule.longPoll })
		#expect(w.count == 12)
		#expect(sleeps.log.withLock { $0 }.isEmpty)
	}

	@Test func theLastWaitIsTrimmedToTheTimeLeft() async throws {
		let sleeps = Recorder()
		let waits = OSAllocatedUnfairLock<[Duration]>(initialState: [])
		let p = JobPoller(
			fetch: { _, wait in
				let first = waits.withLock { $0.append(wait); return $0.count == 1 }
				// The first request is held for 290 s of wall clock (a phone asleep).
				sleeps.clock.withLock { $0 = $0.advanced(by: first ? .seconds(290) : wait) }
				return Self.poll(.running)
			},
			sleep: { d in sleeps.sleep(d) },
			now: { sleeps.now })
		#expect(try await p.wait(for: "j") == .timedOut)
		#expect(waits.withLock { $0 } == [PollSchedule.longPoll, .seconds(10)])
	}

	/// An older server answers at once without holding: the old schedule.
	@Test func aServerThatAnswersAtOnceIsPolledOnTheOldSchedule() async throws {
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
		#expect(sleeps.log.withLock { $0.count } == 1, "the first queued is a change; the unheld repeat sleeps")
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
			fetch: { _, _ in Self.poll(.running) },
			sleep: { _ in sleeps.clock.withLock { $0 = $0.advanced(by: .seconds(3600)) } },
			now: { sleeps.now })
		#expect(try await p.wait(for: "j") == .timedOut, "one sleep that spanned an hour of wall clock ends the wait")
	}

	@Test func unauthorizedEndsTheWait() async {
		let (p, _) = Self.poller { _ in throw APIError.unauthorized }
		await #expect(throws: APIError.unauthorized) { try await p.wait(for: "j") }
	}
}
