# opencode-lm-studio-warm

Deterministic, dependency-free model pre-warm for **opencode + LM Studio**.
Guarantees your model is loaded and addressable _before_ any request leaves
opencode.

- **Loads the model before your first request** — no cold-start hang, no
  `"no model loaded"` error.
- **Re-warms after a mid-session eviction** — if the model disappears between two
  messages (a TTL you've set expires, an external unload, a JIT eviction), the
  next request reloads it automatically.
- **Warms both models at startup** — your `model` and `small_model` load eagerly
  in the background, so the first real request is already hot.
- **Frees RAM when the machine is full** _(opt-in)_ — if a model won't fit, it
  unloads idle models least-recently-used first (never busy, never protected) to
  make room instead of letting the load fail. Enable with
  [`evictOnPressure`](#ram-pressure-eviction-opt-in).
- **One load across parallel sessions** — N cold spawns trigger exactly one
  `lms load`, with no `:2` duplicate instances left behind.

![Quick start: install the plugin, LM Studio starts cold, the first opencode run is held until the model is resident, the plugin log tells the story, and lms ps shows the model resident with no TTL](https://raw.githubusercontent.com/diegomarino/lm-studio-warm/main/docs/assets/quickstart-opencode.gif)

<sup>Scripted demo (`scripts/generate-quickstart-cast.py`) — the log lines are the plugin's real
strings in their real format; the cold-load wait is shortened. opencode itself waits silently by
design (no toast UI), which is why the demo tails the log.</sup>

Per request, the plugin verifies the model is actually loaded and, only when it
isn't, performs that single `lms load` before letting the request through.

Verified against opencode **v1.17.10** and **LM Studio 0.4.18** (`lms` CLI
commit `6041ae0`) on macOS/Apple Silicon, and re-verified on this tree against
opencode **v1.18.0** (2026-08-13, 9/9 — see
[`test/e2e/verify.sh`](./test/e2e/verify.sh)). The LM Studio
behaviors the plugin depends on are the `lms ps --json` field names
(`modelKey` / `identifier` / `status` / `queued`) and the fact that
`lms load` is not idempotent.

## Quick start

> **Not published yet.** `opencode-lm-studio-warm` is not on npm yet (the
> published predecessor is the legacy `opencode-lmstudio-warm`); the npm
> commands below will work once the rename release ships. Until then, install
> from a local checkout of this monorepo: run `bun install` at its root, then
> use the [plugin-file re-export](#plugin-file-re-export) pattern pointing at
> the checkout — e.g. `~/.config/opencode/plugin/lm-studio-warm.ts` containing
> `export { LMStudioWarm } from "/path/to/lm-studio-warm/packages/opencode/src/index"`.
> (Use the NAMED re-export: opencode ≥1.18's plugin loader does not enumerate
> `export * from` re-exports — verified live on 1.18.0.)

**1. Install and register the plugin** — one command; opencode resolves it from
npm and adds it to your config's `plugin` array:

```bash
opencode plugin -g opencode-lm-studio-warm    # global (~/.config/opencode) — every session on the machine
# or, for a single project's opencode.json:
opencode plugin opencode-lm-studio-warm
```

**2. Point opencode at LM Studio** (skip if you already have an `lmstudio`
provider). In `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-lm-studio-warm"],
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1",
        "apiKey": "{env:LM_API_TOKEN}",
        "headerTimeout": 600000,
        "chunkTimeout": 120000
      }
    }
  }
}
```

Then set your `model` / `small_model` to your LM Studio model keys. See
[`examples/opencode.json`](./examples/opencode.json) for a fuller starting point.

**3. Adjust LM Studio once** (App Settings → Developer): disable
**JIT model auto-unload TTL** and **unload previous JIT model on load**; keep
JIT itself on as a fallback. ([Why these matter →](#how-it-works)) That GUI TTL
governs only JIT loads, **not** the plugin's own `lms load` — to auto-unload
warmed models by idle time, use [`ttlSeconds`](#freeing-ram-two-strategies)
instead.

That's it — from your next opencode session, the model is warm before the
first token is requested.

## Install options

Both paths load the same plugin — pick the one that fits:

| Path | Best for |
| ------ | ---------- |
| [npm](#npm-recommended) (recommended) | Most users and fleets — version-pinned, one-line updates |
| [Plugin-file re-export](#plugin-file-re-export) | Pinning to a specific auto-discovery location, or hacking on the plugin itself |

### npm (recommended)

The Quick start command above is all you need. Notes:

- You don't run `npm install` / `bun add` yourself, and there's no `npx` step —
  opencode imports the module and auto-installs any plugin named in your config
  at startup, so hand-adding `"opencode-lm-studio-warm"` to the `plugin` array
  works too.
- Use `-f` to force a version bump.

**Scriptable setup** — for fleets or automation, this `jq` one-shot registers
the plugin _and_ scaffolds the provider with recommended timeouts. It is
idempotent and non-destructive: keeps your existing plugins, provider, and
models, and never overwrites options you've set.

```bash
CFG=~/.config/opencode/opencode.json   # or ./opencode.json for a single project
[ -f "$CFG" ] || echo '{}' > "$CFG"
jq '
  .plugin = ((.plugin // []) - ["opencode-lm-studio-warm"] + ["opencode-lm-studio-warm"])
  | .provider.lmstudio.npm                  //= "@ai-sdk/openai-compatible"
  | .provider.lmstudio.options.baseURL      //= "http://127.0.0.1:1234/v1"
  | .provider.lmstudio.options.apiKey       //= "{env:LM_API_TOKEN}"
  | .provider.lmstudio.options.headerTimeout //= 600000
  | .provider.lmstudio.options.chunkTimeout  //= 120000
' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
```

### Plugin-file re-export

Install the package the normal way — `npm install opencode-lm-studio-warm` /
`bun add opencode-lm-studio-warm` — then, instead of adding it to the `plugin`
array, drop a one-line re-export where opencode's plugin auto-discovery looks:

```ts
// ~/.config/opencode/plugin/lm-studio-warm.ts (global — every session on the
// machine) or .opencode/plugin/lm-studio-warm.ts (project-local — this
// project only)
export { LMStudioWarm } from "opencode-lm-studio-warm"
```

> Use the NAMED re-export, not `export * from ...`: opencode ≥1.18's plugin
> loader does not enumerate star re-exports, so a `export *` plugin file loads
> as an empty module and the plugin silently never activates (verified live on
> 1.18.0; `export *` worked on 1.17.x).

Auto-discovered from either location — no `plugin` array entry needed.
(opencode's docs spell this directory `plugins`; verified as `plugin/` —
singular — on v1.17.10.) This still needs the package resolvable via Node
module resolution from wherever the re-export file lives (installed in that
project's `node_modules`, or globally alongside opencode) — `src/index.ts`
imports `./config` and the shared `lm-studio-warm-core` package, so a bare
copy of the file with no install behind it cannot run standalone; there is no
offline, dependency-free copy path. This repo's own E2E fixture uses the same
re-export shape (see `test/e2e/`), but re-exports directly from this repo's
`src/index.ts` by relative path rather than from an installed package, since
it's exercising this repo's own source.

Whichever path you pick, also apply the LM Studio GUI settings from
[Quick start](#quick-start) step 3 on every machine. The provider timeouts
(`headerTimeout` / `chunkTimeout`) are defense-in-depth and are already set by
the JSON/`jq` above.

## Configuration

The plugin works with zero configuration. Optional tuning lives in
`~/.config/opencode/lm-studio-warm.json` (the legacy `lmstudio-warm.json`
filename is still read for backward compatibility), or inline as
`"plugin": [["opencode-lm-studio-warm", {...}]]`. Set `"enabled": false` in the
JSON file to turn the gate off without uninstalling. Config discovery follows
the opencode binary's own rule: when `XDG_CONFIG_HOME` is set,
`$XDG_CONFIG_HOME/opencode/` is probed first, with the literal
`~/.config/opencode/` as fallback.

> **Scope:** the plugin manages the **local** LM Studio through the `lms` CLI.
> `baseURL` (and any gated provider's `baseURL`) must point at this same
> machine — a non-loopback URL is logged as a warning, and the gate can
> neither verify nor load models on a remote server.

See [`packages/core/README.md`](https://github.com/diegomarino/lm-studio-warm/blob/main/packages/core/README.md#configuration-reference) for
the canonical, shared option reference — every `WarmOptions` key, its default,
and its tier (identity vs. tuning) — plus the full lock/staleness semantics.
This package uses those options unchanged, with opencode-shaped defaults:
`providers: ['lmstudio']` and `logFile: ~/.cache/opencode/lm-studio-warm.log`.

### Freeing RAM: two strategies

By default the plugin loads models **resident** (`ttlSeconds: 0` ⇒ no `--ttl`,
`ttlMs: null`): they stay in memory until something unloads them. That is what
makes pre-warm deterministic, but on a finite-RAM host you'll eventually want a
model to give its memory back. There are two independent knobs for that, and they
**compose** — e.g. a TTL on the big model, `evictProtect` on the small one:

| Goal | Knob | How it frees RAM | Tradeoff |
| ---- | ---- | ---------------- | -------- |
| Unload after idle **time** | [`ttlSeconds`](#configuration) (+ `perModel`) | LM Studio auto-unloads the instance once it's idle past the TTL | The next request pays a cold-start reload; the gate makes it deterministic (blocks until loaded), but the latency is real |
| Unload only under **RAM pressure** | [`evictOnPressure`](#ram-pressure-eviction-opt-in) | The gate unloads idle LRU instances only when a new load won't otherwise fit | No cold-start until memory is actually contended; nothing is freed purely for sitting idle |

> **⚠ The GUI "JIT auto-unload TTL" does not apply to the plugin's loads.** That
> setting governs only JIT-loaded instances. The plugin's explicit `lms load`
> produces a *resident* instance (`ttlMs: null`), bookkept separately, that the
> GUI TTL never touches — so if you set the GUI TTL and see warmed models never
> expire, this is why. To get time-based auto-unload for warmed models, set
> **`ttlSeconds`** in the plugin config; that is the `--ttl` LM Studio actually
> honors for these instances.

**Time-based** — set a global TTL and override per model (e.g. keep the small
model resident, let the big one expire). See
[`examples/lm-studio-warm.ttl.json`](./examples/lm-studio-warm.ttl.json):

```json
{
  "ttlSeconds": 3600,
  "perModel": {
    "your-main-model-key": { "ttlSeconds": 600 },
    "your-small-model-key": { "ttlSeconds": 0 }
  }
}
```

**Pressure-based** — keep models resident and let the gate make room on demand;
see [RAM-pressure eviction](#ram-pressure-eviction-opt-in) below for the full
mechanism and [`examples/lm-studio-warm.json`](./examples/lm-studio-warm.json).

### RAM-pressure eviction (opt-in)

> **Symptom this fixes:** the log shows `lms load … FAILED … insufficient
> system resources` (or opencode surfaces `cannot ensure model … is loaded`),
> while `lms ps` still lists other models resident. Nothing is broken — the gate
> tried to load and LM Studio's guardrail refused because RAM is full, so it
> reported the failure instead of freezing your machine. Eviction is **opt-in
> and off by default**: a stock install warns rather than making room. Turn it
> on with `evictOnPressure` to have the gate unload idle models first.

On a finite-RAM host running several large models, LM Studio with
`modelLoadingGuardrails` set high **refuses** to load a model that doesn't fit
rather than making room — so the target never loads and the request falls back
to JIT or errors. Enable `evictOnPressure` to have the warm gate free room
first. When a target model isn't resident and must be loaded, the gate:

1. **Predictive pass** — looks up the target's weight size (`lms ls`), and if
   it won't fit under `ramBudgetMB` (+ `evictHeadroomMB`), unloads idle
   instances **least-recently-used first** until it fits, then loads.
2. **Reactive backstop** — if the load is still refused for memory (weight size
   is not the true runtime footprint), it frees the next idle instance and
   retries, until the load succeeds or no idle instance remains.

Only **idle** instances are ever unloaded: anything generating or with queued
work is left alone, as is the target model and any key in `evictProtect`. A
fresh check immediately before each unload re-confirms the victim is still idle.
Everything runs under the same cross-process lock as loading, so concurrent
warm-gate workers don't over-commit RAM. At most `evictMaxVictims` instances are
unloaded per attempt, bounding worst-case lock-hold time.

> **Best-effort, not atomic:** the pre-unload check and the `unload` itself are
> two separate `lms` commands, and the lock only coordinates this plugin's
> workers — not the LM Studio UI or other `lms` clients. So concurrent external
> use is **not** protected during eviction: a model can turn busy in the gap
> between check and unload, and a model being loaded by another client appears
> `idle` to `lms ps` (there is no ps-visible "loading" state). The window is
> narrow, but if you drive LM Studio from several places at once, prefer
> `evictProtect` for models you never want touched.

> **Why `evictHeadroomMB` is a flat number:** an accurate KV-cache estimate
> needs per-architecture internals (layers, KV heads, head dim) that `lms`
> doesn't expose, so any formula would be a false-precision guess. The reactive
> backstop absorbs under-prediction, so a flat margin that catches the gross
> case is enough. If loads are still refused with large context or parallelism,
> raise `evictHeadroomMB`.

See `examples/lm-studio-warm.json` for a starting point with every option
visible. Copy it to `~/.config/opencode/lm-studio-warm.json` (the legacy
`lmstudio-warm.json` filename is still read as a fallback) and replace the
`your-*-model-key` placeholders with your real model keys — the `perModel` and
`evictProtect` entries do nothing until they match a key opencode actually sends.
`perModel` keys are LM Studio model keys — the exact string opencode sends as
the API `model` field. Sizing `parallel`: set it to the expected number of
concurrent workers hitting that model; each slot costs extra KV-cache memory,
and overflow requests queue server-side (latency, not failure), so
undersizing is safe and oversizing wastes VRAM. Titles/summaries on the small
model tolerate queueing; the main model is where fleet width matters.

## Verify

A live, self-contained E2E fixture lives in [`test/e2e/`](./test/e2e/) — set two
real LM Studio model keys and run it:

```bash
MAIN="your/main-model" SMALL="your-small-model" bun run e2e
# requires jq, lms, opencode + a running LM Studio; export LM_API_TOKEN for full E2E
```

Covers: (a) cold spawn loads before the first request; (b) mid-session
eviction healed on resume (`opencode run -c`); (c) 3 parallel cold spawns →
exactly one `lms load`, no `:2` duplicates; (d) orphaned `:2`-only state is
reconciled back to an addressable instance. See
[`test/e2e/README.md`](./test/e2e/README.md) for setup and the placeholders to edit.

> ⚠️ It mutates live LM Studio state (unloads/loads models, spawns parallel
> sessions) — run it on a dev machine, not a busy fleet.

## Uninstall / rollback

For the npm install path, remove `"opencode-lm-studio-warm"` from the `plugin`
array in `opencode.json`. For the plugin-file re-export path:

```bash
rm ~/.config/opencode/plugin/lm-studio-warm.ts   # or .opencode/plugin/lm-studio-warm.ts — removes the gate
npm uninstall opencode-lm-studio-warm            # or bun remove, wherever it was installed
rm -f ~/.config/opencode/lm-studio-warm.json     # optional tuning file (or legacy lmstudio-warm.json)
rm -rf ~/.cache/lm-studio-warm/lock              # only if a stale lock lingers (shared lock dir)
```

Models loaded by the plugin have no TTL, so after uninstalling they stay
resident until `lms unload <key>` or an LM Studio restart. The `opencode.json`
timeout options and the LM Studio GUI settings are independent of the plugin
and can stay.

## How it works

### The three layers

1. **Plugin (primary, deterministic)** — `src/index.ts`.
   Per request: verified-cache (30 s) → `lms ps --json` addressability check →
   cross-process `mkdir` lock → double-checked re-check → orphan-duplicate
   reconciliation → `lms load <key> -y` (no `--ttl` ⇒ resident indefinitely,
   `ttlMs: null` verified) → post-load verification. Plus a background eager
   warm of `model` + `small_model` at instance start (`config` hook).
2. **LM Studio server settings (independent)** — in the GUI (App Settings →
   Developer): disable **JIT model auto-unload TTL** (`jitModelTTL`, default 1 h)
   and **unload previous JIT model on load** (`unloadPreviousJITModelOnLoad` —
   otherwise a JIT load of one model can evict the other). Both act only on
   **JIT-loaded** instances; the plugin's own `lms load` is resident
   (`ttlMs: null`) and already exempt, so these settings govern the JIT fallback
   path and any non-gated client, not the warmed models themselves. (To make
   warmed models auto-unload by idle time, use
   [`ttlSeconds`](#freeing-ram-two-strategies) — that GUI TTL won't do it.) Keys
   live in `~/.lmstudio/settings.json` under `developer.*` (edit only while the
   app is closed). Keep JIT **on** as a fallback; keep server autostart on.
3. **opencode timeouts (defense-in-depth)** — v1.17.10 honors undocumented
   provider options `timeout`, `headerTimeout`, `chunkTimeout`
   (`provider.ts:resolveSDK`). Default is NO timeout at all (infinite hang
   possible). `opencode.json` here sets `headerTimeout: 600000` (tolerates
   queueing behind busy parallel slots) and `chunkTimeout: 120000` (converts a
   wedged stream into a visible, bounded error).

### Why a plugin is the right layer (design decision)

Investigated against the v1.17.10 source (tag clone), not docs:

- The `chat.params` hook is **awaited** (`yield* plugin.trigger("chat.params", ...)`
  in `session/llm/request.ts`) before every request is built and sent, and it
  fires for **every** stream — including `small: true` title/summary requests.
  One hook deterministically gates BOTH pinned models, per request, which is
  what heals mid-session eviction (an orchestrator pre-warm only helps at
  spawn time).
- Plugins run in-process under Bun and can spawn `lms` (a blocking, exit-code
  deterministic load barrier).
- The `event` hook is dispatched fire-and-forget (`void hook.event?.(...)`) —
  it can NOT gate. The v2 `ctx.aisdk.sdk` custom-fetch API is **types-only** in
  v1.17.10 (nothing in core imports it) — that path from the prior verdict is
  refuted for this release.
- A plugin dropped in `~/.config/opencode/plugin/` is auto-discovered by every
  worker on the machine — one file distributes fleet-wide and also covers
  manually launched sessions.

Tradeoff vs. an orchestrator pre-warm node: the plugin costs one
`lms ps --json` (~150 ms) per model per 30 s per process at steady state; the
orchestrator node is simpler but only covers spawn time and only sessions it
spawns. Keep the orchestrator node, if you add one, as belt-and-suspenders —
it is not required.

## Known limitations / failure modes

When a request fails with an `lm-studio-warm:` error, the log at
`~/.cache/opencode/lm-studio-warm.log` has the detail — the canonical
symptom → meaning → action decoder for that vocabulary lives in the
[core README's Troubleshooting section](https://github.com/diegomarino/lm-studio-warm/blob/main/packages/core/README.md#troubleshooting).

- **30 s verified-cache window**: an external unload (GUI, crash) within 30 s
  of a positive check can slip one request through; it errors visibly and the
  next request heals. There is no error hook in v1.17.10 to invalidate the
  cache on failure.
- **`lms ps` cannot signal "loading"** (measured: a loading instance shows
  `status: "idle"` at ~200 ms into a 12.5 s load). A waiter can pass the gate
  mid-load; LM Studio queues its request until weights are ready (verified) —
  a short wait, not a failure.
- **External JIT loads race**: a non-gated client can still trigger JIT
  duplicates/evictions. Mitigated by Layer 2 settings; gate all fleet clients.
- **`unloadPreviousJITModelOnLoad` scope for explicit loads is assumed exempt**
  (evidence: explicit loads carry `ttlMs: null` vs JIT's TTL, so bookkeeping
  differs). Confirm by JIT-loading a third model via API while both pinned
  models are resident, then `lms ps`. Disabling the setting (Layer 2) makes
  this moot.
- **LM Studio app fully closed**: `lms server start` + `open -ga "LM Studio"`
  fallback is implemented but untested here (the app was running). Confirm:
  quit LM Studio → run one worker → check the log.
- **Memory guardrails**: if LM Studio's guardrail refuses a load, the default
  behavior is to fail that request with a clear error and cool down 60 s (no
  load storm). Enable [`evictOnPressure`](#ram-pressure-eviction-opt-in) to have
  the gate unload idle models and make room first; with it off (the default),
  the plugin warns instead of freeing RAM for you.
- **API auth**: the plugin itself never needs `LM_API_TOKEN` (lms + probe are
  auth-independent); workers still need it for generation when auth is on.

## Running under an orchestrator (e.g. ao-lite)

No orchestrator changes are required — workers inherit the plugin from
`~/.config/opencode/plugin/` and warm themselves. Two optional touches:
export `LM_API_TOKEN` in the worker environment (the plugin itself never needs
it), and if you want spawn-time belt-and-suspenders, a pre-warm node only needs:
`lms ps --json` guard → `lms load <key> -y` — the same logic, but remember it
cannot heal mid-session evictions; the plugin does.

## Development

The plugin is a thin adapter over the shared
[`lm-studio-warm-core`](https://github.com/diegomarino/lm-studio-warm/tree/main/packages/core) package — the pure helpers, the `lms` client,
and the audited warm gate all live in core; `src/index.ts` keeps only the
opencode-specific hooks, input-shape reads, and two-tier config activation. Its
only other import, `@opencode-ai/plugin`, is `import type` and erased at build
time. From the monorepo root:

```bash
bun install
bun run --filter './packages/opencode' typecheck   # tsc --strict, 0 errors
bun run --filter './packages/opencode' test         # bun test (unit + integration, test/)
bun run --filter './packages/opencode' check        # typecheck + tests + shellcheck
bun run --filter './packages/opencode' e2e          # live E2E fixture (needs LM Studio; see test/e2e/)
```

The pure logic (config merge, model-ref parsing, load-arg building,
addressability, pid liveness, fail-mode decisions) is unit-tested in core's
suite (`packages/core/test/unit.test.ts`); the plugin's stateful behavior (warm gate, lock,
reconciliation, eviction, the `chat.params` gate) is covered by
`test/integration.test.ts`, and the live system behavior by the E2E fixture
under [`test/e2e/`](./test/e2e/).

Releases follow [SemVer](https://semver.org); Conventional Commits decide the
bump (see [`CHANGELOG.md`](./CHANGELOG.md)).

## Disclaimer

Community plugin. Not affiliated with, endorsed by, or an official product of the
OpenCode or LM Studio teams. "opencode" and "LM Studio" are used only to indicate
compatibility.

## License

[MIT](./LICENSE) © Diego Marino
