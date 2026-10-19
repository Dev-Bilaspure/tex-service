# Contributing

Issues and pull requests are welcome.

```sh
pnpm install
pnpm typecheck
pnpm test          # needs TeX Live (latexmk) and poppler on this machine; tests that need TeX skip without it
pnpm docker:test   # builds the image and runs the tests inside it (no local TeX needed)
```

Node 24 runs the TypeScript sources directly, so there's no build step while developing (`pnpm start` runs
the service from `src/`). `pnpm build` compiles to `dist/` for the npm package.

Keep the HTTP API backward compatible within a major version, add a test for what you change, and add a line
to [CHANGELOG.md](CHANGELOG.md). To update TeX Live, change the digest in the Dockerfile and check that
existing documents still build the same (pages and text).
