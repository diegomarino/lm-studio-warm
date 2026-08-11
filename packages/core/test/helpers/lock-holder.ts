#!/usr/bin/env bun
/**
 * Two-process lock-contention test helper (see ../lock-contention.test.ts).
 *
 * Acquires the real shared warm-gate lock via a genuine createWarmGate and
 * then blocks inside a fake `lms load` that never returns on its own — the
 * parent test kills this process to end the scenario. Prints "HOLDING" once
 * the lock dir exists on disk, as an extra observable signal for debugging
 * (the parent test itself synchronizes by polling the lock dir directly, per
 * the task brief, rather than depending on stdout timing).
 *
 * Invoked as: bun lock-holder.ts '<json Args>'
 */
import * as fs from "node:fs"

import { createWarmGate } from "../../src/warm-gate"
import { buildDefaults, resolveOptions } from "../../src/pure"
import type { RuntimeProfile } from "../../src/profile"

type Args = {
  home: string
  lockDir: string
  lmsPath: string
  logFile: string
  baseURL: string
  loadTimeoutMs: number
}

const args = JSON.parse(process.argv[2]) as Args

const TEST_PROFILE: RuntimeProfile = {
  runtime: "test",
  providers: ["lm-studio"],
  logFile: "~/.cache/test-runtime/lm-studio-warm.log",
  envBaseUrl: true,
}

const opts = resolveOptions(buildDefaults(TEST_PROFILE, args.home), {}, {
  lockDir: args.lockDir,
  lmsPath: args.lmsPath,
  logFile: args.logFile,
  baseURL: args.baseURL,
  loadTimeoutMs: args.loadTimeoutMs,
  // Generous relative to loadTimeoutMs — this process is the sole holder, so
  // it should never itself contend on the lock.
  lockWaitTimeoutMs: args.loadTimeoutMs + 10_000,
  serverStartTimeoutMs: 2_000,
  launchAppFallback: false,
})

const gate = createWarmGate(opts)

const poll = setInterval(() => {
  if (fs.existsSync(opts.lockDir)) {
    clearInterval(poll)
    console.log("HOLDING")
  }
}, 20)

gate.warm("k", opts.baseURL).then((r) => {
  console.log(`WARM_RESULT ${JSON.stringify(r)}`)
})
