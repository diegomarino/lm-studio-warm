import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  OK,
  BYTES_PER_MB,
  DEFAULTS,
  classifyPs,
  evictionCandidates,
  isMemoryPressureError,
  loadArgs,
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

  function releaseLockIfOurs() {
    try {
      let ours = true
      try {
        const pidStr = fs.readFileSync(path.join(opts.lockDir, "pid"), "utf8").trim()
        ours = pidStr === "" || pidStr === String(process.pid)
      } catch {
        ours = true
      }
      if (ours) fs.rmSync(opts.lockDir, { recursive: true, force: true })
    } catch {}
    holdingLock = false
  }

  process.once("exit", () => {
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

  async function acquireLock(): Promise<(() => void) | null> {
    const deadline = now() + opts.lockWaitTimeoutMs
    const staleMs = opts.loadTimeoutMs + 120_000
    const pidGraceMs = 5_000

    for (;;) {
      try {
        await fsp.mkdir(opts.lockDir, { recursive: false })
        holdingLock = true
        try {
          await fsp.writeFile(path.join(opts.lockDir, "pid"), String(process.pid))
        } catch {}
        return releaseLockIfOurs
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err

        try {
          const st = await fsp.stat(opts.lockDir)
          const age = now() - st.mtimeMs
          const holder = lockHolderPid()
          let reason = ""

          if (age > staleMs) reason = `stale (age ${Math.round(age / 1000)}s)`
          else if (holder !== null && holder !== process.pid && !pidAlive(holder)) reason = `dead holder pid ${holder}`
          else if (holder === null && age > pidGraceMs) reason = `abandoned (no pid, age ${Math.round(age / 1000)}s)`

          if (reason) {
            log(`breaking lock: ${reason}`)
            await fsp.rm(opts.lockDir, { recursive: true, force: true })
            continue
          }
        } catch {
          continue
        }

        if (now() > deadline) return null
        await sleep(500)
      }
    }
  }

  async function lmsLs(): Promise<Array<{ modelKey?: string; sizeBytes?: number }> | null> {
    const res = await lms.lsModels()
    if (res === null) {
      log(`lms ls failed: could not parse output`)
      return null
    }
    return res
  }

  async function unloadIfIdle(
    identifier: string,
    key: string,
    evicted: Set<string>,
    touchLock: () => Promise<void>,
  ): Promise<boolean> {
    if (evicted.has(identifier)) return false
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

    if (opts.evictHeadroomMB === DEFAULTS.evictHeadroomMB && (opts.contextLength > 8192 || opts.parallel > 1)) {
      logOnce(
        `eviction: evictHeadroomMB is at its default ${DEFAULTS.evictHeadroomMB}MB but contextLength/parallel are large — KV cache may exceed it; raise evictHeadroomMB if loads are still refused`,
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

  async function doWarm(key: string, baseURL: string): Promise<WarmResult> {
    const cacheKey = `${baseURL}::${key}`
    warnIfNonLoopback(baseURL)

    if (!(await ensureServer(baseURL))) {
      return { ok: false, confirmed: true, reason: `LM Studio HTTP server is not reachable at ${baseURL}` }
    }

    let check = classifyPs(await lms.psInstances(), key)
    if (check.state === "unknown") return { ok: false, confirmed: false, reason: "lms ps failed — model state unknown" }
    if (check.state === "addressable") {
      verifiedAt.set(cacheKey, now())
      return OK
    }

    const release = await acquireLock()
    if (!release) {
      log(`lock contention timeout waiting to warm ${key} — proceeding (ambiguous)`)
      return { ok: false, confirmed: false, reason: "lock contention timeout" }
    }

    const touchLock = () => fsp.utimes(opts.lockDir, now(), now()).catch(() => {})

    try {
      check = classifyPs(await lms.psInstances(), key)
      if (check.state === "unknown") return { ok: false, confirmed: false, reason: "lms ps failed — model state unknown" }
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
          return { ok: false, confirmed: true, reason: `only suffixed duplicates of ${key} are resident (${ids})` }
        }

        for (const d of check.dups) {
          if (!d.identifier) continue
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
      return Promise.resolve({ ok: false, confirmed: true, reason: `${failed.reason} (cooldown)` })
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
