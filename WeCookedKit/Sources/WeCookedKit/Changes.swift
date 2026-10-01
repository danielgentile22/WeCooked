import Observation

/// What `Observations` does on iOS 26, for iOS 17: the current value of
/// `read`, then the value again after each change to anything it read.
/// Ends when the consuming task is cancelled.
@MainActor
func changes<Value: Sendable>(of read: @escaping @MainActor () -> Value) -> AsyncStream<Value> {
	let (stream, continuation) = AsyncStream.makeStream(of: Value.self, bufferingPolicy: .bufferingNewest(1))
	ChangeTracker(read, continuation).track()
	return stream
}

/// Kept alive by the pending `onChange` alone, so it goes away at the first
/// change after the stream ends.
@MainActor
private final class ChangeTracker<Value: Sendable> {
	private let read: @MainActor () -> Value
	private let continuation: AsyncStream<Value>.Continuation
	private var ended = false

	init(_ read: @escaping @MainActor () -> Value, _ continuation: AsyncStream<Value>.Continuation) {
		self.read = read
		self.continuation = continuation
		continuation.onTermination = { [weak self] _ in
			Task { @MainActor in self?.ended = true }
		}
	}

	func track() {
		guard !ended else { return }
		let value = withObservationTracking(read) {
			Task { @MainActor in self.track() }
		}
		continuation.yield(value)
	}
}
