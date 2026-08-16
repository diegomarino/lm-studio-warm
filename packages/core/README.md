# lm-studio-warm-core

Runtime-agnostic core of [lm-studio-warm](https://github.com/diegomarino/lm-studio-warm): a
deterministic LM Studio model pre-warm gate. It owns the cross-process lock, eviction planning,
`lms` CLI client, model discovery, and two-tier config loading — with no dependency on any host
runtime (omp, pi, opencode, etc).

This package has no user-facing entry point on its own; it is consumed by runtime adapters —
[`omp-lm-studio-warm`](https://github.com/diegomarino/lm-studio-warm/tree/main/packages/omp), [`pi-lm-studio-warm`](https://github.com/diegomarino/lm-studio-warm/tree/main/packages/pi), and
[`opencode-lmstudio-warm`](https://github.com/diegomarino/lm-studio-warm/tree/main/packages/opencode) — each of which supplies a `RuntimeProfile` (providers to
gate, default log path, config filenames) and its own config-directory resolution.

> **This is the canonical configuration reference.** Every wiring package's README links here
> instead of duplicating the table below (audit F20) — see each package's README for its own
> install steps, config file location, and host-specific behavior.

## Two-tier config handling

Config loading (`loadConfigFrom` in `src/config.ts`) classifies every problem into one of two
tiers:

- **Identity tier** (hard-deactivate, visible diagnostic): a file that fails to parse, a file whose
  top level is not an object, or an `enabled` value that is not a strict YAML/JSON boolean. YAML
  1.2 (which the `yaml` package implements) parses the YAML 1.1 spellings `no`/`off`/`yes`/`on` as
  plain strings — those are rejected with a named error instead of being "repaired" to the default
  `true`, so a mistyped kill switch can never silently activate the plugin.
- **Tuning tier** (resilient): every other option keeps repair-to-default with a collected warning;
  warnings are surfaced by the activation layer on every path, active or not. Unknown keys warn the
  same way, so check the warnings after upgrading if an option was renamed.

`~` at the start of `lmsPath`, `logFile`, and `lockDir` expands to the resolved home directory.

## Configuration reference

Defaults are computed by `buildDefaults(profile, home)` in `src/pure.ts`. Two defaults vary **per
runtime profile** — everything else is identical across omp, pi, and opencode:

- `providers` — the provider IDs the profile gates (e.g. `['lm-studio']` for omp/pi, `['lmstudio']`
  for opencode).
- `logFile` — a runtime-specific path (`~/.cache/omp/lm-studio-warm.log`,
  `~/.cache/pi/lm-studio-warm.log`, `~/.cache/opencode/lm-studio-warm.log`).

`lockDir` is **not** per-runtime: it defaults to the same shared path,
`~/.cache/lm-studio-warm/lock`, for every profile — see [Lock semantics](#lock-semantics-shared-cross-runtime-lock)
below for why.

| Option | Type | Tier | Default | Description |
|---|---|---|---|---|
| `enabled` | boolean | identity | `true` | Global kill switch. Must be a literal boolean — see [Two-tier config handling](#two-tier-config-handling). |
| `providers` | string[] | tuning | *(per profile — see above)* | Per-runtime semantics differ: on **opencode**, only matching provider IDs get warm-gated per request. On **omp/pi**, the list filters the *eager warm only* — request gating always follows the one registered `lm-studio` provider, regardless of this list. |
| `lmsPath` | string | tuning | `~/.lmstudio/bin/lms` (if it exists) else `lms` | `lms` executable path. |
| `baseURL` | string | tuning | `http://127.0.0.1:1234/v1` | LM Studio HTTP base URL for checks/streams. Must be loopback (non-loopback logs a warning; the gate cannot manage a remote server). |
| `ttlSeconds` | number | tuning | `0` | Default `lms load --ttl` (`0` omits the flag — resident until unloaded). |
| `parallel` | number | tuning | `0` | Default `lms load --parallel` (`0` omits the flag — LM Studio's own default). |
| `contextLength` | number | tuning | `0` | Default `lms load --context-length` (`0` omits the flag — model default). |
| `perModel` | object | tuning | `{}` | Per-model-key overrides of `ttlSeconds` / `parallel` / `contextLength`. |
| `verifyCacheMs` | number | tuning | `30000` | Skip re-`ps` checks for this window after a confirmed warm. |
| `retryCooldownMs` | number | tuning | `60000` | Cooldown before retrying a previously (confirmed) failed key. |
| `loadTimeoutMs` | number | tuning | `900000` | Timeout for `lms load`; also the basis of the lock's holder-recorded staleness budget (see below). |
| `serverStartTimeoutMs` | number | tuning | `90000` | Timeout for bringing the LM Studio HTTP server up. |
| `lockWaitTimeoutMs` | number | tuning | `1200000` | Max time this process waits for the cross-process warm lock before giving up. |
| `failMode` | `open` \| `closed` \| `hybrid` | tuning | `hybrid` | Failure strategy when warm can't be confirmed: `open` never blocks; `closed` fails any warm failure; `hybrid` fails only confirmed failures and fails-open on ambiguous ones. |
| `reconcileDuplicates` | boolean | tuning | `true` | Remove an idle `modelKey:2`-style duplicate before loading the base key. |
| `launchAppFallback` | boolean | tuning | `true` | macOS only: launch the LM Studio app if the server won't start. |
| `eager` | boolean | tuning | `true` | On session start, warm the pinned model(s) in the background (host-specific: current model for pi; current + `@smol` for omp; `model` + `small_model` for opencode). |
| `evictOnPressure` | boolean | tuning | `false` | Enable proactive/reactive RAM-pressure eviction and retry. |
| `ramBudgetMB` | number | tuning | `0` | RAM budget in MB (`0` = 90% of total physical memory). |
| `evictHeadroomMB` | number | tuning | `4096` | Flat safety margin (MB) added over a model's on-disk weight size when deciding whether it fits. |
| `evictProtect` | string[] | tuning | `[]` | Model keys (or instance identifiers) eviction must never unload. |
| `evictMaxVictims` | number | tuning | `8` | Max LRU victims evicted per warm attempt (`0` = unlimited); bounds worst-case lock-hold time. |
| `logFile` | string | tuning | *(per profile — see above)* | Log file path; rotated to `<logFile>.old` once it grows past ~5 MB. |
| `lockDir` | string | tuning | `~/.cache/lm-studio-warm/lock` | Cross-process lock directory — shared across every runtime by default. |

## Lock semantics (shared cross-runtime lock)

`lockDir` defaults to the **same** path — `~/.cache/lm-studio-warm/lock` — for every runtime
profile, because the lock guards one physical resource: the local LM Studio process. Concurrent
omp, pi, and opencode sessions all contend on this one directory; without that, the duplicate
`lms load` race the lock exists to prevent would return across runtimes.

The lock is a `mkdir`-based mutex (`src/warm-gate.ts`) with three pieces of state inside the lock
directory:

- `pid` — the holder's process id.
- `deadline` — the holder's own recorded staleness budget, `now() + loadTimeoutMs + 120_000`,
  refreshed while the load is in flight. Because runtimes may tune `loadTimeoutMs` differently,
  staleness is always computed from the **holder's** recorded deadline, not the waiter's own
  timeout — otherwise a short-timeout session could break a live, still-loading holder's lock and
  reopen the duplicate-load race. A waiter falls back to an age-based budget (its own
  `loadTimeoutMs + 120_000`) only when the `deadline` file is missing or unparseable (e.g. written
  by an older release).
- Dead-pid breaker: if the recorded `pid` is not alive, the lock is broken immediately and
  independent of the deadline — a dead holder must never make waiters wait out a long recorded
  budget.
- Foreign-entry guard: if the lock directory contains anything other than `pid`/`deadline`, both
  the stale-breaking path and the normal release path refuse to delete it and log a warning instead
  — protects against `lockDir` being misconfigured to point at a real directory.

**Cross-runtime eviction limitation:** RAM-pressure eviction (`evictOnPressure`) budgets per
runtime process, not globally — there is no shared ownership metadata across omp/pi/opencode
workers. Keep eviction-related settings (`ramBudgetMB`, `evictHeadroomMB`, `evictProtect`,
`evictMaxVictims`) consistent across every runtime you run concurrently against the same LM Studio
instance; tracking real cross-runtime ownership is future work (see the monorepo design spec,
§Shared lock).

## Troubleshooting

This table is the canonical decoder for the failure vocabulary core emits on
**every** runtime (omp, pi, opencode). Every failure message points at the
runtime's log file (`~/.cache/{omp,pi,opencode}/lm-studio-warm.log` by
default). Wiring READMEs add only host-specific notes and link back here.

| Symptom (log/UI) | Meaning | Action |
|---|---|---|
| `lm-studio-warm is INACTIVE: … could not be parsed` / `enabled is …` | The config file is unusable; the plugin deactivated rather than guess. | Fix the YAML/JSON (use literal `true`/`false` for `enabled`), or delete the file. |
| `failed to read …` + inactive | Config exists but is unreadable (permissions). | `chmod u+r` the file; check ownership after sudo edits. |
| `lms binary not found at "…"` | The LM Studio CLI is missing or `lmsPath` is wrong. | Install the `lms` CLI (LM Studio → Developer) or fix `lmsPath` in your runtime's config file. |
| `lock contention timeout waiting to warm …` | Another process held the shared warm lock for the whole `lockWaitTimeoutMs`. | Usually just wait/retry; if a lock is truly stuck, remove the `lockDir` directory. |
| `only suffixed duplicates of <key> are resident (…)` | Only `key:2`-style instances exist and one is busy. | Wait until idle (auto-reconciled), or `lms unload <id>` / unload in the GUI. |
| `… (cached failure from Ns ago — no new probe; retrying in ~Ns…)` | A recent confirmed failure is being replayed from cache during `retryCooldownMs`. | If you already fixed the cause, wait out the cooldown or restart the session. |
| `refused for memory` / `guardrail` in a load failure | LM Studio refused the load under RAM pressure. | Enable `evictOnPressure`, raise `evictHeadroomMB`, or unload models manually. |
| `eviction: reached evictMaxVictims=…` | The eviction cap stopped further unloads. | Raise `evictMaxVictims` (or `0` for unlimited). |
| `WARNING: baseURL … is not loopback` | The gate manages only the local LM Studio; remote servers cannot be warmed. | Point `baseURL` at the local server, or accept JIT behavior for remote. |
| `not deleting lock dir …: unexpected entries` | `lockDir` points at a directory with real content — refusing to delete it. | Point `lockDir` at a dedicated path (default `~/.cache/lm-studio-warm/lock`); it should only ever contain `pid` and `deadline`. |

## Development

```bash
bun install        # bun >= 1.0, run from the repo root
bun run --filter lm-studio-warm-core check   # typecheck (tsc --noEmit) + tests
```

## License

MIT. See [LICENSE](./LICENSE).
