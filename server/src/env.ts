// Every variable the server reads (SvelteKit 3: only declared ones reach
// $app/env/private). All are private, read when the app starts, and optional:
// a dev server runs without R2, Brave or the push key, and each reader keeps
// its own default or "off" path. Fly secrets and fly.toml [env] set them in
// production; server/.env in dev.
import { defineEnvVars } from '@sveltejs/kit/env';

const optional = { schema: (value: string | undefined) => value };

export const variables = defineEnvVars({
	ANTHROPIC_API_KEY: optional,
	APNS_KEY: optional,
	APNS_KEY_ID: optional,
	APNS_TEAM_ID: optional,
	APP_PASSWORD_HASH: optional,
	BRAVE_SEARCH_API_KEY: optional,
	CLAUDE_EFFORT: optional,
	CLAUDE_MODEL: optional,
	COVER_MODEL: optional,
	DAILY_CALL_CAP: optional,
	DATABASE_PATH: optional,
	IMAGE_STORE: optional,
	IMAGE_STORE_DIR: optional,
	IMAGE_STORE_ORIGIN: optional,
	MIGRATIONS_DIR: optional,
	R2_ACCESS_KEY_ID: optional,
	R2_ACCOUNT_ID: optional,
	R2_BUCKET: optional,
	R2_SECRET_ACCESS_KEY: optional,
	SESSION_SECRET: optional
});
