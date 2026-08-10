import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"

import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest"

import type { LmsInstance, WarmOptions, WarmResult } from "../src/pure"

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lmswarm-home-"))
process.env.HOME = FAKE_HOME

const { createWarmGate } = await import("../src/warm-gate")
const { resolveOptions } = await import("../src/pure")

/**
 * Integration suite: real createWarmGate against fake lms + loopback HTTP.
 */

// FAKE_LMS: paste verbatim from opencode-warm/test/integration.test.ts
const FAKE_LMS = `#!/usr/bin/env node
// Scriptable stand-in for the lms CLI. State lives in state.json next to this
// script; behavior mirrors the real CLI semantics the plugin depends on.
const fs = require("node:fs")
const path = require("node:path")
const stateFile = path.join(__dirname, "state.json")
const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"))
const write = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2))
const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Emit stdout in the requested encoding, prepending a BOM for UTF-16 to mirror
// what Windows lms.exe produces through PowerShell (issue #3).
const writeOut = (s, enc) => {
  if (enc === "utf16le") return process.stdout.write(Buffer.from("\\uFEFF" + s, "utf16le"))
  if (enc === "utf16be") { const b = Buffer.from("\\uFEFF" + s, "utf16le"); b.swap16(); return process.stdout.write(b) }
  process.stdout.write(s)
}
;(async () => {
  const state = read()
  const cmd = args[0]
  if (cmd === "ps") {
    if (state.psFail) { console.error("ps failed (scripted)"); process.exit(1) }
    // psRaw prints verbatim (no trailing newline) so a test can inject exact
    // bytes: a leading BOM, an object wrapper, truncated/garbage JSON.
    if (typeof state.psRaw === "string") { writeOut(state.psRaw, state.psEncoding); return }
    console.log(JSON.stringify(state.instances))
    return
  }
  if (cmd === "ls") {
    if (state.lsFail) { console.error("ls failed (scripted)"); process.exit(1) }
    if (typeof state.lsRaw === "string") { writeOut(state.lsRaw, state.lsEncoding); return }
    console.log(JSON.stringify(state.downloaded ?? []))
    return
  }
  if (cmd === "server") return // HTTP liveness is controlled by the test's real server
  if (cmd === "unload") {
    state.instances = state.instances.filter((i) => i.identifier !== args[1])
    write(state)
    return
  }
  if (cmd === "load") {
    const key = args[1]
    const b = (state.load && state.load[key]) || {}
    if (b.delayMs) await sleep(b.delayMs)
    if (b.failuresRemaining > 0) {
      b.failuresRemaining -= 1
      write(state)
      console.error(b.errorText || "load failed (scripted)")
      process.exit(1)
    }
    if (!b.noEffect) {
      // NOT idempotent, like the real CLI: a resident key gains a :2 suffix.
      const already = state.instances.filter((i) => i.modelKey === key).length
      const identifier = already === 0 ? key : key + ":" + (already + 1)
      state.instances.push({ modelKey: key, identifier, status: "idle", queued: 0 })
    }
    write(state)
    return
  }
  console.error("unknown command: " + cmd)
  process.exit(1)
})()
`

type LoadBehavior = { delayMs?: number; failuresRemaining?: number; errorText?: string; noEffect?: boolean }

type FakeState = {
  instances: LmsInstance[]
  downloaded?: Array<{ modelKey?: string; sizeBytes?: number }>
  load?: Record<string, LoadBehavior>
  psFail?: boolean
  psRaw?: string
  psEncoding?: "utf16le" | "utf16be"
  lsRaw?: string
  lsEncoding?: "utf16le" | "utf16be"
}

type Sandbox = {
  dir: string
  opts: WarmOptions
  gate: ReturnType<typeof createWarmGate>
  warm: (key: string) => Promise<WarmResult>
  setState: (s: FakeState) => void
  getState: () => FakeState
  calls: () => string[][]
  loads: (key: string) => number
  unloads: () => string[]
  cleanup: () => void
}

let server: http.Server
let serverURL: string

beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"))
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address() as { port: number }
  serverURL = `http://127.0.0.1:${addr.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const sandboxes: Sandbox[] = []

afterEach(() => {
  for (const sb of sandboxes.splice(0)) sb.cleanup()
})

function makeSandbox(over: Partial<WarmOptions> = {}): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lmswarm-it-"))
  const lmsPath = path.join(dir, "lms.cjs")
  fs.writeFileSync(lmsPath, FAKE_LMS, { mode: 0o755 })

  const stateFile = path.join(dir, "state.json")
  fs.writeFileSync(stateFile, JSON.stringify({ instances: [] }))

  const lockDir = path.join(dir, "warm.lock")
  const logFile = path.join(dir, "warm.log")

  const opts = resolveOptions(
    {},
    {
      lmsPath,
      baseURL: serverURL,
      logFile,
      lockDir,
      eager: false,
      providers: ["lm-studio"],
      failMode: "hybrid",
      launchAppFallback: false,
      loadTimeoutMs: 10_000,
      serverStartTimeoutMs: 1_500,
      lockWaitTimeoutMs: 2_000,
      ...over,
    },
  )

  const gate = createWarmGate(opts)

  const sb: Sandbox = {
    dir,
    opts,
    gate,
    warm: (key) => gate.warm(key, serverURL),
    setState: (s) => fs.writeFileSync(stateFile, JSON.stringify(s)),
    getState: () => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    calls: () => {
      try {
        return fs
          .readFileSync(path.join(dir, "calls.log"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
    loads: (key) => sb.calls().filter((c) => c[0] === "load" && c[1] === key).length,
    unloads: () => sb.calls().filter((c) => c[0] === "unload").map((c) => c[1] as string),
    cleanup: () => {
      sb.gate.releaseLockIfOurs()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }

  sandboxes.push(sb)
  return sb
}

describe("warm gate", () => {
  it("cold start: loads the model exactly once", async () => {
    const sb = makeSandbox()
    const r = await sb.warm("k")
    expect(r.ok).toBe(true)
    expect(sb.loads("k")).toBe(1)
    expect(sb.getState().instances.map((i) => i.identifier)).toEqual(["k"])
  })

  it("already-resident: no load", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [{ modelKey: "k", identifier: "k", status: "idle", queued: 0 }] })
    const r = await sb.warm("k")
    expect(r.ok).toBe(true)
    expect(sb.loads("k")).toBe(0)
  })

  it("positive cache skips lms within verifyCacheMs", async () => {
    const sb = makeSandbox({ verifyCacheMs: 60_000 })
    await sb.warm("k")
    sb.setState({ ...sb.getState(), psFail: true })
    const r = await sb.warm("k")
    expect(r.ok).toBe(true)
    expect(sb.loads("k")).toBe(1)
  })

  it("concurrent warm single-flights one load", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], load: { k: { delayMs: 200 } } })
    const [a, b] = await Promise.all([sb.warm("k"), sb.warm("k")])
    expect(a.ok && b.ok).toBe(true)
    expect(sb.loads("k")).toBe(1)
  })

  it("hybrid: confirmed load failure fails result.confirmed", async () => {
    const sb = makeSandbox({ failMode: "hybrid" })
    sb.setState({ instances: [], load: { k: { failuresRemaining: 99, errorText: "boom", noEffect: true } } })
    const r = await sb.warm("k")
    expect(r.ok).toBe(false)
    expect(r.confirmed).toBe(true)
  })

  it("hybrid: ps unknown is ambiguous (not confirmed) and does not load", async () => {
    const sb = makeSandbox()
    sb.setState({ instances: [], psFail: true })
    const r = await sb.warm("k")
    expect(r.ok).toBe(false)
    expect(r.confirmed).toBe(false)
    expect(sb.loads("k")).toBe(0)
  })

  it("reconciles idle duplicate :2 then loads bare key", async () => {
    const sb = makeSandbox({ reconcileDuplicates: true })
    sb.setState({
      instances: [{ modelKey: "k", identifier: "k:2", status: "idle", queued: 0 }],
    })
    const r = await sb.warm("k")
    expect(r.ok).toBe(true)
    expect(sb.unloads()).toContain("k:2")
    expect(sb.loads("k")).toBe(1)
  })

  it("busy duplicate is confirmed failure without unload", async () => {
    const sb = makeSandbox()
    sb.setState({
      instances: [{ modelKey: "k", identifier: "k:2", status: "generating", queued: 0 }],
    })
    const r = await sb.warm("k")
    expect(r.ok).toBe(false)
    expect(r.confirmed).toBe(true)
    expect(sb.unloads()).toEqual([])
    expect(sb.loads("k")).toBe(0)
  })

  it("predictive eviction unloads LRU idle before load", async () => {
    const sb = makeSandbox({
      evictOnPressure: true,
      ramBudgetMB: 100,
      evictHeadroomMB: 0,
    })
    sb.setState({
      instances: [
        { modelKey: "old", identifier: "old", status: "idle", queued: 0, lastUsedTime: 1, sizeBytes: 80 * 1024 * 1024 },
      ],
      downloaded: [
        { modelKey: "old", sizeBytes: 80 * 1024 * 1024 },
        { modelKey: "k", sizeBytes: 50 * 1024 * 1024 },
      ],
    })
    const r = await sb.warm("k")
    expect(r.ok).toBe(true)
    expect(sb.unloads()).toContain("old")
    expect(sb.loads("k")).toBe(1)
  })

  it("reactive eviction retries after memory pressure error", async () => {
    const sb = makeSandbox({
      evictOnPressure: true,
      ramBudgetMB: 10_000,
      evictHeadroomMB: 0,
    })
    sb.setState({
      instances: [
        { modelKey: "old", identifier: "old", status: "idle", queued: 0, lastUsedTime: 1, sizeBytes: 1 },
      ],
      downloaded: [{ modelKey: "k", sizeBytes: 1 }],
      load: { k: { failuresRemaining: 1, errorText: "insufficient memory guardrail" } },
    })
    const r = await sb.warm("k")
    expect(r.ok).toBe(true)
    expect(sb.unloads()).toContain("old")
    expect(sb.loads("k")).toBe(2)
  })

  it("dead lock holder is broken and load proceeds", async () => {
    const sb = makeSandbox()
    fs.mkdirSync(sb.opts.lockDir)
    fs.writeFileSync(path.join(sb.opts.lockDir, "pid"), "2147000000") // dead
    const r = await sb.warm("k")
    expect(r.ok).toBe(true)
    expect(sb.loads("k")).toBe(1)
  })

  it("live lock holder contention times out as ambiguous", async () => {
    const sb = makeSandbox({ lockWaitTimeoutMs: 800 })
    fs.mkdirSync(sb.opts.lockDir)
    fs.writeFileSync(path.join(sb.opts.lockDir, "pid"), String(process.pid)) // live holder
    // refresh mtime to now so stale breaker does not fire
    const now = new Date()
    fs.utimesSync(sb.opts.lockDir, now, now)

    const r = await sb.warm("k")
    expect(r.ok).toBe(false)
    expect(r.confirmed).toBe(false)
    expect(r.reason).toMatch(/lock contention/i)
    expect(sb.loads("k")).toBe(0)

    // cleanup foreign lock so sandbox cleanup is safe
    fs.rmSync(sb.opts.lockDir, { recursive: true, force: true })
  })
})
