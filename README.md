# omp-lm-studio-warm

`omp-lm-studio-warm` is an `omp` extension that makes LM Studio usage deterministic by warming target models before each `lm-studio` streaming request.

It is opt-in: if no config file exists, it does nothing and omp keeps its built-in `lm-studio` behavior.

![Quick start: opt in with a config file, LM Studio starts cold, the first omp request warms the model before it leaves, and lms ps shows the model resident with no TTL](docs/quickstart.gif)

<sup>Scripted demo (`scripts/generate-quickstart-cast.py`) — the status/log lines are the plugin's real strings (`src/stream.ts`, `src/warm-gate.ts`); the cold-load wait is shortened. Unlike opencode, omp really does show the warming message in its status area while the gate holds the request.</sup>

## What it does

For every stream request routed through provider `lm-studio`:

1. The plugin waits for `createWarmGate` to ensure the model is already resident.
2. If warm is confirmed, it delegates to `streamOpenAICompletions`.
3. If warm is ambiguous (policy-dependent), it can fail-open and let the request proceed.
4. If warm is a confirmed hard failure (policy-dependent), it emits a terminal error event.

This removes in-flight cold-load latency spikes and makes memory-pressure behavior explicit (`evictOnPressure`).

## Install

> **Not published yet.** There is currently no GitHub release or npm package;
> install from a local checkout. Once the repository is published, the command
> will be `omp plugin install github:diegomarino/omp-lm-studio-warm#<tag>`
> (pin a tag — do not install from a moving branch).

```bash
# from a local checkout
omp plugin link /path/to/omp-lm-studio-warm
# or run directly
omp --extension ./src/index.ts
```

## Activate

Create one of:

- `~/.omp/agent/lm-studio-warm.yml`
- `~/.omp/agent/lm-studio-warm.yaml`
- `~/.omp/agent/lm-studio-warm.json`

Its **presence** activates the plugin.

- Missing config: plugin inactive (safe no-op).
- `enabled: false`: explicit kill-switch. `enabled` must be the **literal
  boolean** `true` or `false` — YAML 1.2 reads `no`/`off`/`yes`/`on` and quoted
  values as strings, and rather than guessing, the plugin **deactivates with a
  visible diagnostic** on any non-boolean value or unparseable file.
- A config that exists but cannot be read or parsed also deactivates the
  plugin, with a warning in the session UI and the log.

Config directory resolution: the plugin reads `~/.omp/agent/` by default. If
`PI_CODING_AGENT_DIR` is set (the host's session-storage override), the plugin
reads `lm-studio-warm.{yml,yaml,json}` from that directory instead. The host's
`PI_CONFIG_DIR` and profile mechanism are **not** consulted — if you relocate
your omp config with those, this plugin's config file stays under
`~/.omp/agent/` (or `PI_CODING_AGENT_DIR`).

Example:

```bash
cat > ~/.omp/agent/lm-studio-warm.yml <<'YAML'
enabled: true
eager: true
failMode: hybrid
YAML
```

`examples/lm-studio-warm.yml` has a fuller template.

## Environment variables

- `LM_STUDIO_BASE_URL`: used **only** when the config `baseURL` is still the
  default; an explicit `baseURL` in the config file wins.
- `LM_STUDIO_API_KEY`: used both during model discovery (`/models`) **and** as
  the provider `apiKey` sent as a Bearer token on every completion stream —
  set it when your LM Studio server requires a token.

## Configuration

> This table is the **canonical** configuration reference (the design spec
> links here instead of duplicating it). Defaults are from `src/pure.ts`.
>
> Config handling is two-tier: `enabled` and file parseability are strict (any
> problem deactivates the plugin, visibly). Every other option is resilient —
> an invalid value is repaired to its default and a warning is written to the
> log **and** shown once in the session UI. Unknown keys warn the same way, so
> check the warnings after upgrading if an option was renamed.
>
> `~` at the start of `lmsPath`, `logFile`, and `lockDir` expands to your home
> directory.

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Global kill switch. |
| `providers` | string[] | `['lm-studio']` | Only matching provider IDs get warm-gated. |
| `lmsPath` | string | `~/.lmstudio/bin/lms` (if exists) else `lms` | `lms` executable path. |
| `baseURL` | string | `http://127.0.0.1:1234/v1` | LM Studio HTTP base URL for checks/streams. |
| `ttlSeconds` | number | `0` | Default `lms load --ttl` (`0` omits flag). |
| `parallel` | number | `0` | Default `lms load --parallel` (`0` omits flag). |
| `contextLength` | number | `0` | Default `lms load --context-length` (`0` omits flag). |
| `perModel` | object | `{}` | Per-model overrides for `ttlSeconds`, `parallel`, `contextLength`. |
| `verifyCacheMs` | number | `30000` | Skip re-ps checks for this window after confirmed warm. |
| `retryCooldownMs` | number | `60000` | Cooldown before retrying previously failed keys. |
| `loadTimeoutMs` | number | `900000` | Timeout for `lms load`. |
| `serverStartTimeoutMs` | number | `90000` | LM Studio server probe timeout. |
| `lockWaitTimeoutMs` | number | `1200000` | Cross-process lock wait timeout for warm. |
| `failMode` | `open` \| `closed` \| `hybrid` | `hybrid` | Failure strategy when warm can’t be confirmed. |
| `reconcileDuplicates` | boolean | `true` | Remove idle `modelKey:2` duplicate before loading base key. |
| `launchAppFallback` | boolean | `true` | macOS: launch LM Studio app if server unavailable. |
| `eager` | boolean | `true` | On session start, warm `ctx.models.current()` and `@smol` in background. |
| `evictOnPressure` | boolean | `false` | Enable proactive/reactive eviction and retry. |
| `ramBudgetMB` | number | `0` | RAM budget in MB (`0` = 90% of system RAM). |
| `evictHeadroomMB` | number | `4096` | Additional headroom before deciding to evict. |
| `evictProtect` | string[] | `[]` | Model IDs never evicted during pressure handling. |
| `evictMaxVictims` | number | `8` | Max LRU victims per run (`0` = unlimited). |
| `logFile` | string | `~/.cache/omp/lm-studio-warm.log` | Log file path. |
| `lockDir` | string | `~/.cache/omp/lm-studio-warm.lock` | Cross-process lock directory. |

## Fail mode behavior

- `open`: never block requests based on warm result.
- `closed`: any warm failure fails the request.
- `hybrid` *(default)*: confirmed failures fail requests; ambiguous failures fail-open and continue.

After a confirmed failure the verdict is cached for `retryCooldownMs`
(default 60 s): requests during that window are answered from the cache and
say so explicitly (`cached failure from Ns ago — no new probe`). To retry
sooner, wait out the cooldown or restart the session.

## Session notices

Side effects announce themselves once per session in the omp UI:

- launching the LM Studio app as a server fallback (`launchAppFallback`),
- unloading idle models under RAM pressure (`evictOnPressure`),
- warming progress: while a model is being warmed, the status bar names it
  (a cold load can take minutes — it is not a hang).

## Why not `before_provider_request`?

`openai-completions` in omp does not await `onPayload`, and extension handlers have short timeout limits. A long LM Studio warm (`lms load`) could outlive those bounds and still race the request. This plugin uses a custom API (`lm-studio-warm`) with a synchronous stream factory that performs async warming in a detached flow.

## Architecture

```text
omp model discovery (provider: lm-studio)
              |
              v
registerProvider("lm-studio", api=lm-studio-warm)
              |
stream request ──> createGatedStreamFn
              ├─ await warm(model.id, model.baseUrl)
              ├─ confirmed ok -> delegate to streamOpenAICompletions
              └─ confirmed fail -> terminal error event
```

## LM Studio host recommendations

- Keep JIT load enabled as a fallback strategy.
- Disable GUI auto unload/unload-previous-on-load options if you want deterministic residency.
- Prefer local keyless access (`LM_STUDIO_API_KEY` usually optional).

## Logs / lock paths

- Log: `~/.cache/omp/lm-studio-warm.log`
- Lock: `~/.cache/omp/lm-studio-warm.lock`

## Demo (asciinema)

Two demo artifacts ship with the repository:

**Quick-start cast** — `demo-lm-studio-warm.cast` (rendered to `docs/quickstart.gif`
above). A scripted asciicast in the style of `opencode-lmstudio-warm`'s quickstart:
opt-in via config file, cold `lms ps`, first request warmed before it leaves omp
(spinner = the plugin's real status-bar message), then the model resident with no
TTL. Scripted rather than screen-recorded so it stays reproducible and free of
machine-specific noise; plugin-facing lines are its real strings.

- `bun run demo:play` → play the shipped cast (requires `asciinema`).
- `bun run demo:cast` → regenerate the cast (`scripts/generate-quickstart-cast.py`).
- `bun run demo:gif` → regenerate cast + `docs/quickstart.gif` (needs `agg`, `gifsicle`, Pillow).

**Functional check** — `scripts/demo-console.ts` validates the activation contract
without opening LM Studio: inactive mode registers nothing, an active config is
loaded **and asserted** (it fails if the loaded options differ from the config it
wrote), and a focused integration test exercises the gated stream. It sandboxes
its log and lock in a temp directory — it never touches `~/.cache/omp`.

```bash
bun run ./scripts/demo-console.ts
```

## Troubleshooting

Every failure message points at the log (default
`~/.cache/omp/lm-studio-warm.log`). What its vocabulary means:

| Symptom (log/UI) | Meaning | Action |
|---|---|---|
| `lm-studio-warm is INACTIVE: … could not be parsed` / `enabled is …` | The config file is unusable; the plugin deactivated rather than guess. | Fix the YAML/JSON (use literal `true`/`false` for `enabled`), or delete the file. |
| `failed to read …` + inactive | Config exists but is unreadable (permissions). | `chmod u+r` the file; check ownership after sudo edits. |
| `lms binary not found at "…"` | The LM Studio CLI is missing or `lmsPath` is wrong. | Install the `lms` CLI (LM Studio → Developer) or fix `lmsPath`. |
| `lock contention timeout waiting to warm …` | Another omp process held the warm lock for the whole `lockWaitTimeoutMs`. | Usually just wait/retry; if a lock is truly stuck, remove the `lockDir` directory. |
| `only suffixed duplicates of <key> are resident (…)` | Only `key:2`-style instances exist and one is busy. | Wait until idle (auto-reconciled), or `lms unload <id>` / unload in the GUI. |
| `… (cached failure from Ns ago — no new probe; retrying in ~Ns…)` | A recent confirmed failure is being replayed from cache during `retryCooldownMs`. | If you already fixed the cause, wait out the cooldown or restart the session. |
| `refused for memory` / `guardrail` in a load failure | LM Studio refused the load under RAM pressure. | Enable `evictOnPressure`, raise `evictHeadroomMB`, or unload models manually. |
| `eviction: reached evictMaxVictims=…` | The eviction cap stopped further unloads. | Raise `evictMaxVictims` (or `0` for unlimited). |
| `WARNING: baseURL … is not loopback` | The gate manages only the local LM Studio; remote servers cannot be warmed. | Point `baseURL` at the local server, or accept JIT behavior for remote. |
| `not deleting lock dir …: unexpected entries` | `lockDir` points at a directory with real content — refusing to delete it. | Point `lockDir` at a dedicated path (default `~/.cache/omp/lm-studio-warm.lock`). |

## Development

```bash
bun install        # bun >= 1.0
bun run check      # typecheck (tsc --noEmit) + tests
bun test           # bun test is the canonical runner (config in bunfig.toml)
```

Vitest was removed deliberately: `bun test` is the single runner, and its
timeout budget lives in `bunfig.toml`. Tests are hermetic — they must never
read or write real `$HOME` state (CI-style check: run `bun test` with a scratch
`HOME` and assert no `~/.cache/omp` appears there).

## Example file

See [`examples/lm-studio-warm.yml`](./examples/lm-studio-warm.yml).

## Peer dependency scope

Built/tested with:

- `@oh-my-pi/pi-ai` `17.2.12`
- `@oh-my-pi/pi-coding-agent` `17.2.12`

## License

MIT. See [LICENSE](./LICENSE).
