# omp-lm-studio-warm

`omp-lm-studio-warm` is an `omp` extension that makes LM Studio usage deterministic by warming target models before each `lm-studio` streaming request.

It is opt-in: if no config file exists, it does nothing and omp keeps its built-in `lm-studio` behavior.

![Quick start: opt in with a config file, LM Studio starts cold, the first omp request warms the model before it leaves, and lms ps shows the model resident with no TTL](https://raw.githubusercontent.com/diegomarino/lm-studio-warm/main/docs/assets/quickstart-omp.gif)

<sup>Scripted demo (`scripts/generate-quickstart-cast.py`) — the status/log lines are the plugin's real strings (this package's `src/stream.ts` and the shared [`lm-studio-warm-core`](https://github.com/diegomarino/lm-studio-warm/tree/main/packages/core)'s `src/warm-gate.ts`); the cold-load wait is shortened. Unlike opencode, omp really does show the warming message in its status area while the gate holds the request.</sup>

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
> will be `omp plugin install github:diegomarino/lm-studio-warm#<tag>`, pointed
> at the `packages/omp` directory of that tag (pin a tag — do not install from
> a moving branch).

```bash
# from a local checkout of the lm-studio-warm monorepo:
# install workspace deps first — the extension imports lm-studio-warm-core
bun install
omp plugin link /path/to/lm-studio-warm/packages/omp
# or run directly
omp --extension /path/to/lm-studio-warm/packages/omp/src/index.ts
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

Config directory resolution is delegated entirely to omp's own `getAgentDir()`
(from `@oh-my-pi/pi-coding-agent`) — this plugin does not hard-code
`~/.omp/agent/` itself, it probes `lm-studio-warm.{yml,yaml,json}` inside
whatever directory `getAgentDir()` returns. In the common case that resolves
to `~/.omp/agent/`; `PI_CODING_AGENT_DIR` (the session-storage override) and
any profile-selection mechanism are the **host's** semantics — owned and
documented by `@oh-my-pi/pi-coding-agent`, not by this plugin — so if you
relocate your omp config directory via the host, this plugin's config file
follows it automatically.

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

See [`packages/core/README.md`](https://github.com/diegomarino/lm-studio-warm/blob/main/packages/core/README.md#configuration-reference) for
the canonical, shared option reference — every `WarmOptions` key, its default,
and its tier (identity vs. tuning) — plus the full lock/staleness semantics.
This package uses those options unchanged, with omp-shaped defaults:
`providers: ['lm-studio']` and `logFile: ~/.cache/omp/lm-studio-warm.log`.

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
- Lock: `~/.cache/lm-studio-warm/lock` — **shared across runtimes.** omp, `pi`
  and `opencode-lm-studio-warm` sessions all default to this one lock
  directory, because it guards one physical resource: the local LM Studio
  process. The lock holder records its own `loadTimeoutMs` budget into the
  lock (as a `deadline` file); a waiter with a shorter timeout will not break
  a live holder's lock early, but a dead holder is still broken immediately.
  If you set `lockDir` explicitly, that value is unaffected by this default.

  > **Migrating from an older release:** the default used to be
  > `~/.cache/omp/lm-studio-warm.lock` (omp-only). No action is needed — the
  > old path is simply unused going forward — but if you previously pointed
  > `lockDir` at that path explicitly, you can drop the override to join the
  > shared lock, or keep it if you want omp isolated from other runtimes.

  > **Mixed-version rollout:** a pre-monorepo omp release only knows about a
  > `pid` file inside the lock directory — it does not recognize the new
  > holder-recorded `deadline` file this release writes. When an old-format
  > omp process waits on a lock held by a new-format holder, it treats
  > `deadline` as an unexpected entry and refuses to break the lock early (the
  > same conservative behavior the foreign-entry guard documents above); it
  > simply waits out its own `lockWaitTimeoutMs` and then fails open with
  > `lock contention timeout waiting to warm …`. It will not corrupt or delete
  > the lock. Upgrade every runtime sharing a `lockDir` together to avoid this
  > during a rollout.

## Demo (asciinema)

Two demo artifacts ship with the repository. All commands in this section run
**from the repo root of a monorepo checkout** — the `demo:*` scripts live in the
root `package.json` and are not part of the published package:

**Quick-start cast** — `docs/assets/quickstart-omp.cast` (rendered to
`docs/assets/quickstart-omp.gif` above). A scripted asciicast in the style of `opencode-lmstudio-warm`'s quickstart:
opt-in via config file, cold `lms ps`, first request warmed before it leaves omp
(spinner = the plugin's real status-bar message), then the model resident with no
TTL. Scripted rather than screen-recorded so it stays reproducible and free of
machine-specific noise; plugin-facing lines are its real strings.

- `bun run demo:play` → play the shipped cast (requires `asciinema`).
- `bun run demo:cast` → regenerate the cast (`scripts/generate-quickstart-cast.py`).
- `bun run demo:gif` → regenerate cast + `docs/assets/quickstart-omp.gif` (needs `agg`, `gifsicle`, Pillow).

**Functional check** — `scripts/demo-console.ts` validates the activation contract
without opening LM Studio: inactive mode registers nothing, an active config is
loaded **and asserted** (it fails if the loaded options differ from the config it
wrote), and a focused integration test exercises the gated stream. It sandboxes
its log and lock in a temp directory — it never touches `~/.cache/omp`.

```bash
# from the repo root
bun run ./scripts/demo-console.ts
```

## Troubleshooting

Every failure message points at the log (default
`~/.cache/omp/lm-studio-warm.log`). The failure vocabulary is core-shared
across all three runtimes — the canonical symptom → meaning → action table
lives in the
[core README's Troubleshooting section](https://github.com/diegomarino/lm-studio-warm/blob/main/packages/core/README.md#troubleshooting).

omp-specific notes:

- Config problems additionally surface as a one-time `ctx.ui.notify` warning
  at session start (invalid/unreadable configs name the file and the fix).
- `lock contention timeout` here usually means another omp/pi/opencode
  session held the shared lock; see the core table for the recovery steps.

## Development

```bash
bun install        # bun >= 1.0
bun run check      # typecheck (tsc --noEmit) + tests
bun run test       # bun test is the canonical runner (the 30 s timeout lives in this script's flag)
```

Vitest was removed deliberately: `bun test` is the single runner. The 30 s
timeout budget lives in each package's `test` script flag (`--timeout 30000`) —
the root `bunfig.toml` is only picked up for root-cwd runs, so bare `bun test`
inside a package would get bun's 5 s default. Tests are hermetic — they must never
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

