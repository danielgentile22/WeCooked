# We Cooked

A private recipe book for two people, at [wecooked.kitchen](https://wecooked.kitchen).

Everything about what this is and how it is built lives in the docs:

- [PRODUCT.md](./PRODUCT.md): what and why
- [docs/SPEC.md](./docs/SPEC.md): the build contract
- [docs/DECISIONS.md](./docs/DECISIONS.md): the ADRs
- [docs/UI.md](./docs/UI.md): UI decisions

## Development

```sh
cp .env.example .env   # fill in the two secrets
npm install
npm run dev
```

`npm test` runs the unit tests, `npm run check` typechecks, `fly deploy` ships.
