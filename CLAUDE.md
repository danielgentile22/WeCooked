# We Cooked

- **Two clients, one backend.** The iOS app (`WeCooked/`, `WeCookedKit/`) is the phone client. The SvelteKit web app in `server/` is the laptop client, used propped on the kitchen counter while cooking, and `server/` is also the backend (`/api/v1`, jobs, storage). A behaviour added to one client is added to the other unless it is platform-bound (share extension, widget, push). `docs/PARITY.md` is the matrix: update its row in the same change as the feature, and when a side is platform-bound say so in the row. `/parity-audit` regenerates the gap table.
- **The web app is laptop-first.** Phones use the native app, so web layout decisions favour a 1100 to 1400px content area (docs/UI.md D12). It must still degrade on a phone, but phone polish is not a goal.
