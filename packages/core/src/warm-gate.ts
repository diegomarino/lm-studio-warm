import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  OK,
  BYTES_PER_MB,
  DEFAULT_EVICT_HEADROOM_MB,
  classifyPs,
  evictionCandidates,
  isMemoryPressureError,
  loadArgs,
  parseLockDeadline,
  parseLockPid,
  parseModelSize,
  pidAlive,
  planEviction,
  resolveBudgetBytes,
  type WarmOptions,
  type WarmResult,
} from "./pure"
import { createExecRunner, createLmsClient, type Runner, type RunResult } from "./lms"

export type WarmGateDeps = {
  run?: Runner
  fetchImpl?: typeof fetch
  now?: () => number
  totalmem?: () => number
  platform?: NodeJS.Platform
  /**
   * Launcher for LM Studio fallback.
   * Signature matches `open -ga "LM Studio"` usage.
   */
  openApp?: (args: string[], timeoutMs: number) => Promise<RunResult>
  /** User-visible notice channel (e.g. ctx.ui.notify); log-only when absent. */
  notify?: (message: string, type?: "info" | "warning" | "error") => void
}

// One process-wide exit hook over a registry of live gates: repeated
// createWarmGate calls (re-activations, test sandboxes) must not accumulate
// process "exit" listeners.
const exitCleanups = new Set<() => void>()
let exitHookInstalled = false
function registerExitCleanup(cleanup: () => void): void {
  exitCleanups.add(cleanup)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", () => {
    for (const fn of exitCleanups) {
      try {
        fn()
      } catch {}
    }
  })
}

export type WarmGate = {
  warm(key: string, baseURL: string): Promise<WarmResult>
  releaseLockIfOurs(): void
  /** test seam */
  readonly opts: WarmOptions
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createWarmGate(opts: WarmOptions, deps: WarmGateDeps = {}): WarmGate {
  const run: Runner = deps.run ?? createExecRunner()
  const fetchImpl: NonNullable<WarmGateDeps["fetchImpl"]> = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const totalmem = deps.totalmem ?? (() => os.totalmem())
  const platform = deps.platform ?? process.platform

  // Every process computes staleness from ITS OWN loadTimeoutMs, in two
  // distinct roles: as a lock HOLDER, this is the budget it records into the
  // `deadline` file (and keeps refreshing via touchLock) so other processes
  // honor a load-appropriate timeout instead of guessing; as a lock WAITER
  // (when a lock's `deadline` is missing/garbled — e.g. written by an older
  // release), this is the age-based fallback budget applied against ITS OWN
  // configuration, since the holder's real budget cannot be known.
  const staleBudgetMs = opts.loadTimeoutMs + 120_000

  const verifiedAt = new Map<string, number>()
  const failedAt = new Map<string, { at: number; reason: string }>()
  const inflight = new Map<string, Promise<WarmResult>>()
  const serverVerifiedAt = new Map<string, number>()
  const serverFailedAt = new Map<string, number>()
  const serverInflight = new Map<string, Promise<boolean>>()

  let holdingLock = false

  const lms = createLmsClient(opts.lmsPath, run, log)

  try {
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true })
  } catch {}

  // A custom lockDir with a missing parent must not turn every warm into an
  // ambiguous internal error: pre-create the parent like the log dir.
  try {
    fs.mkdirSync(path.dirname(opts.lockDir), { recursive: true })
  } catch {}

  try {
    if (fs.statSync(opts.logFile).size > 5 * 1024 * 1024) fs.renameSync(opts.logFile, `${opts.logFile}.old`)
  } catch {}

  function log(msg: string) {
    try {
      fs.appendFileSync(opts.logFile, `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`)
    } catch {}
  }

  const loggedOnce = new Set<string>()
  function logOnce(msg: string) {
    if (loggedOnce.has(msg)) return
    loggedOnce.add(msg)
    log(msg)
  }

  // Side effects a user would otherwise only discover by accident (the GUI
  // opening, models vanishing) get one visible notice per session.
  const notifiedOnce = new Set<string>()
  function notifyOnce(kind: string, msg: string, type: "info" | "warning" | "error" = "info") {
    if (!deps.notify || notifiedOnce.has(kind)) return
    notifiedOnce.add(kind)
    try {
      deps.notify(`lm-studio-warm: ${msg}`, type)
    } catch {}
  }

  /** True when the lock dir contains anything other than our pid/deadline files. */
  function lockDirHasForeignEntries(): boolean {
    try {
      return fs.readdirSync(opts.lockDir).some((entry) => entry !== "pid" && entry !== "deadline")
    } catch {
      return false
    }
  }

  function releaseLockIfOurs() {
    try {
      // Ownership is verified before deleting: a missing or blank pid file is
      // "ours" only when this process believes it holds the lock (its own pid
      // write may have failed). A foreign or unreadable lock is left for the
      // acquireLock breakers, which apply age grace before breaking.
      let ours = holdingLock
      try {
        const pidStr = fs.readFileSync(path.join(opts.lockDir, "pid"), "utf8").trim()
        if (pidStr !== "") ours = pidStr === String(process.pid)
      } catch {}

      if (ours) {
        if (lockDirHasForeignEntries()) {
          log(`not deleting lock dir ${opts.lockDir}: it contains unexpected entries — check the lockDir setting`)
        } else {
          fs.rmSync(opts.lockDir, { recursive: true, force: true })
        }
      }
    } catch {}
    holdingLock = false
  }

  registerExitCleanup(() => {
    if (holdingLock) releaseLockIfOurs()
  })

  function warnIfNonLoopback(baseURL: string) {
    try {
      const host = new URL(baseURL).hostname
      if (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1") return
      logOnce(
        `WARNING: baseURL ${baseURL} is not loopback — lm-studio-warm manages only the LOCAL LM Studio, so the warm gate cannot ensure models on a remote server`,
      )
    } catch {}
  }

  async function httpAlive(baseURL: string): Promise<boolean> {
    try {
      await fetchImpl(`${baseURL.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(2_500) })
      return true
    } catch {
      return false
    }
  }

  async function pollAlive(baseURL: string, timeoutMs: number): Promise<boolean> {
    const deadline = now() + timeoutMs
    while (now() < deadline) {
      if (await httpAlive(baseURL)) return true
      await sleep(1_000)
    }
    return false
  }

  function ensureServer(baseURL: string): Promise<boolean> {
    const verifiedAtMs = serverVerifiedAt.get(baseURL)
    if (now() - (verifiedAtMs ?? 0) < opts.verifyCacheMs) return Promise.resolve(true)
    if (now() - (serverFailedAt.get(baseURL) ?? 0) < opts.retryCooldownMs) return Promise.resolve(false)

    const existing = serverInflight.get(baseURL)
    if (existing) return existing

    const p = ensureServerImpl(baseURL)
      .then((up) => {
        if (up) serverFailedAt.delete(baseURL)
        else serverFailedAt.set(baseURL, now())
        return up
      })
      .finally(() => serverInflight.delete(baseURL))

    serverInflight.set(baseURL, p)
    return p
  }

  async function ensureServerImpl(baseURL: string): Promise<boolean> {
    if (await httpAlive(baseURL)) {
      serverVerifiedAt.set(baseURL, now())
      return true
    }

    log(`HTTP server not reachable at ${baseURL} — running lms server start`)
    const started = await lms.lms(["server", "start"], 30_000)
    if (!started.ok) log(`lms server start failed: ${started.stderr.trim().slice(0, 300)}`)

    if (await pollAlive(baseURL, opts.serverStartTimeoutMs)) {
      serverVerifiedAt.set(baseURL, now())
      log(`HTTP server is up at ${baseURL}`)
      return true
    }

    if (opts.launchAppFallback && platform === "darwin") {
      log(`server still down — trying: open -ga \"LM Studio\"`)
      notifyOnce("app-launch", "launching the LM Studio app in the background to start its server (disable with launchAppFallback: false)")
      const openApp = deps.openApp ?? ((args, timeoutMs) => run("/usr/bin/open", args, timeoutMs))
      await openApp(["-ga", "LM Studio"], 15_000)
      await sleep(3_000)
      await lms.lms(["server", "start"], 30_000)
      if (await pollAlive(baseURL, opts.serverStartTimeoutMs)) {
        serverVerifiedAt.set(baseURL, now())
        log(`HTTP server is up at ${baseURL} (after app launch)`)
        return true
      }
    }

    log("HTTP server did not come up within budget")
    return false
  }

  function lockHolderPid(): number | null {
    try {
      return parseLockPid(fs.readFileSync(path.join(opts.lockDir, "pid"), "utf8"))
    } catch {
      return null
    }
  }

  /** The holder's own recorded staleness budget; null when missing/garbled (older release, or race). */
  function lockHolderDeadline(): number | null {
    try {
      return parseLockDeadline(fs.readFileSync(path.join(opts.lockDir, "deadline"), "utf8"))
    } catch {
      return null
    }
  }

  async function acquireLock(): Promise<(() => void) | null> {
    const waitDeadline = now() + opts.lockWaitTimeoutMs
    const pidGraceMs = 5_000

    for (;;) {
      try {
        await fsp.mkdir(opts.lockDir, { recursive: false })
        holdingLock = true
        try {
          await fsp.writeFile(path.join(opts.lockDir, "pid"), String(process.pid))
        } catch {}
        try {
          await fsp.writeFile(path.join(opts.lockDir, "deadline"), String(now() + staleBudgetMs))
        } catch {}
        return releaseLockIfOurs
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err

        try {
          const st = await fsp.stat(opts.lockDir)
          const age = now() - st.mtimeMs
          const holder = lockHolderPid()
          const holderDeadlineMs = lockHolderDeadline()
          let reason = ""

          // Dead-pid breaking stays immediate and independent of the
          // deadline: a dead holder must never make waiters wait out a long
          // (possibly hours-long) recorded budget.
          if (holder !== null && holder !== process.pid && !pidAlive(holder)) {
            reason = `dead holder pid ${holder}`
          } else if (holderDeadlineMs !== null ? now() > holderDeadlineMs : age > staleBudgetMs) {
            reason =
              holderDeadlineMs !== null
                ? `stale (holder deadline passed ${Math.round((now() - holderDeadlineMs) / 1000)}s ago)`
                : `stale (age ${Math.round(age / 1000)}s, no recorded deadline)`
          } else if (holder === null && age > pidGraceMs) {
            reason = `abandoned (no pid, age ${Math.round(age / 1000)}s)`
          }

          if (reason) {
            if (lockDirHasForeignEntries()) {
              logOnce(`not breaking lock ${opts.lockDir} (${reason}): it contains unexpected entries — check the lockDir setting`)
            } else {
              log(`breaking lock: ${reason}`)
              await fsp.rm(opts.lockDir, { recursive: true, force: true })
              continue
            }
          }
        } catch {
          // stat raced with the lock vanishing (or lockDir is unstatable):
          // fall through to the deadline check + sleep — never a hot loop.
        }

        if (now() > waitDeadline) return null
        await sleep(500)
      }
    }
  }

  // The lms client already logs each ls failure with its true cause — no
  // second (mislabeled) log line here.
  function lmsLs(): Promise<Array<{ modelKey?: string; sizeBytes?: number }> | null> {
    return lms.lsModels()
  }

  async function unloadIfIdle(
    identifier: string,
    key: string,
    evicted: Set<string>,
    touchLock: () => Promise<void>,
  ): Promise<boolean> {
    if (evicted.has(identifier) || identifier.startsWith("-")) return false
    if (opts.evictMaxVictims > 0 && evicted.size >= opts.evictMaxVictims) {
      logOnce(
        `eviction: reached evictMaxVictims=${opts.evictMaxVictims} this attempt — not unloading further (raise evictMaxVictims, or 0 to disable the cap)`,
      )
      return false
    }

    const fresh = await lms.psInstances()
    if (fresh === null) return false

    const stillSafe = evictionCandidates(fresh, key, opts.evictProtect).some((c) => c.identifier === identifier)
    if (!stillSafe) {
      log(`eviction: skipping ${identifier} — no longer idle/evictable`)
      return false
    }

    await touchLock()
    log(`eviction: unloading idle instance ${identifier} to make room for ${key}`)
    notifyOnce("eviction", `unloading idle model(s) (first: ${identifier}) to make room for ${key} — evictOnPressure is on; details in ${opts.logFile}`, "warning")

    const un = await lms.lms(["unload", identifier], 60_000)
    evicted.add(identifier)
    if (!un.ok) {
      log(`eviction: unload ${identifier} failed: ${un.stderr.trim().slice(0, 200)}`)
      return false
    }
    return true
  }

  async function preEvict(key: string, evicted: Set<string>, touchLock: () => Promise<void>) {
    const instances = await lms.psInstances()
    if (instances === null) return

    const targetSize = parseModelSize(await lmsLs(), key)
    if (targetSize === null) {
      log(`eviction: target ${key} size unknown (lms ls) — skipping predictive step, relying on reactive backstop`)
      return
    }

    if (opts.evictHeadroomMB === DEFAULT_EVICT_HEADROOM_MB && (opts.contextLength > 8192 || opts.parallel > 1)) {
      logOnce(
        `eviction: evictHeadroomMB is at its default ${DEFAULT_EVICT_HEADROOM_MB}MB but contextLength/parallel are large — KV cache may exceed it; raise evictHeadroomMB if loads are still refused`,
      )
    }

    const budgetBytes = resolveBudgetBytes(opts, totalmem())
    const headroomBytes = opts.evictHeadroomMB * BYTES_PER_MB
    const plan = planEviction({
      instances,
      targetKey: key,
      targetSizeBytes: targetSize,
      budgetBytes,
      headroomBytes,
      protect: opts.evictProtect,
    })

    if (plan.victims.length === 0) return

    log(
      `eviction: ${key} (${Math.round(targetSize / BYTES_PER_MB)}MB) needs room under budget ${Math.round(
        budgetBytes / BYTES_PER_MB,
      )}MB — unloading ${plan.victims.length} idle instance(s); fitsAfter=${plan.fitsAfter}`,
    )

    for (const v of plan.victims) {
      if (v.identifier) await unloadIfIdle(v.identifier, key, evicted, touchLock)
    }
  }

  async function evictNextIdle(key: string, evicted: Set<string>, touchLock: () => Promise<void>): Promise<string | null> {
    const fresh = await lms.psInstances()
    if (fresh === null) return null

    for (const c of evictionCandidates(fresh, key, opts.evictProtect)) {
      if (!c.identifier || evicted.has(c.identifier)) continue
      if (await unloadIfIdle(c.identifier, key, evicted, touchLock)) return c.identifier
    }
    return null
  }

  /** Ambiguous by default; a missing lms binary is a confirmed, named failure. */
  function psUnknownResult(): WarmResult {
    const execError = lms.lastRunError()
    if (execError?.code === "ENOENT") {
      return { ok: false, confirmed: true, reason: execError.message }
    }
    return { ok: false, confirmed: false, reason: "lms ps failed — model state unknown" }
  }

  async function doWarm(key: string, baseURL: string): Promise<WarmResult> {
    const cacheKey = `${baseURL}::${key}`
    warnIfNonLoopback(baseURL)

    // Server-supplied model ids are used as lms argv positionally: never let
    // one that could parse as a flag through.
    if (key.startsWith("-")) {
      return { ok: false, confirmed: true, reason: `refusing model id "${key}": ids starting with "-" could be parsed as lms flags` }
    }

    if (!(await ensureServer(baseURL))) {
      return { ok: false, confirmed: true, reason: `LM Studio HTTP server is not reachable at ${baseURL}` }
    }

    let check = classifyPs(await lms.psInstances(), key)
    if (check.state === "unknown") return psUnknownResult()
    if (check.state === "addressable") {
      verifiedAt.set(cacheKey, now())
      return OK
    }

    const release = await acquireLock()
    if (!release) {
      log(`lock contention timeout waiting to warm ${key} — proceeding (ambiguous)`)
      return { ok: false, confirmed: false, reason: "lock contention timeout" }
    }

    // utimes takes seconds (or Date); passing epoch-ms would park the mtime
    // centuries in the future and permanently disable the stale/abandoned
    // lock breakers. Alongside the mtime touch, keep pushing the recorded
    // `deadline` out by this holder's own budget: waiters trust it as long
    // as we keep proving we're alive, instead of racing our real load time
    // against the (possibly much shorter) budget the lock happened to be
    // created with.
    const touchLock = () =>
      Promise.all([
        fsp.utimes(opts.lockDir, new Date(now()), new Date(now())).catch(() => {}),
        fsp.writeFile(path.join(opts.lockDir, "deadline"), String(now() + staleBudgetMs)).catch(() => {}),
      ]).then(() => {})

    try {
      check = classifyPs(await lms.psInstances(), key)
      if (check.state === "unknown") return psUnknownResult()
      if (check.state === "addressable") {
        verifiedAt.set(cacheKey, now())
        return OK
      }

      if (check.state === "duplicates") {
        if (!opts.reconcileDuplicates || check.busy) {
          const ids = check.dups.map((i) => i.identifier).join(", ")
          log(
            `WARNING: only non-addressable instances of ${key} exist (${ids}); busy=${check.busy} — cannot warm`,
          )
          return {
            ok: false,
            confirmed: true,
            reason:
              `only suffixed duplicates of ${key} are resident (${ids}) — wait until they go idle (they are then auto-reconciled), ` +
              `or unload one: lms unload <id> (or via the LM Studio GUI)`,
          }
        }

        for (const d of check.dups) {
          if (!d.identifier || d.identifier.startsWith("-")) continue
          await touchLock()
          log(`reconciling: unloading duplicate instance ${d.identifier}`)
          const un = await lms.lms(["unload", d.identifier], 60_000)
          if (!un.ok) log(`unload ${d.identifier} failed: ${un.stderr.trim().slice(0, 200)}`)
        }
      }

      const evicted = new Set<string>()
      if (opts.evictOnPressure) await preEvict(key, evicted, touchLock)

      const args = loadArgs(opts, key)
      const t0 = now()

      const res = await (async () => {
        for (;;) {
          log(`loading ${key} (${args.join(" ")}) ...`)
          await touchLock()
          const r = await lms.lms(args, opts.loadTimeoutMs)
          if (r.ok) return r

          const detail = (r.stderr || r.stdout).trim().slice(0, 500)
          if (opts.evictOnPressure && !r.timedOut && isMemoryPressureError(detail)) {
            const freed = await evictNextIdle(key, evicted, touchLock)
            if (freed) {
              log(`lms load ${key} refused for memory (${detail.slice(0, 120)}); evicted ${freed}, retrying`)
              continue
            }
            log(`lms load ${key} refused for memory but no idle instance remains to evict`)
          }

          return r
        }
      })()

      if (!res.ok) {
        const kind = res.timedOut ? "timeout" : "error"
        const detail = (res.stderr || res.stdout).trim().slice(0, 500)
        log(`lms load ${key} FAILED (${kind}) after ${now() - t0}ms: ${detail}`)
        return { ok: false, confirmed: true, reason: `lms load failed (${kind}): ${detail.slice(0, 200)}` }
      }

      const after = classifyPs(await lms.psInstances(), key)
      if (after.state === "addressable") {
        verifiedAt.set(cacheKey, now())
        log(`loaded ${key} in ${Math.round((now() - t0) / 1000)}s`)
        return OK
      }
      if (after.state === "unknown") {
        log(`lms load ${key} exited 0 but lms ps failed — cannot verify addressability`)
        return { ok: false, confirmed: false, reason: "loaded but unverified (lms ps failed)" }
      }

      log(`lms load ${key} exited 0 but ps does not show identifier === ${key}`)
      return { ok: false, confirmed: true, reason: `loaded but not addressable as "${key}"` }
    } finally {
      release()
    }
  }

  function warm(key: string, baseURL: string): Promise<WarmResult> {
    const cacheKey = `${baseURL}::${key}`

    if (now() - (verifiedAt.get(cacheKey) ?? 0) < opts.verifyCacheMs) return Promise.resolve(OK)

    const failed = failedAt.get(cacheKey)
    if (failed && now() - failed.at < opts.retryCooldownMs) {
      // A replayed verdict must read as history, not as a live probe.
      const ageS = Math.max(1, Math.round((now() - failed.at) / 1000))
      const retryInS = Math.max(1, Math.ceil((opts.retryCooldownMs - (now() - failed.at)) / 1000))
      return Promise.resolve({
        ok: false,
        confirmed: true,
        reason: `${failed.reason} (cached failure from ${ageS}s ago — no new probe; retrying in ~${retryInS}s, or restart the session)`,
      })
    }

    const existing = inflight.get(cacheKey)
    if (existing) return existing

    const p = doWarm(key, baseURL)
      .catch((err): WarmResult => {
        log(`warm(${key}) error: ${err instanceof Error ? err.message : String(err)}`)
        return { ok: false, confirmed: false, reason: "internal error (see log)" }
      })
      .then((r) => {
        if (r.ok) failedAt.delete(cacheKey)
        else if (r.confirmed) failedAt.set(cacheKey, { at: now(), reason: r.reason })
        return r
      })
      .finally(() => inflight.delete(cacheKey))

    inflight.set(cacheKey, p)
    return p
  }

  return {
    warm,
    releaseLockIfOurs,
    opts,
  }
}
