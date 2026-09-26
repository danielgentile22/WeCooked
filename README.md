# We Cooked

A recipe book for a two-person household, running at
[wecooked.kitchen](https://wecooked.kitchen). The live site sits behind a
shared password; it is not a public service. The code is here for anyone
curious about how it is built.

## What it does

- **Capture a recipe three ways:** paste a URL, photograph cookbook pages
  (up to 8 at once), or paste text. Claude extracts it into a structured
  draft, and a person confirms it before it is saved.
- **Variations:** scale a recipe to a different yield and keep the result as
  its own variation next to the original.
- **US and metric:** every recipe is stored in both, with a toggle
  remembered per device. Hand edits are reconverted in the background.
- **Shared shopping list:** pick recipes, build a merged list, and tick items
  off from either phone.
- **Cooking screen:** keeps the phone awake, lets you strike through steps
  and ingredients, and installs to the home screen as a PWA.
- **Trash:** deletes are soft and can always be restored.

## Stack

SvelteKit (Svelte 5, TypeScript) on one Node process, SQLite on a Fly.io
volume replicated to Cloudflare R2 with Litestream, photos in R2, and the
Claude API for extraction, scaling, and unit conversion.

## Docs

- [PRODUCT.md](./PRODUCT.md): what and why
- [CONTEXT.md](./CONTEXT.md): the glossary
- [docs/SPEC.md](./docs/SPEC.md): the build contract
- [docs/DECISIONS.md](./docs/DECISIONS.md): the architecture decision records
- [docs/UI.md](./docs/UI.md): UI decisions
- [docs/RUNBOOK.md](./docs/RUNBOOK.md): backup and restore

## Development

```sh
npm install
cp .env.example .env
npm run dev
```

In `.env`, local development needs:

- `APP_PASSWORD_HASH`: an Argon2id hash of the login password. Vite expands
  `$` in `.env` values, so the dollar signs must be escaped. This prints a
  ready-to-paste line:

  ```sh
  node -e "require('@node-rs/argon2').hash(process.argv[1]).then(h => console.log('APP_PASSWORD_HASH=' + h.replaceAll('\$', '\\\\\$')))" 'your-password'
  ```

- `SESSION_SECRET`: any long random string, for example from
  `openssl rand -hex 32`.
- `ANTHROPIC_API_KEY`: needed for capture, scaling, and conversion.
- The `R2_*` values: needed only for photos.

The `LITESTREAM_*` values are only used in production.

`npm test` runs the unit tests, `npm run check` typechecks, and `fly deploy`
ships.

## License

[MIT](./LICENSE)
