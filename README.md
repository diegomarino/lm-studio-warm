# lm-studio-warm

A bun-workspaces monorepo for deterministic LM Studio model pre-warming across
coding-agent integrations. Every package warms a target model — makes sure
it's already loaded and addressable in LM Studio — before it lets a
completion request leave, instead of paying an in-flight cold-load latency
spike or racing a "no model loaded" error.

![Quick start: opt in with a config file, LM Studio starts cold, the first request warms the model before it leaves, and lms ps shows the model resident with no TTL](docs/assets/quickstart-omp.gif)

<sup>Scripted demo using the `omp` package — the status/log
lines are the plugins' real strings; the cold-load wait is shortened.</sup>

## Packages

| Package | npm name | What it wires into |
| --- | --- | --- |
| [`packages/core`](packages/core) | `lm-studio-warm-core` | Runtime-agnostic core: cross-process lock, eviction planning, `lms` CLI client, model discovery, two-tier config loading. Not user-facing on its own. |
| [`packages/omp`](packages/omp) | `omp-lm-studio-warm` | [`omp`](https://github.com/can1357/oh-my-pi) extension — warms LM Studio models before every `lm-studio` completion stream. |
| [`packages/pi`](packages/pi) | `pi-lm-studio-warm` | [`pi`](https://github.com/earendil-works/pi) extension — same gate, wired as a native `lm-studio` provider. |
| [`packages/opencode`](packages/opencode) | `opencode-lmstudio-warm` | [opencode](https://opencode.ai) plugin — gates every request via the `chat.params` hook; heals mid-session TTL evictions. |

All four packages share the same
`WarmOptions` config shape and the same cross-process lock at
`~/.cache/lm-studio-warm/lock` — see
[`packages/core/README.md`](packages/core/README.md) for the canonical
configuration reference and lock semantics. Each wiring package's own README
covers its install steps, config file location, and runtime-specific
behavior.

## Repo map

```
lm-studio-warm/
├── package.json                      # private workspace root; no publishable code
├── tsconfig.base.json · bunfig.toml
├── release-please-config.json · .release-please-manifest.json
├── .github/workflows/                # ci.yml (per-package matrix), release-please.yml, publish.yml
├── docs/assets/                      # demo assets — quickstart-<runtime>.{cast,gif}
└── packages/
    ├── core/              → npm lm-studio-warm-core
    ├── omp/               → npm omp-lm-studio-warm
    ├── pi/                → npm pi-lm-studio-warm
    └── opencode/          → npm opencode-lmstudio-warm
```

## Development

```bash
bun install
bun run check      # typecheck + test, fanned out to every package
bun run typecheck
bun run test
```

CI (`.github/workflows/ci.yml`) runs a per-package check matrix plus a
`bun audit` job.

See `packages/*/README.md` for package-specific documentation.

## Releases

Versioning is automated with [release-please](https://github.com/googleapis/release-please)
in manifest mode, one component per package. Conventional commits drive
per-package version bumps; no one edits a version number by hand.

Naming note: the opencode package keeps its historical npm spelling
(`opencode-lmstudio-warm`, no hyphen in "lmstudio") — npm rejects new names
that differ from an existing package only in punctuation, so the rename to
match its siblings is not possible on the registry.

## License

MIT. See [LICENSE](LICENSE).
