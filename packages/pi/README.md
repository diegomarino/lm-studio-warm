# pi-lm-studio-warm

`pi-lm-studio-warm` is a [`pi`](https://github.com/earendil-works/pi) extension that makes LM Studio
usage deterministic by warming target models before each `lm-studio` streaming request.

It is opt-in: if no config file exists, it does nothing and `pi` keeps its built-in `lm-studio`
behavior.

![Quick start: opt in with a config file, LM Studio starts cold, the first pi prompt warms the model before the stream leaves — with a visible working message — and lms ps shows the model resident with no TTL](../../docs/quickstart-pi.gif)

<sup>Scripted demo (`scripts/generate-quickstart-cast.py`) — the working message and gate log wording
are the extension's real strings, confirmed visible in a live session; the ~78 s cold load it
compresses is the one actually measured there.</sup>

## What it does

For every stream request routed through provider `lm-studio`, the plugin:

1. Waits for `createWarmGate` (from `lm-studio-warm-core`) to ensure the model is already resident.
2. If warm is confirmed, delegates to the normal completion stream.
3. If warm is ambiguous (policy-dependent), it can fail-open and let the request proceed.
4. If warm is a confirmed hard failure (policy-dependent), it emits a terminal error event.

It also registers a native `lm-studio` provider (via `@earendil-works/pi-ai`'s `createProvider`) and
eagerly warms the current model in the background on session start when `eager` is enabled.

This removes in-flight cold-load latency spikes and makes memory-pressure behavior explicit
(`evictOnPressure`).

## Install

> **Not published yet.** There is currently no GitHub release or npm package; install from a local
> checkout.

```bash
# from a local checkout of the monorepo:
# install workspace deps first — the extension imports lm-studio-warm-core
bun install
pi --extension /path/to/packages/pi/src/index.ts
```

## Activate

Create one of:

- `~/.pi/agent/lm-studio-warm.yml`
- `~/.pi/agent/lm-studio-warm.yaml`
- `~/.pi/agent/lm-studio-warm.json`

Its **presence** activates the plugin.

- Missing config: plugin inactive (safe no-op).
- `enabled: false`: explicit kill-switch. `enabled` must be the **literal boolean** `true` or
  `false` — YAML 1.2 reads `no`/`off`/`yes`/`on` and quoted values as strings, and rather than
  guessing, the plugin **deactivates with a visible diagnostic** on any non-boolean value or
  unparseable file.
- A config that exists but cannot be read or parsed also deactivates the plugin, with a warning in
  the session UI and the log.

Config directory resolution: the plugin reads `~/.pi/agent/` by default (`getAgentDir()` from
`@earendil-works/pi-coding-agent`). If `PI_CODING_AGENT_DIR` is set (the host's session-storage
override), the plugin reads `lm-studio-warm.{yml,yaml,json}` from that directory instead.

Example:

```bash
cat > ~/.pi/agent/lm-studio-warm.yml <<'YAML'
enabled: true
eager: true
failMode: hybrid
YAML
```

`examples/lm-studio-warm.yml` has a fuller template.

## Environment variables

- `LM_STUDIO_BASE_URL`: used **only** when the config `baseURL` is still the default; an explicit
  `baseURL` in the config file wins.
- `LM_STUDIO_API_KEY`: used both during model discovery (`/models`) **and** as the provider
  `apiKey` sent as a Bearer token on every completion stream — set it when your LM Studio server
  requires a token.

## Configuration

See [`packages/core/README.md`](../core/README.md#configuration-reference) for the canonical,
shared option reference — every `WarmOptions` key, its default, and its tier (identity vs. tuning)
— plus the full lock/staleness semantics. This package uses those options unchanged, with
`pi`-shaped defaults: `providers: ['lm-studio']` and `logFile: ~/.cache/pi/lm-studio-warm.log`.

### Model snapshot refresh limitation

`pi` has no `fetchDynamicModels` hook — this package registers its provider with a baseline
`models` snapshot taken at startup, then refreshes it via `refreshModels()` on each request. `pi-ai`
merges that refresh as an overlay on top of the baseline snapshot rather than replacing it, so:

- Models **added or updated** in LM Studio propagate on the next `refreshModels()` call (i.e. the
  next request) — no restart needed.
- Models **removed** from LM Studio do **not** disappear from the provider's model list until the
  `pi` session restarts, because the baseline snapshot entry is never pruned mid-session. Warming a
  removed model will still fail (the gate cannot make a nonexistent model resident); it just stays
  listed as an option until restart.

## Fail mode behavior

- `open`: never block requests based on warm result.
- `closed`: any warm failure fails the request.
- `hybrid` *(default)*: confirmed failures fail requests; ambiguous failures fail-open and continue.

After a confirmed failure the verdict is cached for `retryCooldownMs`
(default 60 s): requests during that window are answered from the cache and
say so explicitly (`cached failure from Ns ago — no new probe`). To retry
sooner, wait out the cooldown or restart the session.

## Troubleshooting

Every failure message points at the log (default
`~/.cache/pi/lm-studio-warm.log`). The failure vocabulary is core-shared
across all three runtimes — see the canonical symptom → meaning → action table
in the [core README's Troubleshooting section](../core/README.md#troubleshooting).

## Logs / lock paths

- Log: `~/.cache/pi/lm-studio-warm.log`
- Lock: `~/.cache/lm-studio-warm/lock` — **shared across runtimes.** `omp`, `pi` and
  `opencode-lm-studio-warm` sessions all default to this one lock directory, because it guards one
  physical resource: the local LM Studio process.

## Development

```bash
bun install        # bun >= 1.0, run from the repo root
bun run --filter pi-lm-studio-warm check   # typecheck (tsc --noEmit) + tests
```

## Example file

See [`examples/lm-studio-warm.yml`](./examples/lm-studio-warm.yml).

## Peer dependency scope

Built/tested with:

- `@earendil-works/pi-ai` `0.83.0`
- `@earendil-works/pi-coding-agent` `0.83.0`

## License

MIT. See [LICENSE](./LICENSE).

## Project documentation

- Monorepo design spec: [`../../docs/superpowers/specs/2026-08-11-lm-studio-warm-monorepo-design.md`](../../docs/superpowers/specs/2026-08-11-lm-studio-warm-monorepo-design.md)
