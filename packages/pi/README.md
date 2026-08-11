# pi-lm-studio-warm

`pi-lm-studio-warm` is a [`pi`](https://github.com/earendil-works/pi) extension that makes LM Studio
usage deterministic by warming target models before each `lm-studio` streaming request.

It is opt-in: if no config file exists, it does nothing and `pi` keeps its built-in `lm-studio`
behavior.

> **Status:** scaffold only. Config loading and the inactive paths (missing/disabled/invalid config)
> are implemented; provider registration and gated streaming land in a follow-up commit. Until then,
> an active config is acknowledged with a single log line and otherwise left untouched.

## What it does

For every stream request routed through provider `lm-studio`, once fully wired, the plugin will:

1. Wait for `createWarmGate` (from `lm-studio-warm-core`) to ensure the model is already resident.
2. If warm is confirmed, delegate to the normal completion stream.
3. If warm is ambiguous (policy-dependent), it can fail-open and let the request proceed.
4. If warm is a confirmed hard failure (policy-dependent), it emits a terminal error event.

This removes in-flight cold-load latency spikes and makes memory-pressure behavior explicit
(`evictOnPressure`).

## Install

> **Not published yet.** There is currently no GitHub release or npm package; install from a local
> checkout.

```bash
# from a local checkout
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
- `LM_STUDIO_API_KEY`: used both during model discovery (`/models`) **and**, once provider
  registration lands, as the provider `apiKey` sent as a Bearer token on every completion stream.

## Configuration

See [`packages/omp/README.md`](../omp/README.md#configuration) for the canonical, shared option
reference (defaults live in `packages/core/src/pure.ts`). This package uses the same options with a
`pi`-shaped default `logFile` of `~/.cache/pi/lm-studio-warm.log`.

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

- Design spec: `docs/superpowers/specs/2026-08-11-lm-studio-warm-monorepo-design.md`
