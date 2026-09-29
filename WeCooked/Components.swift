import SwiftUI
import UIKit
import WeCookedKit

// The shared vocabulary of the UI (D5, D6): one Banner, one Chip, one image
// view, one way to keep a Resource fresh while a screen is visible.

/// D6. Icon, text, optional action. Meaning is never colour alone: every kind
/// has its own symbol and the text says what happened.
struct Banner: View {
	enum Kind { case info, working, warning, error, success
		var symbol: String {
			switch self {
			case .info: "info.circle"
			case .working: "arrow.triangle.2.circlepath"
			case .warning: "exclamationmark.triangle"
			case .error: "xmark.octagon"
			case .success: "checkmark.circle"
			}
		}
	}
	let kind: Kind
	let text: String
	var actionTitle: String?
	var action: (() -> Void)?

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: 10) {
			HStack(alignment: .firstTextBaseline, spacing: 10) {
				Image(systemName: kind.symbol).foregroundStyle(.secondary)
				Text(text).frame(maxWidth: .infinity, alignment: .leading)
			}
			.accessibilityElement(children: .combine)
			if let actionTitle, let action {
				Button(actionTitle, action: action)
					.fontWeight(.semibold)
					.foregroundStyle(.tint)
			}
		}
		.font(.subheadline)
		.padding(.horizontal, 14)
		.padding(.vertical, 12)
		.background(.thinMaterial, in: .rect(cornerRadius: 12))
	}
}

/// D5. One chip app-wide. Selected is filled plus a checkmark, never a colour
/// shift alone. `quiet` is the read-only tag on a list row.
struct Chip: View {
	enum Style { case standard, quiet }
	let title: String
	var systemImage: String?
	var isSelected = false
	var style = Style.standard

	var body: some View {
		HStack(spacing: 4) {
			if isSelected {
				Image(systemName: "checkmark").fontWeight(.bold)
			} else if let systemImage {
				Image(systemName: systemImage)
			}
			Text(title)
		}
		.lineLimit(1)
		.modifier(ChipShape(style: style, isSelected: isSelected))
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(title)
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}
}

private struct ChipShape: ViewModifier {
	let style: Chip.Style
	let isSelected: Bool

	func body(content: Content) -> some View {
		switch (style, isSelected) {
		case (.quiet, _):
			content
				.font(.caption.weight(.medium))
				.foregroundStyle(.secondary)
				.padding(.horizontal, 8)
				.padding(.vertical, 3)
				.background(.fill.tertiary, in: .capsule)
		case (.standard, true):
			content
				.font(.subheadline.weight(.semibold))
				.foregroundStyle(Color.onAccent)
				.padding(.horizontal, 12)
				.padding(.vertical, 6)
				.background(.tint, in: .capsule)
		case (.standard, false):
			content
				.font(.subheadline)
				.padding(.horizontal, 12)
				.padding(.vertical, 6)
				.overlay(Capsule().strokeBorder(.separator, lineWidth: 1))
		}
	}
}

extension Color {
	/// D4: text on an accent fill. White in light mode, near-black in dark.
	static let onAccent = Color(UIColor { traits in
		traits.userInterfaceStyle == .dark ? UIColor(red: 0x2a / 255, green: 0x1a / 255, blue: 0, alpha: 1) : .white
	})
}

/// D17. The one tile every coverless recipe shows: neutral surface, the pot
/// glyph, never a per-recipe colour.
struct CoverFallback: View {
	var body: some View {
		Rectangle()
			.fill(Color(.secondarySystemBackground))
			.overlay {
				Image(systemName: "frying.pan")
					.font(.title3)
					.foregroundStyle(.secondary)
			}
			.accessibilityHidden(true)
	}
}

/// Cover and photo images: decoded memory cache, then `ImageStore` (memory,
/// disk by URL path, network). Shows the D17 tile while and if there is
/// nothing. The caller sets the frame and clip shape.
struct CachedImage: View {
	let url: URL?
	@Environment(AppEnvironment.self) private var env
	@State private var loaded: UIImage?

	/// Decoded images keyed by `ImageStore.key(for:)`, so a row scrolling back
	/// into view does not decode again. NSCache evicts under memory pressure.
	@MainActor private static let decoded = NSCache<NSString, UIImage>()

	var body: some View {
		let image = loaded ?? url.flatMap { Self.decoded.object(forKey: ImageStore.key(for: $0) as NSString) }
		Group {
			if let image {
				Image(uiImage: image).resizable().scaledToFill()
			} else {
				CoverFallback()
			}
		}
		.task(id: url) { await load() }
	}

	private func load() async {
		guard let url else { loaded = nil; return }
		let key = ImageStore.key(for: url) as NSString
		if let hit = Self.decoded.object(forKey: key) { loaded = hit; return }
		loaded = nil
		guard let data = await env.images.data(for: url), let raw = UIImage(data: data) else { return }
		let ready = await raw.byPreparingForDisplay() ?? raw
		Self.decoded.setObject(ready, forKey: key)
		if !Task.isCancelled { loaded = ready }
	}
}

/// Chips wrap left to right, as on the web. Rows break at the proposed width.
struct Flow: Layout {
	var spacing: CGFloat = 8

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		let width = proposal.width ?? subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
		return CGSize(width: width, height: rows(in: width, subviews: subviews).height)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		for (index, origin) in rows(in: bounds.width, subviews: subviews).origins.enumerated() {
			subviews[index].place(
				at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y),
				proposal: .unspecified)
		}
	}

	private func rows(in width: CGFloat, subviews: Subviews) -> (origins: [CGPoint], height: CGFloat) {
		var origins: [CGPoint] = []
		var x: CGFloat = 0
		var y: CGFloat = 0
		var rowHeight: CGFloat = 0
		for view in subviews {
			let size = view.sizeThatFits(.unspecified)
			if x > 0 && x + size.width > width {
				x = 0
				y += rowHeight + spacing
				rowHeight = 0
			}
			origins.append(CGPoint(x: x, y: y))
			x += size.width + spacing
			rowHeight = max(rowHeight, size.height)
		}
		return (origins, y + rowHeight)
	}
}

/// Shown by every screen whose unit has not been built, instead of trapping.
struct NotBuiltYet: View {
	var body: some View { ContentUnavailableView("Not built yet", systemImage: "hammer") }
}

extension View {
	/// Keep `resource` fresh while this view is on screen. Uses appear and
	/// disappear rather than `.task`, because a NavigationStack keeps the root
	/// view alive under a pushed one, and a `.task` there would neither stop nor
	/// restart on return. Also refetches when the app comes back to the front.
	func watching<V: Codable & Sendable>(
		_ resource: Resource<V>, every interval: Duration? = nil
	) -> some View {
		modifier(WatchModifier(resource: resource, interval: interval))
	}

	/// Cooking-screen wake lock. Reference-counted in one place so an editor
	/// pushed on top does not release it early.
	func keepsScreenAwake() -> some View { modifier(ScreenAwakeModifier()) }
}

private struct ScreenAwakeModifier: ViewModifier {
	@MainActor private static var holders = 0

	func body(content: Content) -> some View {
		content
			.onAppear {
				Self.holders += 1
				UIApplication.shared.isIdleTimerDisabled = true
			}
			.onDisappear {
				Self.holders = max(0, Self.holders - 1)
				UIApplication.shared.isIdleTimerDisabled = Self.holders > 0
			}
	}
}

struct WatchModifier<V: Codable & Sendable>: ViewModifier {
	let resource: Resource<V>
	let interval: Duration?
	@State private var task: Task<Void, Never>?
	@Environment(\.scenePhase) private var phase

	func body(content: Content) -> some View {
		content
			.onAppear { start() }
			.onDisappear { task?.cancel(); task = nil }
			.onChange(of: phase) { _, new in
				if new == .active { start() } else { task?.cancel(); task = nil }
			}
	}

	private func start() {
		task?.cancel()
		task = Task { await resource.watch(every: interval) }
	}
}

/// The three states every data screen has, in one place so no screen invents a
/// fourth: content (cached or fresh) renders immediately; a skeleton only when
/// nothing was ever seen; an error only when there is nothing to show.
struct Loaded<V: Codable & Sendable, Content: View>: View {
	let resource: Resource<V>
	@ViewBuilder var content: (V) -> Content
	var body: some View {
		if let value = resource.value {
			content(value)
		} else if resource.isFirstLoad {
			ProgressView().accessibilityLabel("Loading")
		} else if case .failed(let e) = resource.phase {
			Banner(kind: .error, text: e.message, actionTitle: "Try again") { Task { await resource.revalidate() } }
		}
	}
}
