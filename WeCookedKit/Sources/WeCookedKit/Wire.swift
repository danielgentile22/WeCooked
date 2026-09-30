import Foundation

// Everything the server says or accepts, and nothing else. Plain values: no
// networking, no UI, no state. One file so a reader sees the whole vocabulary
// at once; `FixtureDecodingTests` proves each type against a recorded reply.
//
// Naming rule: the coders use `convertFromSnakeCase` / `convertToSnakeCase`, so
// a property must be the mechanical camelCase of its wire key (`cover_url` is
// `coverUrl`, `job_id` is `jobId`, never `coverURL`). The round-trip test
// fails loudly when someone breaks the rule.

// MARK: - Coders

public enum Wire {
	public static func makeDecoder() -> JSONDecoder {
		let d = JSONDecoder()
		d.keyDecodingStrategy = .convertFromSnakeCase
		d.dateDecodingStrategy = .custom { decoder in
			let raw = try decoder.singleValueContainer().decode(String.self)
			return try Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(raw)
		}
		return d
	}

	public static func makeEncoder() -> JSONEncoder {
		let e = JSONEncoder()
		e.keyEncodingStrategy = .convertToSnakeCase
		e.dateEncodingStrategy = .custom { date, encoder in
			var c = encoder.singleValueContainer()
			try c.encode(date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
		}
		e.outputFormatting = [.sortedKeys]
		return e
	}
}

// MARK: - Identifiers

/// A server identifier that cannot be mixed up with another kind. The phantom
/// `Entity` costs nothing at runtime and turns `open(recipe: variationID)`
/// into a compile error.
public struct ID<Entity>: Hashable, Sendable, Codable, ExpressibleByStringLiteral,
	CustomStringConvertible, Comparable
{
	public let raw: String
	public init(_ raw: String) { self.raw = raw }
	public init(stringLiteral value: String) { self.raw = value }
	public init(from decoder: any Decoder) throws {
		raw = try decoder.singleValueContainer().decode(String.self)
	}
	public func encode(to encoder: any Encoder) throws {
		var c = encoder.singleValueContainer()
		try c.encode(raw)
	}
	public var description: String { raw }
	public static func < (a: Self, b: Self) -> Bool { a.raw < b.raw }
}

public enum RecipeTag {}
public enum VariationTag {}
public enum JobTag {}
public enum ImageTag {}
public enum ItemTag {}
public enum ListTag {}

public typealias RecipeID = ID<RecipeTag>
public typealias VariationID = ID<VariationTag>
/// A draft is identified by the capture job that produced it. The server
/// returns the same id from `POST /captures`, in `DraftCard.id` and in
/// `DraftView.id`, so there is no separate DraftID.
public typealias JobID = ID<JobTag>
public typealias ImageID = ID<ImageTag>
public typealias ShoppingItemID = ID<ItemTag>
public typealias ListID = ID<ListTag>

// MARK: - Open enums

/// A string-valued server enum that never fails to decode. Unknown values are
/// kept (so they re-encode unchanged) and land in an `unknown`/`other` case
/// that the UI renders as plain text. Each conformer writes one `init(wire:)`
/// switch; Codable comes free.
public protocol WireEnum: Codable, Hashable, Sendable {
	init(wire: String)
	var wire: String { get }
}

extension WireEnum {
	public init(from decoder: any Decoder) throws {
		self.init(wire: try decoder.singleValueContainer().decode(String.self))
	}
	public func encode(to encoder: any Encoder) throws {
		var c = encoder.singleValueContainer()
		try c.encode(wire)
	}
}

/// Effort and damage are exactly-one tags with meaning the UI cares about, so
/// they are real enums with an escape case.
public enum Effort: WireEnum, CaseIterable {
	case quick, weeknight, project
	case unknown(String)

	public static let allCases: [Effort] = [.quick, .weeknight, .project]
	public init(wire: String) {
		self = Self.allCases.first { $0.wire == wire } ?? .unknown(wire)
	}
	public var wire: String {
		switch self {
		case .quick: "quick"
		case .weeknight: "weeknight"
		case .project: "project"
		case .unknown(let s): s
		}
	}
}

public enum Damage: WireEnum, CaseIterable {
	case tidy, messy, carnage
	case unknown(String)

	public static let allCases: [Damage] = [.tidy, .messy, .carnage]
	public init(wire: String) {
		self = Self.allCases.first { $0.wire == wire } ?? .unknown(wire)
	}
	public var wire: String {
		switch self {
		case .tidy: "tidy"
		case .messy: "messy"
		case .carnage: "carnage"
		case .unknown(let s): s
		}
	}
}

/// Meal type, cuisine and protein are large vocabularies the UI never
/// branches on. They are strings with a phantom group, and the picker options
/// come from `Vocabulary` (GET /tags), the server's single source of truth.
public struct Tag<Group>: WireEnum {
	public let wire: String
	public init(wire: String) { self.wire = wire }
	/// "middle-eastern" becomes "Middle Eastern".
	public var title: String {
		wire.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }
			.joined(separator: " ")
	}
}
public enum MealGroup {}
public enum CuisineGroup {}
public enum ProteinGroup {}
public typealias MealType = Tag<MealGroup>
public typealias Cuisine = Tag<CuisineGroup>
public typealias Protein = Tag<ProteinGroup>

public enum Section: WireEnum {
	case produce, meatFish, dairy, dryGoods, spices, frozen, other, staples
	case unknown(String)

	static let known: [Section] = [
		.produce, .meatFish, .dairy, .dryGoods, .spices, .frozen, .other, .staples,
	]
	public init(wire: String) {
		self = Self.known.first { $0.wire == wire } ?? .unknown(wire)
	}
	public var wire: String {
		switch self {
		case .produce: "produce"
		case .meatFish: "meat-fish"
		case .dairy: "dairy"
		case .dryGoods: "dry-goods"
		case .spices: "spices"
		case .frozen: "frozen"
		case .other: "other"
		case .staples: "staples"
		case .unknown(let s): s
		}
	}
}

public enum JobStatus: WireEnum {
	case queued, running, done, failed, timeout
	case unknown(String)

	public init(wire: String) {
		switch wire {
		case "queued": self = .queued
		case "running": self = .running
		case "done": self = .done
		case "failed": self = .failed
		case "timeout": self = .timeout
		default: self = .unknown(wire)
		}
	}
	public var wire: String {
		switch self {
		case .queued: "queued"
		case .running: "running"
		case .done: "done"
		case .failed: "failed"
		case .timeout: "timeout"
		case .unknown(let s): s
		}
	}
	/// A status this build does not know is treated as "still going": the poll
	/// loop keeps waiting and its five minute cap ends the wait.
	public var isFinished: Bool {
		switch self {
		case .done, .failed, .timeout: true
		case .queued, .running, .unknown: false
		}
	}
}

public enum ErrorCode: WireEnum {
	case fetchBlocked, fetchFailed, noRecipeFound, imageUnreadable
	case quotaExceeded, apiError, interrupted
	case unknown(String)

	static let known: [ErrorCode] = [
		.fetchBlocked, .fetchFailed, .noRecipeFound, .imageUnreadable, .quotaExceeded,
		.apiError, .interrupted,
	]
	public init(wire: String) {
		self = Self.known.first { $0.wire == wire } ?? .unknown(wire)
	}
	public var wire: String {
		switch self {
		case .fetchBlocked: "fetch_blocked"
		case .fetchFailed: "fetch_failed"
		case .noRecipeFound: "no_recipe_found"
		case .imageUnreadable: "image_unreadable"
		case .quotaExceeded: "quota_exceeded"
		case .apiError: "api_error"
		case .interrupted: "interrupted"
		case .unknown(let s): s
		}
	}
}

/// Status of a draft row on the browse list.
public enum DraftCardStatus: WireEnum {
	case extracting, ready, failed
	case unknown(String)

	public init(wire: String) {
		switch wire {
		case "extracting": self = .extracting
		case "ready": self = .ready
		case "failed": self = .failed
		default: self = .unknown(wire)
		}
	}
	public var wire: String {
		switch self {
		case .extracting: "extracting"
		case .ready: "ready"
		case .failed: "failed"
		case .unknown(let s): s
		}
	}
}

/// Status of a pending piece of background work attached to a recipe or the
/// shopping list (`reconvert`, `refresh`, `calcJob`, `build`).
public enum PendingStatus: WireEnum {
	case pending, failed, done
	case unknown(String)

	public init(wire: String) {
		switch wire {
		case "pending": self = .pending
		case "failed": self = .failed
		case "done": self = .done
		default: self = .unknown(wire)
		}
	}
	public var wire: String {
		switch self {
		case .pending: "pending"
		case .failed: "failed"
		case .done: "done"
		case .unknown(let s): s
		}
	}
}

/// The only two-valued enum. Unknown falls back to metric, the household
/// default, rather than failing a whole recipe over one field.
public enum UnitSystem: String, Codable, Hashable, Sendable, CaseIterable {
	case us, metric

	public init(from decoder: any Decoder) throws {
		let s = try decoder.singleValueContainer().decode(String.self)
		self = UnitSystem(rawValue: s) ?? .metric
	}
	public var other: UnitSystem { self == .us ? .metric : .us }
}

// MARK: - Recipe bodies

public struct IngredientGroup: Codable, Hashable, Sendable {
	public var heading: String?
	public var items: [String]
	public init(heading: String?, items: [String]) {
		self.heading = heading
		self.items = items
	}
}

public struct BodyText: Codable, Hashable, Sendable {
	public var ingredients: [IngredientGroup]
	public var steps: [String]
	public init(ingredients: [IngredientGroup], steps: [String]) {
		self.ingredients = ingredients
		self.steps = steps
	}
}

/// Body of `POST /recipes`, `PUT /recipes/:id` (as `payload`) and
/// `POST /drafts/:id/save`. The server checks `cuisine !== null`, so an absent
/// key is a validation error ("Unknown cuisine."): every optional here encodes
/// as an explicit JSON null. `effort` and `damage` are non-optional because the
/// server rejects a save without them; the editor cannot build a value until
/// both are chosen (see `EditorForm.payload()`).
public struct RecipeInput: Codable, Hashable, Sendable {
	public var title: String
	public var yieldCount: Double
	public var yieldUnit: String
	public var prepMinutes: Int?
	public var cookMinutes: Int?
	public var sourceText: String?
	public var sourceUrl: String?
	public var notes: String?
	public var sourceUnits: UnitSystem
	public var mealTypes: [MealType]
	public var cuisine: Cuisine?
	public var protein: Protein?
	public var effort: Effort
	public var damage: Damage
	public var ingredients: [IngredientGroup]
	public var steps: [String]
	public var counterpart: BodyText?
	public var imageIds: [ImageID]
	public var coverImageId: ImageID?

	public init(
		title: String, yieldCount: Double, yieldUnit: String, prepMinutes: Int?,
		cookMinutes: Int?, sourceText: String?, sourceUrl: String?, notes: String?,
		sourceUnits: UnitSystem, mealTypes: [MealType], cuisine: Cuisine?, protein: Protein?,
		effort: Effort, damage: Damage, ingredients: [IngredientGroup], steps: [String],
		counterpart: BodyText?, imageIds: [ImageID], coverImageId: ImageID?
	) {
		self.title = title
		self.yieldCount = yieldCount
		self.yieldUnit = yieldUnit
		self.prepMinutes = prepMinutes
		self.cookMinutes = cookMinutes
		self.sourceText = sourceText
		self.sourceUrl = sourceUrl
		self.notes = notes
		self.sourceUnits = sourceUnits
		self.mealTypes = mealTypes
		self.cuisine = cuisine
		self.protein = protein
		self.effort = effort
		self.damage = damage
		self.ingredients = ingredients
		self.steps = steps
		self.counterpart = counterpart
		self.imageIds = imageIds
		self.coverImageId = coverImageId
	}

	private enum CodingKeys: String, CodingKey {
		case title, yieldCount, yieldUnit, prepMinutes, cookMinutes, sourceText, sourceUrl
		case notes, sourceUnits, mealTypes, cuisine, protein, effort, damage
		case ingredients, steps, counterpart, imageIds, coverImageId
	}

	public func encode(to encoder: any Encoder) throws {
		var c = encoder.container(keyedBy: CodingKeys.self)
		try c.encode(title, forKey: .title)
		try c.encode(yieldCount, forKey: .yieldCount)
		try c.encode(yieldUnit, forKey: .yieldUnit)
		try c.encode(prepMinutes, forKey: .prepMinutes)
		try c.encode(cookMinutes, forKey: .cookMinutes)
		try c.encode(sourceText, forKey: .sourceText)
		try c.encode(sourceUrl, forKey: .sourceUrl)
		try c.encode(notes, forKey: .notes)
		try c.encode(sourceUnits, forKey: .sourceUnits)
		try c.encode(mealTypes, forKey: .mealTypes)
		try c.encode(cuisine, forKey: .cuisine)
		try c.encode(protein, forKey: .protein)
		try c.encode(effort, forKey: .effort)
		try c.encode(damage, forKey: .damage)
		try c.encode(ingredients, forKey: .ingredients)
		try c.encode(steps, forKey: .steps)
		try c.encode(counterpart, forKey: .counterpart)
		try c.encode(imageIds, forKey: .imageIds)
		try c.encode(coverImageId, forKey: .coverImageId)
	}
	// `Encodable.encode(_:forKey:)` for `Optional` writes null, not nothing; that
	// is the whole point of the hand-written encoder. Decoding is synthesized.
}

// MARK: - Recipe screen

public struct RecipeImage: Codable, Hashable, Sendable {
	public let id: ImageID
	public let url: URL
	public let width: Int
	public let height: Int
}

public struct VariationChip: Codable, Hashable, Sendable, Identifiable {
	public let id: VariationID
	public let yieldCount: Double
	public let isOriginal: Bool
	public let stale: Bool
}

public struct PendingWork: Codable, Hashable, Sendable {
	public let jobId: JobID?
	public let status: PendingStatus
}

public struct Bodies: Codable, Hashable, Sendable {
	public var us: BodyText?
	public var metric: BodyText?
	public subscript(units: UnitSystem) -> BodyText? {
		units == .us ? us : metric
	}
}

/// One variation of one recipe, as `GET /recipes/:id?v=` serves it. The fields
/// `ingredients`/`steps` are the source body; `bodies` holds both units.
public struct RecipeDetail: Codable, Hashable, Sendable, Identifiable {
	public let id: RecipeID
	public let variationId: VariationID
	public var title: String
	public var sourceText: String?
	public var sourceUrl: String?
	public var yieldUnit: String
	public var yieldCount: Double
	public var prepMinutes: Int?
	public var cookMinutes: Int?
	public var notes: String?
	public var sourceUnits: UnitSystem
	public var mealTypes: [MealType]
	public var cuisine: Cuisine?
	public var protein: Protein?
	public var effort: Effort
	public var damage: Damage
	public var ingredients: [IngredientGroup]
	public var steps: [String]
	public var coverImageId: ImageID?
	public var images: [RecipeImage]
	public var handEdited: Bool
	public var isOriginal: Bool
	public var stale: Bool
	public var scalingNote: String?
	/// Ascending yield. The original is always present.
	public var variations: [VariationChip]
	public var bodies: Bodies
	public var reconvert: PendingWork?
	/// Strike keys are positional, so they are only valid for one content
	/// version of one variation. `DeviceState` stores this beside them.
	public let contentVersion: Int
	public let basedOnContentVersion: Int
}

/// `GET /recipes/:id` reply. `refresh` is a stale-variation update the server
/// queued while answering; `calcJob` is an unfinished or recently failed
/// calculate-for-N (server keeps failures visible for 15 minutes).
public struct RecipeResponse: Codable, Hashable, Sendable {
	public var recipe: RecipeDetail
	public var refresh: PendingWork?
	public var calcJob: CalcJob?
}

public struct CalcJob: Codable, Hashable, Sendable {
	public let jobId: JobID
	public let status: PendingStatus
	public let errorText: String?
	public let toCount: Double
}

/// `POST /recipes/:id/calculate`: the server answers with one of two shapes.
public enum CalculateReply: Sendable, Hashable, Decodable {
	case existing(VariationID)
	case job(JobID)

	private enum Keys: String, CodingKey { case variationId, jobId }
	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: Keys.self)
		if let v = try c.decodeIfPresent(VariationID.self, forKey: .variationId) {
			self = .existing(v)
		} else {
			self = .job(try c.decode(JobID.self, forKey: .jobId))
		}
	}
}

// MARK: - Browse

public struct BrowseRow: Codable, Hashable, Sendable, Identifiable {
	public let id: RecipeID
	public var title: String
	public var effort: Effort
	public var damage: Damage
	public var coverUrl: URL?
}

public struct DraftCard: Codable, Hashable, Sendable, Identifiable {
	public let id: JobID
	public var status: DraftCardStatus
	public var title: String
}

public struct BrowseResponse: Codable, Hashable, Sendable {
	public var drafts: [DraftCard]
	public var recipes: [BrowseRow]
}

/// Filters for `GET /recipes`. Multi-valued per group on the web; the same
/// here. `Codable` because it is part of a cache key.
public struct BrowseFilters: Hashable, Sendable, Codable {
	public var q = ""
	public var mealTypes: Set<MealType> = []
	public var cuisines: Set<Cuisine> = []
	public var proteins: Set<Protein> = []
	public var efforts: Set<Effort> = []
	public var damages: Set<Damage> = []
	public init() {}

	/// Stable, sorted query items; also the cache key suffix.
	public var queryItems: [URLQueryItem] {
		var items: [URLQueryItem] = []
		let trimmed = q.trimmingCharacters(in: .whitespacesAndNewlines)
		if !trimmed.isEmpty { items.append(.init(name: "q", value: trimmed)) }
		func add(_ name: String, _ values: [String]) {
			for v in values.sorted() { items.append(.init(name: name, value: v)) }
		}
		add("meal", mealTypes.map(\.wire))
		add("cuisine", cuisines.map(\.wire))
		add("protein", proteins.map(\.wire))
		add("effort", efforts.map(\.wire))
		add("damage", damages.map(\.wire))
		return items
	}
	public var isEmpty: Bool { queryItems.isEmpty }
}

// MARK: - Vocabulary

/// `GET /tags`. The server's vocabulary is authoritative; pickers render what it
/// lists. Cached like everything else, and a bundled copy is not needed because
/// the cache is filled on first login before any picker can open.
public struct Vocabulary: Codable, Hashable, Sendable {
	public var mealTypes: [MealType]
	public var cuisines: [Cuisine]
	public var proteins: [Protein]
	public var efforts: [Effort]
	public var damages: [Damage]
	public var sectionOrder: [Section]
	/// Keyed by the raw error code so unknown codes do not fail decoding.
	public var errorCopy: [String: String]
}

// MARK: - Drafts

public struct DraftImage: Codable, Hashable, Sendable {
	public let id: ImageID
	public let url: URL
}

/// The `initial` block of a draft. On success it carries a full prefill; on a
/// failed capture only `sourceUrl` and `images`. Every prefill field is
/// optional, and `EditorForm.init(seed:)` supplies the defaults.
public struct DraftSeed: Codable, Hashable, Sendable {
	public var sourceUrl: String?
	public var images: [DraftImage]
	public var title: String?
	public var yieldCount: Double?
	public var yieldUnit: String?
	public var prepMinutes: Int?
	public var cookMinutes: Int?
	public var sourceText: String?
	public var notes: String?
	public var sourceUnits: UnitSystem?
	public var mealTypes: [MealType]?
	public var cuisine: Cuisine?
	public var protein: Protein?
	public var effort: Effort?
	public var damage: Damage?
	public var ingredients: [IngredientGroup]?
	public var steps: [String]?
	public var counterpart: BodyText?
}

public struct DraftView: Codable, Hashable, Sendable {
	public let id: JobID
	public var status: JobStatus
	public var errorText: String?
	public var sourceText: String?
	public var initial: DraftSeed?
	public var warnings: [String]
	public var damageReasoning: String?
}

/// `GET /drafts/:id`: a draft, or the recipe it became once saved.
public enum DraftLookup: Codable, Hashable, Sendable {
	case draft(DraftView)
	case saved(RecipeID)

	private enum Keys: String, CodingKey { case recipeId }
	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: Keys.self)
		if let id = try c.decodeIfPresent(RecipeID.self, forKey: .recipeId) {
			self = .saved(id)
		} else {
			self = .draft(try DraftView(from: decoder))
		}
	}
	public func encode(to encoder: any Encoder) throws {
		switch self {
		case .draft(let d): try d.encode(to: encoder)
		case .saved(let id):
			var c = encoder.container(keyedBy: Keys.self)
			try c.encode(id, forKey: .recipeId)
		}
	}
}

// MARK: - Jobs

/// `GET /jobs/:id`. `resultRef` means: new variation id (scale), list id
/// (shopping merge), null (captures; re-read the draft).
public struct JobPoll: Codable, Hashable, Sendable {
	public let status: JobStatus
	public let errorCode: ErrorCode?
	public let errorText: String?
	public let resultRef: String?
}

// MARK: - Shopping

public struct ShoppingItem: Codable, Hashable, Sendable, Identifiable {
	public let id: ShoppingItemID
	public var section: Section
	public var textUs: String
	public var textMetric: String
	public var fromTitles: [String]
	public var isManual: Bool
	public var ticked: Bool
	public var position: Int

	public func text(_ units: UnitSystem) -> String { units == .us ? textUs : textMetric }
}

public struct ShoppingPick: Codable, Hashable, Sendable {
	public let recipeId: RecipeID
	public let title: String
	public var yieldCount: Double
	public let yieldUnit: String
}

public struct BuildResult: Codable, Hashable, Sendable {
	public let kept: Int
	/// `text_metric` of every tick that was lost because its line changed.
	public let reset: [String]
}

public struct ShoppingBuild: Codable, Hashable, Sendable {
	public let jobId: JobID
	public let status: PendingStatus
	public let errorText: String?
	public let result: BuildResult?
}

public struct ShoppingState: Codable, Hashable, Sendable {
	public let listId: ListID
	public var items: [ShoppingItem]
	public var picks: [ShoppingPick]
	public var build: ShoppingBuild?
}

public struct PickableRecipe: Codable, Hashable, Sendable, Identifiable {
	public let id: RecipeID
	public let title: String
	public let yieldCount: Double
	public let yieldUnit: String
}

public struct ShoppingResponse: Codable, Hashable, Sendable {
	public var list: ShoppingState
	public var recipes: [PickableRecipe]
}

/// Body of `POST /shopping/build`.
public struct BuildPick: Codable, Hashable, Sendable {
	public let recipeId: RecipeID
	public let yieldCount: Double
	public init(recipeId: RecipeID, yieldCount: Double) {
		self.recipeId = recipeId
		self.yieldCount = yieldCount
	}
}

// MARK: - Trash

public struct TrashedRecipe: Codable, Hashable, Sendable, Identifiable {
	public let id: RecipeID
	public let title: String
	public let deletedAt: Date
}

public struct TrashedVariation: Codable, Hashable, Sendable, Identifiable {
	public let id: VariationID
	public let title: String
	public let yieldCount: Double
	public let yieldUnit: String
	public let deletedAt: Date
}

public struct Trash: Codable, Hashable, Sendable {
	public var recipes: [TrashedRecipe]
	public var variations: [TrashedVariation]
}

public struct TrashResponse: Codable, Hashable, Sendable {
	public var trash: Trash
}

public struct RestoreReply: Codable, Hashable, Sendable {
	public let restored: Bool
	/// A restored variation displaced a live one with the same yield (ADR-025).
	public let displaced: Bool
}

// MARK: - Small replies

public struct TokenReply: Codable, Sendable { public let token: String }
public struct JobReply: Codable, Sendable { public let jobId: JobID }

/// The body of `POST /captures`. One primary input. With a URL, `html` is the
/// page as the phone rendered it (sites that 403 a bare server fetch still
/// serve Mobile Safari) and `text` is the caption or note; the server falls
/// back to its own fetch, then to `text`, when either is missing.
public enum CaptureRequest: Encodable, Sendable {
	/// The server rejects more pages than this in one capture.
	public static let maxImages = 10

	case url(URL, html: String?, text: String?)
	case text(String)
	case images([ImageID])

	/// The server's own text-or-link rule (`asUrl` in server/src/lib/extract.ts):
	/// a lone `http(s)://` link, or a bare `www.` one upgraded to https.
	public static func link(in text: String) -> URL? {
		if text.wholeMatch(of: /https?:\/\/\S+/) != nil { return URL(string: text) }
		if text.wholeMatch(of: /www\.\S+/) != nil { return URL(string: "https://" + text) }
		return nil
	}

	private enum CodingKeys: String, CodingKey { case url, html, text, imageIds }

	public func encode(to encoder: any Encoder) throws {
		var c = encoder.container(keyedBy: CodingKeys.self)
		switch self {
		case .url(let url, let html, let text):
			try c.encode(url, forKey: .url)
			try c.encodeIfPresent(html, forKey: .html)
			try c.encodeIfPresent(text, forKey: .text)
		case .text(let text): try c.encode(text, forKey: .text)
		case .images(let ids): try c.encode(ids, forKey: .imageIds)
		}
	}
}
public struct CreatedRecipe: Codable, Sendable { public let id: RecipeID }
public struct UpdatedRecipe: Codable, Sendable {
	public let id: RecipeID
	/// Null means the original.
	public let variationId: VariationID?
}
public struct SavedDraft: Codable, Sendable { public let recipeId: RecipeID }
public struct UploadedImage: Codable, Hashable, Sendable {
	public let id: ImageID
	public let url: URL
	public let width: Int
	public let height: Int
}
public struct ErrorBody: Codable, Sendable { public let error: String }
public struct OK: Codable, Sendable { public let ok: Bool }
