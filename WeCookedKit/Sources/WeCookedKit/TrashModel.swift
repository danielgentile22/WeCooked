import Foundation
import Observation

/// The Trash screen (D8). Its own state is the one result slot the web's
/// `form` holds after a restore: restored, displaced (ADR-025), or failed.
@MainActor @Observable
public final class TrashModel {
	public enum Notice: Equatable, Sendable { case restored, displaced, failed(String) }

	public var resource: Resource<TrashResponse> { env.store.resource(.trash) }
	public private(set) var notice: Notice?

	@ObservationIgnored private let env: AppEnvironment

	public init(env: AppEnvironment) { self.env = env }

	public func restore(recipe id: RecipeID) async {
		await run { try await env.api.restoreRecipe(id) }
	}

	public func restore(variation id: VariationID) async {
		await run { try await env.api.restoreVariation(id) }
	}

	/// `restored()` reaches Browse's recipe lists; the explicit revalidate is
	/// for this screen, since `Store.invalidate` refetches only watched
	/// resources and joining an in-flight fetch keeps it to one request.
	private func run(_ work: () async throws -> RestoreReply) async {
		notice = nil
		do {
			let reply = try await work()
			notice = reply.displaced ? .displaced : .restored
			env.store.restored()
			await resource.revalidate()
		} catch {
			notice = .failed(APIError.wrapping(error).message)
		}
	}
}
