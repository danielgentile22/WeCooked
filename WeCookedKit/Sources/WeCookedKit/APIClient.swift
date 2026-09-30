import Foundation

/// Every failure a screen can see. `{"error": string}` bodies become
/// `.rejected` (400, fit to show), `.notFound`, `.rateLimited` or `.server`;
/// 401 is `.unauthorized` after the client has already logged out.
public enum APIError: Error, Sendable, Hashable {
	case unauthorized
	case rejected(String)
	case notFound(String)
	case rateLimited(String)
	case tooLarge
	case server(status: Int, message: String)
	case transport(URLError.Code)
	case malformedReply(String)

	/// Copy for a banner. Plain and concrete (PRODUCT voice).
	public var message: String {
		switch self {
		case .unauthorized: "You have been signed out. Sign in again."
		case .rejected(let m), .notFound(let m), .rateLimited(let m): m
		case .tooLarge: "That photo is too large to upload."
		case .server: "Something went wrong on the server. Try again in a minute."
		case .transport: "Could not reach the server. Check the connection and try again."
		case .malformedReply: "The server sent something the app could not read. Update the app."
		}
	}

	/// True for failures worth retrying without asking the person.
	public var isTransient: Bool {
		switch self {
		case .transport, .server: true
		default: false
		}
	}

	static func wrapping(_ error: any Error) -> APIError {
		if let e = error as? APIError { return e }
		if let e = error as? URLError { return .transport(e.code) }
		return .malformedReply(String(describing: error))
	}
}

/// The only type that speaks HTTP. A value: the base URL, the token store, a
/// `URLSession`, and what to do on 401. Copy it freely; it is `Sendable`.
///
/// `baseURL` ends in `/api/v1/`. Paths below are relative to it.
public struct APIClient: Sendable {
	public let baseURL: URL
	private let tokens: any TokenStore
	private let session: URLSession
	private let onUnauthorized: @Sendable () -> Void

	public init(
		baseURL: URL, tokens: any TokenStore, session: URLSession = .shared,
		onUnauthorized: @escaping @Sendable () -> Void = {}
	) {
		self.baseURL = baseURL
		self.tokens = tokens
		self.session = session
		self.onUnauthorized = onUnauthorized
	}

	enum Body {
		case none
		case json(Data)
		case jpeg(Data)
	}

	private static let decoder = Wire.makeDecoder()
	private static let encoder = Wire.makeEncoder()

	/// The single request path. Everything below is a one-line caller.
	///  - adds `Authorization: Bearer` when a token exists;
	///  - stores `X-Session-Token` from any reply that carries one;
	///  - 401: clears the token, calls `onUnauthorized`, throws `.unauthorized`;
	///  - other non-2xx: decodes `{error}` into a typed `APIError`;
	///  - URLError becomes `.transport`, decoding failure `.malformedReply`.
	func send<Reply: Decodable & Sendable>(
		_ method: String, _ path: String, query: [URLQueryItem] = [], body: Body = .none
	) async throws -> Reply {
		var url = baseURL.appending(path: path)
		if !query.isEmpty { url.append(queryItems: query) }
		var request = URLRequest(url: url)
		request.httpMethod = method
		if let token = tokens.read() {
			request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		}
		switch body {
		case .none: break
		case .json(let d):
			request.httpBody = d
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		case .jpeg(let d):
			request.httpBody = d
			request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
		}
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await session.data(for: request)
		} catch {
			throw APIError.wrapping(error)
		}
		guard let http = response as? HTTPURLResponse else {
			throw APIError.malformedReply("not an HTTP response")
		}
		if let fresh = http.value(forHTTPHeaderField: "X-Session-Token") { tokens.write(fresh) }
		guard (200..<300).contains(http.statusCode) else {
			let message = (try? Self.decoder.decode(ErrorBody.self, from: data))?.error ?? ""
			switch http.statusCode {
			case 401:
				tokens.clear()
				onUnauthorized()
				throw APIError.unauthorized
			case 400: throw APIError.rejected(message)
			case 404: throw APIError.notFound(message)
			case 413: throw APIError.tooLarge
			case 429: throw APIError.rateLimited(message)
			default: throw APIError.server(status: http.statusCode, message: message)
			}
		}
		do {
			return try Self.decoder.decode(Reply.self, from: data)
		} catch {
			throw APIError.malformedReply(String(describing: error))
		}
	}

	func json<T: Encodable>(_ value: T) throws -> Body {
		.json(try Self.encoder.encode(value))
	}
}

extension APIClient {
	private struct Fields: Encodable, Sendable {
		var password: String?
		var text: String?
		var toCount: Double?
		var ticked: Bool?
		var variationId: VariationID?
		var picks: [BuildPick]?
		var index: Int?
	}
	private struct Payload: Encodable { var payload: RecipeInput; var variationId: VariationID? }

	public func login(password: String) async throws {
		let r: TokenReply = try await send("POST", "login", body: json(Fields(password: password)))
		tokens.write(r.token)
	}
	public func session() async throws { let _: OK = try await send("GET", "session") }
	public func tags() async throws -> Vocabulary { try await send("GET", "tags") }

	public func recipes(_ filters: BrowseFilters) async throws -> BrowseResponse {
		try await send("GET", "recipes", query: filters.queryItems)
	}
	public func recipe(_ id: RecipeID, variation: VariationID?) async throws -> RecipeResponse {
		let q = variation.map { [URLQueryItem(name: "v", value: $0.raw)] } ?? []
		return try await send("GET", "recipes/\(id)", query: q)
	}
	public func createRecipe(_ input: RecipeInput) async throws -> RecipeID {
		let r: CreatedRecipe = try await send("POST", "recipes", body: json(input))
		return r.id
	}
	public func updateRecipe(_ id: RecipeID, _ input: RecipeInput, variation: VariationID?)
		async throws -> UpdatedRecipe
	{
		try await send("PUT", "recipes/\(id)", body: json(Payload(payload: input, variationId: variation)))
	}
	public func deleteRecipe(_ id: RecipeID) async throws {
		let _: OK = try await send("DELETE", "recipes/\(id)")
	}
	public func calculate(_ id: RecipeID, toCount: Double) async throws -> CalculateReply {
		try await send("POST", "recipes/\(id)/calculate", body: json(Fields(toCount: toCount)))
	}
	public func retryReconvert(_ id: RecipeID, variation: VariationID?) async throws {
		let _: OK = try await send("POST", "recipes/\(id)/retry-reconvert", body: json(Fields(variationId: variation)))
	}

	public func retryScale(_ id: VariationID) async throws -> JobID {
		let r: JobReply = try await send("POST", "variations/\(id)/retry-scale"); return r.jobId
	}
	public func recalculate(_ id: VariationID) async throws -> JobID {
		let r: JobReply = try await send("POST", "variations/\(id)/recalculate"); return r.jobId
	}
	public func keepMine(_ id: VariationID) async throws {
		let _: OK = try await send("POST", "variations/\(id)/keep-mine")
	}
	public func deleteVariation(_ id: VariationID) async throws {
		let _: OK = try await send("DELETE", "variations/\(id)")
	}

	public func capture(_ request: CaptureRequest) async throws -> JobID {
		let r: JobReply = try await send("POST", "captures", body: json(request)); return r.jobId
	}
	public func draft(_ id: JobID) async throws -> DraftLookup { try await send("GET", "drafts/\(id)") }
	public func saveDraft(_ id: JobID, _ input: RecipeInput) async throws -> RecipeID {
		let r: SavedDraft = try await send("POST", "drafts/\(id)/save", body: json(input)); return r.recipeId
	}
	public func discardDraft(_ id: JobID) async throws {
		let _: OK = try await send("POST", "drafts/\(id)/discard")
	}
	public func retryDraft(_ id: JobID) async throws {
		let _: OK = try await send("POST", "drafts/\(id)/retry")
	}

	public func generate(_ request: GenerateRequest) async throws -> JobID {
		let r: JobReply = try await send("POST", "generations", body: json(request)); return r.jobId
	}
	/// Picking the same index twice is fine; a different one is refused.
	public func pick(_ job: JobID, index: Int) async throws {
		let _: OK = try await send("POST", "drafts/\(job)/pick", body: json(Fields(index: index)))
	}

	public func shopping() async throws -> ShoppingResponse { try await send("GET", "shopping") }
	public func buildShopping(_ picks: [BuildPick]) async throws -> JobID {
		let r: JobReply = try await send("POST", "shopping/build", body: json(Fields(picks: picks))); return r.jobId
	}
	public func retryShopping() async throws -> JobID {
		let r: JobReply = try await send("POST", "shopping/retry"); return r.jobId
	}
	public func addManualLine(_ text: String) async throws {
		let _: OK = try await send("POST", "shopping/manual", body: json(Fields(text: text)))
	}
	public func doneShopping() async throws { let _: OK = try await send("POST", "shopping/done") }
	/// Idempotent by construction: it sets a state, it does not toggle.
	public func setTicked(_ id: ShoppingItemID, _ ticked: Bool) async throws {
		let _: OK = try await send("PATCH", "shopping/items/\(id)", body: json(Fields(ticked: ticked)))
	}

	public func trash() async throws -> TrashResponse { try await send("GET", "trash") }
	public func restoreRecipe(_ id: RecipeID) async throws -> RestoreReply {
		try await send("POST", "trash/recipes/\(id)/restore")
	}
	public func restoreVariation(_ id: VariationID) async throws -> RestoreReply {
		try await send("POST", "trash/variations/\(id)/restore")
	}

	public func job(_ id: JobID) async throws -> JobPoll { try await send("GET", "jobs/\(id)") }

	public enum ImageRole: String, Sendable { case photo, capture }
	/// Raw JPEG bytes, no multipart. The caller has already downsized to a
	/// 3000 px long edge at quality 0.9 (`ImageEncoder` in the app target).
	public func uploadImage(_ jpeg: Data, role: ImageRole) async throws -> UploadedImage {
		try await send("POST", "images", query: [.init(name: "role", value: role.rawValue)], body: .jpeg(jpeg))
	}
}
