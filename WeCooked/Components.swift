import PhotosUI
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
		.sensoryFeedback(.selection, trigger: isSelected)
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

extension View {
	/// D4: the accent-filled button. The system draws its label white and its
	/// icon in the tint, which vanishes on the fill and fails contrast on the
	/// dark-mode accent, so the label takes `onAccent` while enabled.
	func prominentButton() -> some View { modifier(ProminentButton()) }
}

private struct ProminentButton: ViewModifier {
	@Environment(\.isEnabled) private var isEnabled

	func body(content: Content) -> some View {
		content
			.buttonStyle(.borderedProminent)
			.foregroundStyle(isEnabled ? AnyShapeStyle(Color.onAccent) : AnyShapeStyle(.secondary))
	}
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
/// nothing. The caller sets the frame and clip shape; the image decodes just
/// big enough to fill that frame (issue #73), so a list of row tiles holds
/// small bitmaps, not one 1200px display copy each.
struct CachedImage: View {
	let url: URL?
	@Environment(AppEnvironment.self) private var env
	@Environment(\.displayScale) private var scale
	@State private var loaded: (key: String, image: UIImage)?

	/// Decoded bitmaps keyed by `ImageDecode.key`: the stored object at one
	/// frame size, so a row scrolling back into view does not decode again and
	/// a strip photo and a row tile of the same image do not collide. Each
	/// entry costs its bitmap bytes; past the limit NSCache evicts, as it does
	/// under memory pressure.
	@MainActor private static let decoded: NSCache<NSString, UIImage> = {
		let cache = NSCache<NSString, UIImage>()
		cache.totalCostLimit = 64 * 1024 * 1024
		return cache
	}()

	var body: some View {
		GeometryReader { geo in
			let pixels = ImageDecode.pixels(geo.size, scale: scale)
			// Zero on a first layout pass: wait for the real frame before loading.
			let key = geo.size.width > 0 && geo.size.height > 0 ? url.map { ImageDecode.key($0, pixels: pixels) } : nil
			let image = key.flatMap { k in loaded?.key == k ? loaded?.image : Self.decoded.object(forKey: k as NSString) }
			Group {
				if let image {
					Image(uiImage: image).resizable().scaledToFill()
				} else {
					CoverFallback()
				}
			}
			.frame(width: geo.size.width, height: geo.size.height)
			.task(id: key) { await load(key: key, pixels: pixels) }
		}
	}

	private func load(key: String?, pixels: CGSize) async {
		guard let url, let key else { return }
		if let hit = Self.decoded.object(forKey: key as NSString) { loaded = (key, hit); return }
		guard let data = await env.images.data(for: url) else { return }
		let decoded = await Task.detached(priority: .userInitiated) {
			ImageDecode.image(data, toFill: pixels)
		}.value
		guard let decoded, !Task.isCancelled else { return }
		let image = UIImage(cgImage: decoded)
		Self.decoded.setObject(image, forKey: key as NSString, cost: ImageDecode.cost(of: decoded))
		loaded = (key, image)
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
	func watching<V: Codable & Sendable & Equatable>(
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

struct WatchModifier<V: Codable & Sendable & Equatable>: ViewModifier {
	let resource: Resource<V>
	let interval: Duration?
	@State private var task: Task<Void, Never>?
	@Environment(\.scenePhase) private var phase

	func body(content: Content) -> some View {
		content
			.onAppear { start() }
			.onDisappear { task?.cancel(); task = nil }
			// A chip tap hands the cooking screen another variation's resource;
			// its cached reply shows at once, and the watch moves to it.
			.onChange(of: ObjectIdentifier(resource)) { start() }
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
/// `placeholder` stands in while a never-seen value loads, so a new search
/// keeps the last results on screen instead of flashing a spinner.
struct Loaded<V: Codable & Sendable & Equatable, Content: View>: View {
	let resource: Resource<V>
	var placeholder: V? = nil
	@ViewBuilder var content: (V) -> Content
	var body: some View {
		if let value = resource.value {
			content(value)
		} else if resource.isFirstLoad, let placeholder {
			content(placeholder)
		} else if resource.isFirstLoad {
			ProgressView().accessibilityLabel("Loading")
		} else if case .failed(let e) = resource.phase {
			Banner(kind: .error, text: e.message, actionTitle: "Try again") { Task { await resource.revalidate() } }
		}
	}
}

/// One button that adds photos from the library, or the camera when the phone
/// has one. Every image goes through `JPEG.normalise` (orientation applied,
/// long edge 3000 px, quality 0.9) before `onJPEG`, in the order picked.
struct PhotoSources<Label: View>: View {
	/// How many more may be added; nil is no limit.
	var remaining: Int?
	let identifier: String
	let onJPEG: (Data) async -> Void
	@ViewBuilder var label: () -> Label

	@State private var choosingSource = false
	@State private var libraryOpen = false
	@State private var cameraOpen = false
	@State private var picked: [PhotosPickerItem] = []
	@State private var unreadable = false

	private static var hasCamera: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Button {
				if Self.hasCamera { choosingSource = true } else { libraryOpen = true }
			} label: {
				label()
			}
			.disabled(remaining.map { $0 <= 0 } ?? false)
			.accessibilityIdentifier(identifier)
			if unreadable {
				Banner(kind: .error, text: "Could not read that photo.")
			}
		}
		.confirmationDialog("Add photos", isPresented: $choosingSource) {
			Button("Take photo") { cameraOpen = true }
			Button("Choose from library") { libraryOpen = true }
		}
		.photosPicker(
			isPresented: $libraryOpen, selection: $picked, maxSelectionCount: remaining ?? 0,
			selectionBehavior: .ordered, matching: .images)
		.onChange(of: picked) { _, items in
			guard !items.isEmpty else { return }
			picked = []
			Task {
				for item in items {
					await accept(try? await item.loadTransferable(type: Data.self))
				}
			}
		}
		.fullScreenCover(isPresented: $cameraOpen) {
			CameraPicker { data in Task { await accept(data) } }
				.ignoresSafeArea()
		}
	}

	private func accept(_ raw: Data?) async {
		guard let raw else { unreadable = true; return }
		// ImageIO decoding a 48 MP photo takes long enough to hitch the main thread.
		let jpeg = await Task.detached(priority: .userInitiated) { try? JPEG.normalise(raw) }.value
		guard let jpeg else { unreadable = true; return }
		unreadable = false
		await onJPEG(jpeg)
	}
}

/// The system camera. Hands back the shot as JPEG; `JPEG.normalise` applies the
/// orientation the camera wrote into it.
private struct CameraPicker: UIViewControllerRepresentable {
	let onShot: (Data) -> Void
	@Environment(\.dismiss) private var dismiss

	func makeUIViewController(context: Context) -> UIImagePickerController {
		let picker = UIImagePickerController()
		picker.sourceType = .camera
		picker.delegate = context.coordinator
		return picker
	}

	func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	@MainActor final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
		let parent: CameraPicker
		init(_ parent: CameraPicker) { self.parent = parent }

		func imagePickerController(
			_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
		) {
			if let data = (info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 1) { parent.onShot(data) }
			parent.dismiss()
		}

		func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
	}
}

extension View {
	/// A full-width list row with no cell chrome, for banners and headings.
	func bare() -> some View {
		listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
			.listRowBackground(Color.clear)
			.listRowSeparator(.hidden)
	}
}
