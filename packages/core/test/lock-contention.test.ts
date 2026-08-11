import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"

import { describe, it, expect, beforeAll, afterAll } from "bun:test"

import type { RuntimeProfile } from "../src/profile"

/**
 * Real two-process contention test (spec Testing §4): a separate `bun`
 * process (test/helpers/lock-holder.ts) acquires the shared lock and blocks
 * inside a fake `lms load` that never returns on its own. This process then
 * exercises a real createWarmGate against the SAME lockDir to prove:
 *
 *  - a short-timeout waiter does NOT break a live holder's lock (it fails as
 *    an ambiguous lock-contention timeout, and the holder's pid file is left
 *    intact — the lock was never broken);
 *  - once the holder process is actually dead, a retry breaks the lock via
 *    the dead-pid path (immediately, independent of the recorded deadline)
 *    and the warm succeeds.
 *
 * No real `lms`/LM Studio is used anywhere in this file.
 */

const { createWarmGate } = await import("../src/warm-gate")
const { resolveOptions, buildDefaults } = await import("../src/pure")

const TEST_PROFILE: RuntimeProfile = {
  runtime: "test",
  providers: ["lm-studio"],
  logFile: "~/.cache/test-runtime/lm-studio-warm.log",
  envBaseUrl: true,
}

// Stateful fake `lms` shared by both the holder subprocess and this
// process's own in-process gates. `load` behaves in one of two ways,
// selected by the LMS_FAKE_HANG env var (set only for the holder
// subprocess):
//   - LMS_FAKE_HANG=1: never resolves on its own (simulates a real
//     long-running load with no natural completion inside the test window;
//     the test ends the scenario by killing the holder process). Bounded to
//     20s as a self-cleanup safety net in case something is left running.
//   - unset: completes immediately and marks the key resident, so a
//     subsequent `ps` reports it addressable.
const FAKE_LMS = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const stateFile = path.join(__dirname, "state.json")
const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"))
const write = (s) => fs.writeFileSync(stateFile, JSON.stringify(s))
const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n")
const cmd = args[0]
if (cmd === "ps") {
  const state = read()
  console.log(JSON.stringify(state.instances))
} else if (cmd === "server") {
  // no-op: HTTP liveness is controlled by the test's real loopback server
} else if (cmd === "load") {
  if (process.env.LMS_FAKE_HANG === "1") {
    setTimeout(() => process.exit(1), 20_000)
  } else {
    const key = args[1]
    const state = read()
    state.instances.push({ modelKey: key, identifier: key, status: "idle", queued: 0 })
    write(state)
    console.log("loaded")
  }
} else {
  console.error("unknown command: " + cmd)
  process.exit(1)
}
`

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

describe("two-process lock contention (real bun subprocess holder)", () => {
  it(
    "a short-timeout waiter does not break a live holder's lock; once the holder dies, a retry breaks it and succeeds",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lmswarm-contention-"))
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lmswarm-contention-home-"))
      const lmsPath = path.join(dir, "lms.cjs")
      fs.writeFileSync(lmsPath, FAKE_LMS, { mode: 0o755 })
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ instances: [] }))

      const lockDir = path.join(dir, "warm.lock")
      const holderLogFile = path.join(dir, "holder.log")

      const helperPath = path.join(import.meta.dir, "helpers", "lock-holder.ts")
      const holderArgs = {
        home,
        lockDir,
        lmsPath,
        logFile: holderLogFile,
        baseURL: serverURL,
        loadTimeoutMs: 20_000,
      }

      const holder = Bun.spawn({
        cmd: ["bun", helperPath, JSON.stringify(holderArgs)],
        env: { ...process.env, LMS_FAKE_HANG: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })

      try {
        // Wait for the holder to actually acquire the lock (the brief:
        // "waits for the lock dir"), not for its stdout to flush.
        const acquireDeadline = Date.now() + 10_000
        while (!fs.existsSync(lockDir) && Date.now() < acquireDeadline) {
          await new Promise((r) => setTimeout(r, 20))
        }
        expect(fs.existsSync(lockDir)).toBe(true)

        // The holder's own pid write can race the mkdir by a beat.
        const pidDeadline = Date.now() + 5_000
        while (!fs.existsSync(path.join(lockDir, "pid")) && Date.now() < pidDeadline) {
          await new Promise((r) => setTimeout(r, 20))
        }
        const pidBefore = fs.readFileSync(path.join(lockDir, "pid"), "utf8")
        expect(pidBefore.trim()).toBe(String(holder.pid))

        // A short-timeout waiter must fail as an ambiguous lock-contention
        // timeout — the live holder's lock is not broken.
        const waiterOpts = resolveOptions(buildDefaults(TEST_PROFILE, home), {}, {
          lockDir,
          lmsPath,
          logFile: path.join(dir, "waiter.log"),
          baseURL: serverURL,
          launchAppFallback: false,
          loadTimeoutMs: 1_000,
          lockWaitTimeoutMs: 3_000,
        })
        const waiter = createWarmGate(waiterOpts)
        const r1 = await waiter.warm("k", serverURL)
        expect(r1.ok).toBe(false)
        expect(r1.confirmed).toBe(false)
        expect(r1.reason).toMatch(/lock contention/i)
        expect(fs.readFileSync(path.join(lockDir, "pid"), "utf8")).toBe(pidBefore)

        // Kill the holder and wait for it to actually exit, so the retry's
        // dead-pid check is not racing a still-alive process.
        holder.kill("SIGKILL")
        await holder.exited

        // A retry now breaks the (dead-holder) lock immediately and the
        // load succeeds — even though the holder's recorded `deadline` is
        // still far in the future (20s load budget + 120s floor).
        const retryOpts = resolveOptions(buildDefaults(TEST_PROFILE, home), {}, {
          lockDir,
          lmsPath,
          logFile: path.join(dir, "retry.log"),
          baseURL: serverURL,
          launchAppFallback: false,
          loadTimeoutMs: 5_000,
          lockWaitTimeoutMs: 5_000,
        })
        const retryGate = createWarmGate(retryOpts)
        const r2 = await retryGate.warm("k", serverURL)
        // ok:true only if the post-load `ps` reports "k" addressable, which
        // only the (non-hanging) retry's `load` call can have produced —
        // proof the retry actually loaded the model, not just broke the lock.
        expect(r2.ok).toBe(true)
        expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).instances).toContainEqual(
          expect.objectContaining({ identifier: "k" }),
        )

        retryGate.releaseLockIfOurs()
      } finally {
        holder.kill("SIGKILL")
        await holder.exited.catch(() => {})
        fs.rmSync(dir, { recursive: true, force: true })
        fs.rmSync(home, { recursive: true, force: true })
      }
    },
    { timeout: 25_000 },
  )
})
