import SwiftUI
import WeCookedKit

/// D2. One password field, one button, autofocus. `.password` content type so
/// the system password manager and Face ID fill it.
struct LoginScreen: View {
	@Environment(AppEnvironment.self) private var env
	@State private var password = ""
	@State private var error: String?
	@State private var isSubmitting = false
	@FocusState private var isFocused: Bool

	private var canSubmit: Bool { !password.isEmpty && !isSubmitting }

	var body: some View {
		VStack(alignment: .leading, spacing: 20) {
			Text("We Cooked")
				.font(.largeTitle.bold())
				.accessibilityAddTraits(.isHeader)

			SecureField("Password", text: $password)
				.textContentType(.password)
				.submitLabel(.go)
				.focused($isFocused)
				.onSubmit(submit)
				.padding(.horizontal, 14)
				.padding(.vertical, 12)
				.background(.fill.tertiary, in: .rect(cornerRadius: 12))

			if let error { Banner(kind: .error, text: error) }

			Button(action: submit) {
				Group {
					if isSubmitting {
						ProgressView().accessibilityLabel("Signing in")
					} else {
						Text("Sign in")
					}
				}
				.frame(maxWidth: .infinity)
			}
			.prominentButton()
			.controlSize(.large)
			.disabled(!canSubmit)
		}
		.padding(.horizontal, 24)
		.frame(maxWidth: 440)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.onAppear {
			#if DEBUG
			// `-wc-password <pw>` and `-wc-autologin YES` on the launch arguments
			// land in the argument domain; the simulator has no way to type.
			if password.isEmpty, let pw = UserDefaults.standard.string(forKey: "wc-password") {
				password = pw
				if UserDefaults.standard.bool(forKey: "wc-autologin") { submit() }
			}
			#endif
			isFocused = true
		}
	}

	private func submit() {
		guard canSubmit else { return }
		Task { await signIn() }
	}

	private func signIn() async {
		isSubmitting = true
		defer { isSubmitting = false }
		do {
			try await env.logIn(password: password)
			error = nil
		} catch let e as APIError {
			error = Self.copy(for: e)
		} catch {
			self.error = "Could not sign in. Try again."
		}
	}

	private static func copy(for error: APIError) -> String {
		switch error {
		case .rateLimited(let m): m.isEmpty ? "Too many attempts. Wait 15 minutes and try again." : m
		case .rejected(let m): m.isEmpty ? "Wrong password." : m
		default: error.message
		}
	}
}
