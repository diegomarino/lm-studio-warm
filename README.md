# lm-studio-warm

A bun-workspaces monorepo for deterministic LM Studio model pre-warming across
coding-agent integrations.

## Packages

- [`packages/omp`](packages/omp/README.md) — `omp` extension: warms LM Studio
  models before every `lm-studio` completion stream.

## Development

```bash
bun install
bun run check      # typecheck + test, fanned out to every package
bun run typecheck
bun run test
```

See `packages/*/README.md` for package-specific documentation.

> This root README is a stub; it will be expanded with full monorepo
> documentation in a later task.
