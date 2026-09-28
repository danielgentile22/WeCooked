import Foundation

// One piece of code waits for background work. Calculate, capture, stale
// refresh, reconvert and shopping build are all jobs the server reports inside
// an ordinary reply (`calcJob`, `refresh`, `reconvert`, a draft card's status,
// `build`). The Store reads those replies, starts one wait per listed job
// (`Store.reconcileWatchers`) and refetches the reply when the wait ends. No
// screen holds a job id and no job id is persisted on the phone: a relaunch
// re-reads the cached reply and the wait resumes from there.

/// 1.5 s for the first 30 s, then 5 s, then give up after 5 minutes.
public enum PollSchedule {
	public static let fast: Duration = .milliseconds(1500)
	public static let slow: Duration = .seconds(5)
	public static let fastWindow: Duration = .seconds(30)
	public static let timeout: Duration = .seconds(300)

	/// How long to sleep after `elapsed` of waiting, or nil once the budget is
	/// spent. `elapsed` is wall clock since the wait began, so a phone that
	/// slept for an hour times the job out on its next poll; `Store.resume`
	/// then starts a fresh wait from the fresh reply.
	public static func delay(afterElapsed elapsed: Duration) -> Duration? {
		if elapsed >= timeout { return nil }
		return elapsed < fastWindow ? fast : slow
	}
}

public enum JobOutcome: Sendable, Hashable {
	/// `resultRef` per kind: new variation id (scale), list id (shopping
	/// merge), nil (captures: re-read the draft).
	case done(resultRef: String?)
	case failed(code: ErrorCode?, text: String)
	case timedOut

	public static let timedOutText = "Still working after 5 minutes. Try again in a bit."

	/// Banner copy for the two unhappy outcomes.
	public var failureText: String? {
		switch self {
		case .done: nil
		case .failed(_, let text): text
		case .timedOut: Self.timedOutText
		}
	}
}

public struct JobPoller: Sendable {
	public typealias Instant = ContinuousClock.Instant

	private let fetch: @Sendable (JobID) async throws -> JobPoll
	private let sleep: @Sendable (Duration) async throws -> Void
	private let now: @Sendable () -> Instant

	public init(api: APIClient) {
		fetch = { try await api.job($0) }
		sleep = { try await Task.sleep(for: $0) }
		now = { ContinuousClock.now }
	}

	/// Seam for tests: a scripted `fetch`, a `sleep` that records instead of
	/// waiting, and a `now` the fake sleep advances.
	public init(
		fetch: @escaping @Sendable (JobID) async throws -> JobPoll,
		sleep: @escaping @Sendable (Duration) async throws -> Void,
		now: @escaping @Sendable () -> Instant
	) {
		self.fetch = fetch
		self.sleep = sleep
		self.now = now
	}

	/// Poll until the job finishes or the schedule runs out. Cancellation (the
	/// reply stopped listing the job, or sign-out) throws `CancellationError`;
	/// the job itself keeps running on the server. A dropped connection is
	/// retried on the schedule (up to three in a row) instead of failing the
	/// wait, because a phone walking between rooms is normal; every other API
	/// error, including 401, ends it.
	public func wait(for id: JobID) async throws -> JobOutcome {
		let start = now()
		var dropped = 0
		while true {
			do {
				let poll = try await fetch(id)
				dropped = 0
				switch poll.status {
				case .done: return .done(resultRef: poll.resultRef)
				case .failed:
					return .failed(code: poll.errorCode, text: poll.errorText ?? "That did not finish. Try again.")
				case .timeout: return .timedOut
				case .queued, .running, .unknown: break
				}
			} catch let e as APIError where e.isTransient {
				dropped += 1
				if dropped > 3 { throw e }
			}
			guard let next = PollSchedule.delay(afterElapsed: start.duration(to: now())) else {
				return .timedOut
			}
			try await sleep(next)
		}
	}
}

/// A reply that can name unfinished jobs. The Store keeps one wait per job
/// listed by any loaded resource, so "what is being polled" is a projection of
/// cached server truth, never separate client state.
public protocol WatchesJobs {
	var watchedJobs: [JobID] { get }
}

extension RecipeResponse: WatchesJobs {
	/// Calculate, stale refresh and reconvert, while pending.
	public var watchedJobs: [JobID] {
		var ids: [JobID] = []
		if let c = calcJob, c.status == .pending { ids.append(c.jobId) }
		if let r = refresh, r.status == .pending, let j = r.jobId { ids.append(j) }
		if let r = recipe.reconvert, r.status == .pending, let j = r.jobId { ids.append(j) }
		return ids
	}
}

extension BrowseResponse: WatchesJobs {
	/// Extracting drafts; a draft is addressed by its capture job.
	public var watchedJobs: [JobID] { drafts.filter { $0.status == .extracting }.map(\.id) }
}

extension DraftLookup: WatchesJobs {
	public var watchedJobs: [JobID] {
		if case .draft(let d) = self, !d.status.isFinished { [d.id] } else { [] }
	}
}

extension ShoppingResponse: WatchesJobs {
	public var watchedJobs: [JobID] {
		if let b = list.build, b.status == .pending { [b.jobId] } else { [] }
	}
}
