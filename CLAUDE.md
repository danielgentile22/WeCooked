# We Cooked

- **The iOS app is the product.** The SvelteKit web app in `server/` is retired. `server/` is now the backend (`/api/v1`, jobs, storage) and an archive of the old web app. Don't change or extend the web pages to match iOS work; change `server/` only for backend behavior.
