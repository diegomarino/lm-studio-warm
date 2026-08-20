import { describe, it, expect, spyOn } from "bun:test"
import {
  buildDefaults,
  resolveOptions,
  sanitizeOptions,
  unknownOptionKeys,
  addressable,
  classifyPs,
  parseLmsJsonArray,
  decodeProcessOutput,
  parseModelRef,
  loadArgs,
  pidAlive,
  parseLockPid,
  parseLockDeadline,
  shouldFailRequest,
  resolveBudgetBytes,
  parseModelSize,
  evictionCandidates,
  planEviction,
  isMemoryPressureError,
  OK,
  type WarmOptions,
  type LmsInstance,
} from "../src/pure"
import type { RuntimeProfile } from "../src/profile"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fetchLmStudioModels } from "../src/discover"
import { configCandidatePaths, parseConfigFile, loadConfigFrom } from "../src/config"
import { createWarmGate } from "../src/warm-gate"
import { createLmsClient, type Runner } from "../src/lms"

// Hermetic scratch dir: no test in this file may touch real-$HOME state.
const UNIT_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "core-lmswarm-unit-"))

const MiB = 1024 * 1024

const TEST_PROFILE: RuntimeProfile = {
  runtime: "test",
  providers: ["lm-studio"],
  logFile: "~/.cache/test-runtime/lm-studio-warm.log",
  envBaseUrl: true,
}

const DEFAULTS = buildDefaults(TEST_PROFILE, "/home/fixture")

function opts(over: Partial<WarmOptions> = {}): WarmOptions {
  return resolveOptions(DEFAULTS, {}, over)
}

describe("buildDefaults", () => {
  it("computes lmsPath, logFile from the passed home — no module-load os.homedir() capture", () => {
    const home1 = "/home/one"
    const home2 = "/home/two"
    const d1 = buildDefaults(TEST_PROFILE, home1)
    const d2 = buildDefaults(TEST_PROFILE, home2)
    expect(d1.lmsPath.startsWith(home1) || d1.lmsPath === "lms").toBe(true)
    expect(d2.lmsPath.startsWith(home2) || d2.lmsPath === "lms").toBe(true)
    expect(d1.logFile).toBe(path.join(home1, ".cache/test-runtime/lm-studio-warm.log"))
    expect(d2.logFile).toBe(path.join(home2, ".cache/test-runtime/lm-studio-warm.log"))
  })

  it("uses the profile's providers and logFile", () => {
    const d = buildDefaults(
      { runtime: "pi", providers: ["lm-studio-pi"], logFile: "~/.cache/pi/lm-studio-warm.log", envBaseUrl: false },
      "/home/u",
    )
    expect(d.providers).toEqual(["lm-studio-pi"])
    expect(d.logFile).toBe("/home/u/.cache/pi/lm-studio-warm.log")
  })

  it("always uses the shared cross-runtime lockDir regardless of profile", () => {
    const home = "/home/shared"
    const dOmp = buildDefaults(TEST_PROFILE, home)
    const dPi = buildDefaults(
      { runtime: "pi", providers: ["lm-studio-pi"], logFile: "~/.cache/pi/lm-studio-warm.log", envBaseUrl: false },
      home,
    )
    expect(dOmp.lockDir).toBe(path.join(home, ".cache/lm-studio-warm/lock"))
    expect(dPi.lockDir).toBe(path.join(home, ".cache/lm-studio-warm/lock"))
  })

  it("defaults home to os.homedir() when omitted", () => {
    const d = buildDefaults(TEST_PROFILE)
    expect(d.lockDir).toBe(path.join(os.homedir(), ".cache/lm-studio-warm/lock"))
  })
})

describe("resolveOptions", () => {
  it("applies defaults when nothing is provided", () => {
    const o = resolveOptions(DEFAULTS, {}, undefined)
    expect(o.providers).toEqual(["lm-studio"])
    expect(o.failMode).toBe("hybrid")
    expect(o.ttlSeconds).toBe(0)
    expect(o.eager).toBe(true)
    expect(o.enabled).toBe(true)
    expect(o.evictMaxVictims).toBe(8)
  })

  it("file options override defaults, plugin options override file", () => {
    const o = resolveOptions(DEFAULTS, { parallel: 2, ttlSeconds: 10 }, { parallel: 5 })
    expect(o.parallel).toBe(5)
    expect(o.ttlSeconds).toBe(10)
  })

  it("plugin failMode overrides file failMode", () => {
    expect(resolveOptions(DEFAULTS, { failMode: "closed" }, { failMode: "open" }).failMode).toBe("open")
  })
})

describe("unknownOptionKeys", () => {
  it("lists keys the plugin does not know", () => {
    expect(unknownOptionKeys({ verifycachems: 1, failMode: "open" }, DEFAULTS)).toEqual(["verifycachems"])
  })

  it("returns empty for known keys only, or an empty object", () => {
    expect(unknownOptionKeys({}, DEFAULTS)).toEqual([])
    expect(unknownOptionKeys({ ttlSeconds: 5, eager: false }, DEFAULTS)).toEqual([])
  })
})

describe("sanitizeOptions", () => {
  it("passes a valid config through unchanged with no warnings", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions(DEFAULTS, {}, { failMode: "closed", parallel: 2 }), DEFAULTS)
    expect(warnings).toEqual([])
    expect(o.failMode).toBe("closed")
    expect(o.parallel).toBe(2)
  })

  it("falls back to hybrid on unrecognized failMode", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions(DEFAULTS, { failMode: "Hybrid" as never }, null), DEFAULTS)
    expect(o.failMode).toBe("hybrid")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("failMode")
  })

  it("resets providers to default when not a non-empty string array", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions(DEFAULTS, { providers: "lm-studio" as never }, null), DEFAULTS)
    expect(o.providers).toEqual(["lm-studio"])
    expect(warnings).toHaveLength(1)
  })

  it("rejects providers containing an empty string (distinct from the wrong-type branch above)", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions(DEFAULTS, { providers: ["lm-studio", ""] }, null), DEFAULTS)
    expect(o.providers).toEqual(["lm-studio"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("providers")
  })

  it("resets negative or non-numeric numeric options to their defaults", () => {
    const { opts: o, warnings } = sanitizeOptions(
      resolveOptions(DEFAULTS, { verifyCacheMs: -5, loadTimeoutMs: "big" as never }, null),
      DEFAULTS,
    )
    expect(o.verifyCacheMs).toBe(30_000)
    expect(o.loadTimeoutMs).toBe(900_000)
    expect(warnings).toHaveLength(2)
  })

  it("resets wrong-typed booleans and empty strings to their defaults", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions(DEFAULTS, { eager: "yes" as never, lmsPath: "" }, null), DEFAULTS)
    expect(o.eager).toBe(true)
    expect(o.lmsPath).not.toBe("")
    expect(warnings).toHaveLength(2)
  })

  it("resets a non-string-array evictProtect to the default empty list", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions(DEFAULTS, { evictProtect: [1, "ok"] as never }, null), DEFAULTS)
    expect(o.evictProtect).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it("drops a non-object perModel entry and keeps valid sibling entries", () => {
    const { opts: o, warnings } = sanitizeOptions(
      resolveOptions(
        DEFAULTS,
        {
          perModel: {
            good: { ttlSeconds: 10 },
            bad: null as never,
          },
        },
        null,
      ),
      DEFAULTS,
    )
    expect(o.perModel.good).toEqual({ ttlSeconds: 10 })
    expect(o.perModel.bad).toBeUndefined()
    expect(warnings.some((w) => w.includes('perModel["bad"]'))).toBe(true)
  })

  it("drops invalid/unknown perModel fields but keeps valid ones", () => {
    const { opts: o, warnings } = sanitizeOptions(
      resolveOptions(
        DEFAULTS,
        {
          perModel: {
            m: { ttlSeconds: 5, parallel: -1 as never, nope: 1 as never } as never,
          },
        },
        null,
      ),
      DEFAULTS,
    )
    expect(o.perModel.m).toEqual({ ttlSeconds: 5 })
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it("drops a wrong-typed (non-number) perModel field, distinct from the negative-number arm above", () => {
    const { opts: o, warnings } = sanitizeOptions(
      resolveOptions(
        DEFAULTS,
        {
          perModel: {
            m: { contextLength: "8192" as never, parallel: 2 } as never,
          },
        },
        null,
      ),
      DEFAULTS,
    )
    expect(o.perModel.m).toEqual({ parallel: 2 })
    expect(warnings.some((w) => w.includes('perModel["m"].contextLength must be a non-negative number'))).toBe(true)
  })

  it("resets evictMaxVictims when negative", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions(DEFAULTS, { evictMaxVictims: -1 }, null), DEFAULTS)
    expect(o.evictMaxVictims).toBe(8)
    expect(warnings).toHaveLength(1)
  })
})

describe("addressable", () => {
  it("true only when some instance.identifier equals the bare key", () => {
    expect(addressable([{ identifier: "k", modelKey: "k" }], "k")).toBe(true)
    expect(addressable([{ identifier: "k:2", modelKey: "k" }], "k")).toBe(false)
    expect(addressable([], "k")).toBe(false)
    expect(addressable(null as never, "k")).toBe(false)
  })

  it("tolerates null/garbage elements within an otherwise valid array without throwing", () => {
    expect(addressable([null as never, { identifier: "k" }], "k")).toBe(true)
    expect(addressable([null as never, undefined as never], "k")).toBe(false)
  })
})

describe("classifyPs", () => {
  it("null or non-array → unknown", () => {
    expect(classifyPs(null, "k")).toEqual({ state: "unknown" })
    expect(classifyPs({} as never, "k")).toEqual({ state: "unknown" })
  })

  it("addressable / absent / duplicates(+busy)", () => {
    expect(classifyPs([{ identifier: "k", modelKey: "k" }], "k")).toEqual({ state: "addressable" })
    expect(classifyPs([], "k")).toEqual({ state: "absent" })
    const dups = [{ identifier: "k:2", modelKey: "k", status: "idle", queued: 0 }]
    expect(classifyPs(dups, "k")).toEqual({ state: "duplicates", dups, busy: false })
    const busy = [{ identifier: "k:2", modelKey: "k", status: "generating", queued: 0 }]
    expect(classifyPs(busy, "k")).toEqual({ state: "duplicates", dups: busy, busy: true })
    const queued = [{ identifier: "k:2", modelKey: "k", status: "idle", queued: 1 }]
    expect(classifyPs(queued, "k")).toEqual({ state: "duplicates", dups: queued, busy: true })
  })
})

describe("parseLmsJsonArray", () => {
  it("parses bare arrays, BOM, wrappers; null on junk", () => {
    expect(parseLmsJsonArray('[{"a":1}]')).toEqual([{ a: 1 }])
    expect(parseLmsJsonArray('\ufeff[{"a":1}]')).toEqual([{ a: 1 }])
    expect(parseLmsJsonArray('{"instances":[{"a":1}]}', ["instances"])).toEqual([{ a: 1 }])
    expect(parseLmsJsonArray("not-json")).toBeNull()
    expect(parseLmsJsonArray("")).toBeNull()
    expect(parseLmsJsonArray('{"x":1}', ["instances"])).toBeNull()
  })

  it("tolerates surrounding whitespace / CRLF around the payload", () => {
    expect(parseLmsJsonArray('  \r\n[{"a":1}]\n')).toEqual([{ a: 1 }])
    expect(parseLmsJsonArray("   ")).toBeNull() // whitespace-only collapses to the empty-output branch
  })

  it("does not auto-unwrap a wrapper object when unwrapKeys is omitted (default [])", () => {
    expect(parseLmsJsonArray('{"instances":[{"a":1}]}')).toBeNull()
  })

  it("returns null for successfully-parsed non-array primitives, including the null literal (typeof null === 'object' trap)", () => {
    expect(parseLmsJsonArray("42")).toBeNull()
    expect(parseLmsJsonArray('"hi"')).toBeNull()
    expect(parseLmsJsonArray("null")).toBeNull()
  })
})

describe("decodeProcessOutput", () => {
  it("passthrough string; BOM-aware buffers", () => {
    expect(decodeProcessOutput("hi")).toBe("hi")
    const le = Buffer.from("\uFEFF[1]", "utf16le")
    expect(JSON.parse(decodeProcessOutput(le).replace(/^\uFEFF/, "").trim())).toEqual([1])
    const be = Buffer.from("\uFEFF[2]", "utf16le")
    be.swap16()
    expect(JSON.parse(decodeProcessOutput(be).replace(/^\uFEFF/, "").trim())).toEqual([2])
    expect(decodeProcessOutput(Buffer.from('{"a":1}', "utf8"))).toBe('{"a":1}')
  })
})

describe("createLmsClient", () => {
  it("psInstances parses array stdout and returns null on failure", async () => {
    const calls: string[][] = []
    const run: Runner = async (_cmd, args) => {
      calls.push(args)
      if (args[0] === "ps") {
        return {
          ok: true,
          timedOut: false,
          stdout: JSON.stringify([{ identifier: "k", modelKey: "k" }]),
          stderr: "",
        }
      }
      return { ok: false, timedOut: false, stdout: "", stderr: "nope" }
    }
    const client = createLmsClient("/bin/lms", run)
    await expect(client.psInstances()).resolves.toEqual([{ identifier: "k", modelKey: "k" }])
    expect(calls[0]).toEqual(["ps", "--json"])
  })

  it("psInstances returns null when stdout is unusable", async () => {
    const run: Runner = async () => ({ ok: true, timedOut: false, stdout: "not-json", stderr: "" })
    const client = createLmsClient("lms", run)
    await expect(client.psInstances()).resolves.toBeNull()
  })

  it("lsModels unwraps {models:[]} ", async () => {
    const run: Runner = async () => ({
      ok: true,
      timedOut: false,
      stdout: JSON.stringify({ models: [{ modelKey: "k", sizeBytes: 12 }] }),
      stderr: "",
    })
    const client = createLmsClient("lms", run)
    await expect(client.lsModels()).resolves.toEqual([{ modelKey: "k", sizeBytes: 12 }])
  })

  it("ENOENT remedy names the runtime's own config file via configHint (F9)", async () => {
    const enoentRun: Runner = async () => ({
      ok: false,
      timedOut: false,
      stdout: "",
      stderr: "",
      errorCode: "ENOENT",
      errorMessage: "spawn lms ENOENT",
    })
    // Default hint: the YAML name omp/pi probe.
    const yamlClient = createLmsClient("lms", enoentRun)
    await yamlClient.lms(["ps", "--json"], 1000)
    expect(yamlClient.lastRunError()?.message).toContain("set lmsPath in lm-studio-warm.yml")
    // opencode-style hint: the JSON name its loader actually reads.
    const jsonClient = createLmsClient("lms", enoentRun, () => {}, "lm-studio-warm.json")
    await jsonClient.lms(["ps", "--json"], 1000)
    expect(jsonClient.lastRunError()?.message).toContain("set lmsPath in lm-studio-warm.json")
    expect(jsonClient.lastRunError()?.message).not.toContain("lm-studio-warm.yml")
  })
})


describe("parseModelRef", () => {
  it("splits on first slash only", () => {
    expect(parseModelRef("lm-studio/qwen/qwen3")).toEqual({ providerID: "lm-studio", key: "qwen/qwen3" })
    expect(parseModelRef("lm-studio/k")).toEqual({ providerID: "lm-studio", key: "k" })
    expect(parseModelRef("noslash")).toBeNull()
    expect(parseModelRef(1)).toBeNull()
  })
})

describe("loadArgs", () => {
  it("omits zero flags; applies perModel overrides", () => {
    expect(loadArgs(opts(), "k")).toEqual(["load", "k", "-y"])
    expect(loadArgs(opts({ ttlSeconds: 60, parallel: 2, contextLength: 8192 }), "k")).toEqual([
      "load",
      "k",
      "-y",
      "--ttl",
      "60",
      "--parallel",
      "2",
      "--context-length",
      "8192",
    ])
    expect(
      loadArgs(
        opts({
          ttlSeconds: 60,
          perModel: { k: { ttlSeconds: 10 }, other: { ttlSeconds: 99 } },
        }),
        "k",
      ),
    ).toEqual(["load", "k", "-y", "--ttl", "10"])
  })

  it("a perModel override for a different key does not leak into the target key's args", () => {
    const o = opts({ parallel: 4, perModel: { other: { parallel: 9 } } })
    expect(loadArgs(o, "k")).toEqual(["load", "k", "-y", "--parallel", "4"])
  })
})

describe("writeFileAtomic (lock deadline torn-read hardening)", () => {
  it("publishes only complete values: concurrent readers see old or new content, never a partial file, and no temp residue remains", async () => {
    const mod = await import("../src/warm-gate")
    expect(typeof mod.writeFileAtomic).toBe("function")

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-lmswarm-atomic-"))
    const file = path.join(dir, "deadline")
    const OLD = "1111111111111"
    const NEW = "2222222222222"
    fs.writeFileSync(file, OLD)

    const seen = new Set<string>()
    let stop = false
    const reader = (async () => {
      while (!stop) {
        try {
          seen.add(fs.readFileSync(file, "utf8"))
        } catch {}
        await new Promise((r) => setTimeout(r, 0))
      }
    })()
    for (let i = 0; i < 200; i++) await mod.writeFileAtomic(file, NEW)
    stop = true
    await reader

    for (const v of seen) expect([OLD, NEW]).toContain(v)
    expect(fs.readFileSync(file, "utf8")).toBe(NEW)
    expect(fs.readdirSync(dir)).toEqual(["deadline"])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("pidAlive / parseLockPid", () => {
  it("probes live pid and parses positive ints only", () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(2_147_000_000)).toBe(false)
    expect(parseLockPid(" 123 \n")).toBe(123)
    expect(parseLockPid("")).toBeNull()
    expect(parseLockPid(null)).toBeNull()
    expect(parseLockPid("0")).toBeNull()
    expect(parseLockPid("-3")).toBeNull()
    expect(parseLockPid("nope")).toBeNull()
  })

  it("treats EPERM (process exists but owned by another user) as alive, not dead", () => {
    const spy = spyOn(process, "kill").mockImplementation(() => {
      const e = new Error("operation not permitted") as NodeJS.ErrnoException
      e.code = "EPERM"
      throw e
    })
    try {
      expect(pidAlive(1)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("parseLockDeadline", () => {
  it("parses a valid decimal epoch-ms string; rejects garbage/blank/non-finite/<=0", () => {
    expect(parseLockDeadline(" 1699999999999 \n")).toBe(1699999999999)
    expect(parseLockDeadline("")).toBeNull()
    expect(parseLockDeadline(null)).toBeNull()
    expect(parseLockDeadline("0")).toBeNull()
    expect(parseLockDeadline("-3")).toBeNull()
    expect(parseLockDeadline("nope")).toBeNull()
    expect(parseLockDeadline("NaN")).toBeNull()
    expect(parseLockDeadline("Infinity")).toBeNull()
  })
})

describe("shouldFailRequest", () => {
  const fail = { ok: false, confirmed: false, reason: "x" }
  const confirmed = { ok: false, confirmed: true, reason: "x" }
  it("ok never fails; closed any; hybrid confirmed only; open never", () => {
    expect(shouldFailRequest("hybrid", OK)).toBe(false)
    expect(shouldFailRequest("closed", fail)).toBe(true)
    expect(shouldFailRequest("hybrid", fail)).toBe(false)
    expect(shouldFailRequest("hybrid", confirmed)).toBe(true)
    expect(shouldFailRequest("open", confirmed)).toBe(false)
  })
})

describe("eviction pure", () => {
  it("resolveBudgetBytes explicit vs auto 90%", () => {
    expect(resolveBudgetBytes(opts({ ramBudgetMB: 1000 }), 64 * MiB)).toBe(1000 * MiB)
    expect(resolveBudgetBytes(opts({ ramBudgetMB: 0 }), 1000)).toBe(Math.floor(1000 * 0.9))
  })

  it("parseModelSize hit/miss/null", () => {
    expect(parseModelSize([{ modelKey: "k", sizeBytes: 10 }], "k")).toBe(10)
    expect(parseModelSize([{ modelKey: "other", sizeBytes: 10 }], "k")).toBeNull()
    expect(parseModelSize(null, "k")).toBeNull()
  })

  it("evictionCandidates excludes target/busy/protected; LRU order", () => {
    const instances: LmsInstance[] = [
      { identifier: "a", modelKey: "a", status: "idle", queued: 0, lastUsedTime: 30, sizeBytes: 1 },
      { identifier: "b", modelKey: "b", status: "idle", queued: 0, lastUsedTime: 10, sizeBytes: 1 },
      { identifier: "c", modelKey: "c", status: "generating", queued: 0, lastUsedTime: 1, sizeBytes: 1 },
      { identifier: "t", modelKey: "t", status: "idle", queued: 0, lastUsedTime: 1, sizeBytes: 1 },
      { identifier: "p", modelKey: "p", status: "idle", queued: 0, lastUsedTime: 5, sizeBytes: 1 },
    ]
    const got = evictionCandidates(instances, "t", ["p"]).map((i) => i.identifier)
    expect(got).toEqual(["b", "a"])
  })

  it("evictionCandidates: excludes via modelKey-only target match, queued>0 busy, and missing identifier; missing lastUsedTime sorts first", () => {
    // A suffixed duplicate of the target (different identifier, same modelKey) must still be excluded —
    // proves the `i.modelKey !== targetKey` arm, not just the `i.identifier !== targetKey` arm.
    const dup = { identifier: "t:2", modelKey: "t", status: "idle", queued: 0, lastUsedTime: 1, sizeBytes: 1 }
    expect(evictionCandidates([dup], "t", [])).toEqual([])

    // queued > 0 counts as busy even when status is idle (not just `generating`).
    const queued: LmsInstance = { identifier: "q", modelKey: "q", status: "idle", queued: 2, lastUsedTime: 1, sizeBytes: 1 }
    expect(evictionCandidates([queued], "t", [])).toEqual([])

    // An instance without a string identifier is never a candidate.
    const noId = { modelKey: "x", status: "idle", queued: 0, lastUsedTime: 1, sizeBytes: 1 } as LmsInstance
    const ok: LmsInstance = { identifier: "ok", modelKey: "ok", status: "idle", queued: 0, lastUsedTime: 1, sizeBytes: 1 }
    expect(evictionCandidates([noId, ok], "t", []).map((i) => i.identifier)).toEqual(["ok"])

    // A missing lastUsedTime defaults to 0 and therefore sorts first (most evictable).
    const never: LmsInstance = { identifier: "never", modelKey: "never", status: "idle", queued: 0, sizeBytes: 1 }
    const oldest: LmsInstance = { identifier: "oldest", modelKey: "oldest", status: "idle", queued: 0, lastUsedTime: 1000, sizeBytes: 1 }
    expect(evictionCandidates([oldest, never], "t", []).map((i) => i.identifier)).toEqual(["never", "oldest"])
  })

  it("planEviction already-fits / partial / cannot-fit", () => {
    const instances: LmsInstance[] = [
      { identifier: "old", modelKey: "old", status: "idle", queued: 0, lastUsedTime: 1, sizeBytes: 50 },
      { identifier: "mid", modelKey: "mid", status: "idle", queued: 0, lastUsedTime: 2, sizeBytes: 40 },
    ]
    expect(
      planEviction({
        instances,
        targetKey: "t",
        targetSizeBytes: 10,
        budgetBytes: 200,
        headroomBytes: 0,
        protect: [],
      }),
    ).toEqual({ victims: [], fitsAfter: true })

    const plan = planEviction({
      instances,
      targetKey: "t",
      targetSizeBytes: 80,
      budgetBytes: 100,
      headroomBytes: 0,
      protect: [],
    })
    expect(plan.victims.map((v) => v.identifier)).toEqual(["old", "mid"])
    expect(plan.fitsAfter).toBe(true)

    const nofit = planEviction({
      instances,
      targetKey: "t",
      targetSizeBytes: 200,
      budgetBytes: 100,
      headroomBytes: 0,
      protect: [],
    })
    expect(nofit.fitsAfter).toBe(false)
    expect(nofit.victims.length).toBe(2)
  })

  it("planEviction stops evicting as soon as the target fits (does not over-evict)", () => {
    const big = { identifier: "big", modelKey: "big", status: "idle", queued: 0, lastUsedTime: 1, sizeBytes: 65 }
    const small = { identifier: "small", modelKey: "small", status: "idle", queued: 0, lastUsedTime: 5, sizeBytes: 16 }
    const plan = planEviction({
      instances: [big, small],
      targetKey: "t",
      targetSizeBytes: 27,
      budgetBytes: 100,
      headroomBytes: 4,
      protect: [],
    })
    // used=81, available=19, needed=31 → evicting `big` alone (LRU first) already covers it; `small` is untouched.
    expect(plan.victims.map((v) => v.identifier)).toEqual(["big"])
    expect(plan.fitsAfter).toBe(true)
  })

  it("planEviction: no eligible candidates (all busy) → empty victims, fitsAfter false", () => {
    const busy = { identifier: "busy", modelKey: "busy", status: "generating", queued: 0, lastUsedTime: 1, sizeBytes: 65 }
    const plan = planEviction({
      instances: [busy],
      targetKey: "t",
      targetSizeBytes: 27,
      budgetBytes: 80,
      headroomBytes: 4,
      protect: [],
    })
    expect(plan.victims).toEqual([])
    expect(plan.fitsAfter).toBe(false)
  })

  it("isMemoryPressureError matches guardrail/OOM only", () => {
    expect(isMemoryPressureError("insufficient system resources / memory guardrail")).toBe(true)
    expect(isMemoryPressureError("CUDA OOM")).toBe(true)
    expect(isMemoryPressureError("not enough VRAM")).toBe(true)
    expect(isMemoryPressureError("Error: out of memory")).toBe(true) // literal "out of memory" branch, distinct from the \boom\b regex above
    expect(isMemoryPressureError("context length exceeds max")).toBe(false)
    expect(isMemoryPressureError("insufficient disk space")).toBe(false)
    expect(isMemoryPressureError("model not found")).toBe(false)
  })

  it("matches LM Studio's real guardrail stderr verbatim (Q8 capture, live E2E 2026-08-13)", () => {
    // Captured from `lms load` refusing a 35GB model with ~76GB already resident
    // on a 128GB machine. Note "insufficient system resources" alone would NOT
    // match the insufficient+memory pattern — the "guardrail" substring is the
    // load-bearing branch for LM Studio's real wording.
    const real =
      "Error: Model loading was stopped due to insufficient system resources. Continuing to load the model would likely overload your system and cause it to freeze. If you think this is incorrect, you can adjust the model loading guardrails in settings."
    expect(isMemoryPressureError(real)).toBe(true)
  })
})
describe("configCandidatePaths", () => {
  it("probes each candidate dir for lm-studio-warm.{yml,yaml,json} in order", () => {
    const home = "/tmp/fake-home"
    expect(configCandidatePaths(["/custom/agent"], TEST_PROFILE, home)).toEqual([
      "/custom/agent/lm-studio-warm.yml",
      "/custom/agent/lm-studio-warm.yaml",
      "/custom/agent/lm-studio-warm.json",
    ])
  })

  it("expands a leading ~ in a candidate dir against home", () => {
    const home = "/tmp/fake-home"
    const paths = configCandidatePaths(["~/.agent"], TEST_PROFILE, home)
    expect(paths[0]).toBe(path.join(home, ".agent/lm-studio-warm.yml"))
  })

  it("walks multiple candidate dirs, each dir's full filename set before the next dir", () => {
    const paths = configCandidatePaths(["/a", "/b"], TEST_PROFILE, "/home/u")
    expect(paths).toEqual([
      "/a/lm-studio-warm.yml",
      "/a/lm-studio-warm.yaml",
      "/a/lm-studio-warm.json",
      "/b/lm-studio-warm.yml",
      "/b/lm-studio-warm.yaml",
      "/b/lm-studio-warm.json",
    ])
  })

  it("honors a profile-supplied configNames override", () => {
    const profile: RuntimeProfile = { ...TEST_PROFILE, configNames: ["custom.yml"] }
    expect(configCandidatePaths(["/a"], profile, "/home/u")).toEqual(["/a/custom.yml"])
  })
})

describe("parseConfigFile", () => {
  it("parses YAML objects", () => {
    const { opts, warning } = parseConfigFile("failMode: closed\neager: false\n", "x.yml")
    expect(warning).toBeNull()
    expect(opts.failMode).toBe("closed")
    expect(opts.eager).toBe(false)
  })

  it("parses JSON when path ends with .json", () => {
    const { opts, warning } = parseConfigFile('{"parallel":3}', "x.json")
    expect(warning).toBeNull()
    expect(opts.parallel).toBe(3)
  })

  it("warns on malformed content", () => {
    const { opts, warning } = parseConfigFile("{", "x.json")
    expect(opts).toEqual({})
    expect(warning).toMatch(/parse/i)
  })

  it("warns when top-level is not an object (array, string, null, or number)", () => {
    // `null` specifically exercises the explicit `parsed === null` guard, since
    // `typeof null === "object"` would otherwise slip past a naive object check.
    for (const bad of ["[]", '"str"', "null", "42"]) {
      const { opts, warning } = parseConfigFile(bad, "x.json")
      expect(opts).toEqual({})
      expect(warning).toMatch(/object/i)
    }
  })
})

const AGENT_DIR = "/agent"

function loadFrom(over: Partial<Parameters<typeof loadConfigFrom>[0]> = {}) {
  return loadConfigFrom({ candidateDirs: [AGENT_DIR], profile: TEST_PROFILE, env: {}, ...over })
}

describe("loadConfigFrom", () => {
  it("missing file → inactive", () => {
    const r = loadFrom({
      home: "/no/such/home",
      readFile: () => {
        throw Object.assign(new Error("enoent"), { code: "ENOENT" })
      },
    })
    expect(r.active).toBe(false)
    if (!r.active) expect(r.reason).toBe("missing")
  })

  it("enabled:false → inactive disabled", () => {
    const r = loadFrom({
      home: "/h",
      readFile: (p) => {
        if (p.endsWith(".yml")) return "enabled: false\n"
        throw Object.assign(new Error("enoent"), { code: "ENOENT" })
      },
    })
    expect(r.active).toBe(false)
    if (!r.active) expect(r.reason).toBe("disabled")
  })

  it("present file → active with sanitized defaults merged, using the injected profile's providers", () => {
    const r = loadFrom({
      home: "/h",
      readFile: (p) => {
        if (p.endsWith(".yml")) return "failMode: closed\nunknownKey: 1\n"
        throw Object.assign(new Error("enoent"), { code: "ENOENT" })
      },
    })
    expect(r.active).toBe(true)
    if (r.active) {
      expect(r.opts.failMode).toBe("closed")
      expect(r.opts.providers).toEqual(["lm-studio"])
      expect(r.warnings.some((w) => w.includes("unknownKey"))).toBe(true)
    }
  })

  it("probes each candidateDir in order, falling through on ENOENT", () => {
    const r = loadFrom({
      candidateDirs: ["/first", "/second"],
      home: "/h",
      readFile: (p) => {
        if (p.startsWith("/second") && p.endsWith(".yml")) return "failMode: closed\n"
        throw Object.assign(new Error("enoent"), { code: "ENOENT" })
      },
    })
    expect(r.active).toBe(true)
    if (r.active) {
      expect(r.sourcePath).toBe("/second/lm-studio-warm.yml")
      expect(r.opts.failMode).toBe("closed")
    }
  })

  it("uses a different runtime's providers/logFile when given a different profile", () => {
    const piProfile: RuntimeProfile = {
      runtime: "pi",
      providers: ["lm-studio-pi"],
      logFile: "~/.cache/pi/lm-studio-warm.log",
      envBaseUrl: false,
    }
    const r = loadConfigFrom({
      candidateDirs: [AGENT_DIR],
      profile: piProfile,
      home: "/h",
      env: {},
      readFile: () => {
        throw Object.assign(new Error("enoent"), { code: "ENOENT" })
      },
    })
    expect(r.active).toBe(false)
    if (!r.active) expect(r.logFile).toBe("/h/.cache/pi/lm-studio-warm.log")
  })

  it("honors LM_STUDIO_BASE_URL only when profile.envBaseUrl is true", () => {
    const withDefaultBaseUrl = (p: string) => {
      if (p.endsWith(".yml")) return "failMode: closed\n"
      throw Object.assign(new Error("enoent"), { code: "ENOENT" })
    }

    const enabled = loadFrom({ home: "/h", env: { LM_STUDIO_BASE_URL: "http://10.0.0.5:1234/v1" }, readFile: withDefaultBaseUrl })
    expect(enabled.active).toBe(true)
    if (enabled.active) expect(enabled.opts.baseURL).toBe("http://10.0.0.5:1234/v1")

    const disabledProfile: RuntimeProfile = { ...TEST_PROFILE, envBaseUrl: false }
    const disabled = loadConfigFrom({
      candidateDirs: [AGENT_DIR],
      profile: disabledProfile,
      home: "/h",
      env: { LM_STUDIO_BASE_URL: "http://10.0.0.5:1234/v1" },
      readFile: withDefaultBaseUrl,
    })
    expect(disabled.active).toBe(true)
    if (disabled.active) expect(disabled.opts.baseURL).toBe("http://127.0.0.1:1234/v1")
  })
})

describe("loadConfigFrom two-tier safety", () => {
  const enoent = () => Object.assign(new Error("enoent"), { code: "ENOENT" })
  const withYml = (content: string) => (p: string) => {
    if (p.endsWith(".yml")) return content
    throw enoent()
  }

  it("enabled: no (YAML 1.2 string) deactivates with a named diagnostic instead of repairing to true", () => {
    const r = loadFrom({ home: "/h", readFile: withYml("enabled: no\n") })
    expect(r.active).toBe(false)
    if (!r.active) {
      expect(r.reason).toBe("invalid")
      expect(r.warnings.join("\n")).toContain("INACTIVE")
      expect(r.warnings.join("\n")).toContain("enabled")
    }
  })

  it('quoted enabled: "false" deactivates as invalid (not silently active)', () => {
    const r = loadFrom({ home: "/h", readFile: withYml('enabled: "false"\n') })
    expect(r.active).toBe(false)
    if (!r.active) expect(r.reason).toBe("invalid")
  })

  it("a syntactically broken file containing enabled: false deactivates with the parse error surfaced", () => {
    const r = loadFrom({ home: "/h", readFile: withYml("enabled: false\n  bad: [unclosed\n") })
    expect(r.active).toBe(false)
    if (!r.active) {
      expect(r.reason).toBe("invalid")
      expect(r.warnings.join("\n")).toMatch(/parse/i)
    }
  })

  it("tuning-tier mistakes still repair to defaults with warnings (resilience preserved)", () => {
    const r = loadFrom({ home: "/h", readFile: withYml("failMode: Wrong\nttlSeconds: -4\n") })
    expect(r.active).toBe(true)
    if (r.active) {
      expect(r.opts.failMode).toBe("hybrid")
      expect(r.opts.ttlSeconds).toBe(0)
      expect(r.warnings.length).toBeGreaterThanOrEqual(2)
    }
  })

  it("a found-but-unreadable config is reason unreadable, keeps its warning, and names the file", () => {
    const r = loadFrom({
      home: "/h",
      readFile: (p) => {
        if (p.endsWith(".yml")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
        throw enoent()
      },
    })
    expect(r.active).toBe(false)
    if (!r.active) {
      expect(r.reason).toBe("unreadable")
      expect(r.warnings.join("\n")).toContain("lm-studio-warm.yml")
      expect(r.warnings.join("\n")).toContain("EACCES")
    }
  })

  it("expands ~ in user-supplied lmsPath/logFile/lockDir", () => {
    const r = loadFrom({
      home: "/home/u",
      readFile: withYml("lmsPath: ~/.lmstudio/bin/lms\nlogFile: ~/logs/warm.log\nlockDir: ~/locks/warm.lock\n"),
    })
    expect(r.active).toBe(true)
    if (r.active) {
      expect(r.opts.lmsPath).toBe("/home/u/.lmstudio/bin/lms")
      expect(r.opts.logFile).toBe("/home/u/logs/warm.log")
      expect(r.opts.lockDir).toBe("/home/u/locks/warm.lock")
    }
  })

  it("disabled arm resolves the configured (tilde-expanded) logFile for the inactive notice", () => {
    const r = loadFrom({
      home: "/home/u",
      readFile: withYml("enabled: false\nlogFile: ~/custom/warm.log\n"),
    })
    expect(r.active).toBe(false)
    if (!r.active) {
      expect(r.reason).toBe("disabled")
      expect(r.logFile).toBe("/home/u/custom/warm.log")
    }
  })
})

describe("fetchLmStudioModels", () => {
  it("rejects on HTTP failure — a down server must not read as an authoritative empty catalog (F7)", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 })
    await expect(
      fetchLmStudioModels("http://127.0.0.1:9/v1", undefined, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("HTTP 500")
  })

  it("rejects on transport failure (connection refused), engaging the host's stale-cache fallback (F7)", async () => {
    const fetchImpl = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9")
    }
    await expect(
      fetchLmStudioModels("http://127.0.0.1:9/v1", undefined, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("ECONNREFUSED")
  })

  it("rejects a 200 response without a data array (schema drift is not an empty catalog) (F7)", async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).endsWith("/api/v0/models")) return new Response("nope", { status: 404 })
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    await expect(fetchLmStudioModels("http://127.0.0.1:1234/v1", undefined, fetchImpl)).rejects.toThrow(
      "without a data array",
    )
  })

  it("resolves [] only for a genuinely empty data array (F7)", async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).endsWith("/api/v0/models")) return new Response("nope", { status: 404 })
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    await expect(fetchLmStudioModels("http://127.0.0.1:1234/v1", undefined, fetchImpl)).resolves.toEqual([])
  })

  it("enriches from native /api/v0/models: vision models get vision=true, small models keep native context", async () => {
    const fetchImpl = (async (url: unknown) => {
      const u = String(url)
      if (u.endsWith("/api/v0/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "seer", type: "vlm", max_context_length: 32768 },
              { id: "tiny", type: "llm", max_context_length: 8192 },
              { id: "embed", type: "embeddings", max_context_length: 512 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response(JSON.stringify({ data: [{ id: "seer" }, { id: "tiny" }, { id: "embed" }, { id: "mystery" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const models = await fetchLmStudioModels("http://127.0.0.1:1234/v1", undefined, fetchImpl)
    const byId = new Map(models.map((m) => [m.id, m]))

    expect(byId.get("seer")?.vision).toBe(true)
    expect(byId.get("tiny")?.vision).toBe(false)
    expect(byId.get("tiny")?.contextWindow).toBe(8192)
    expect(byId.get("tiny")?.maxTokens).toBeLessThanOrEqual(8192)
    // embeddings models are not chat models
    expect(byId.has("embed")).toBe(false)
    // unknown to the native endpoint: conservative constants
    expect(byId.get("mystery")?.contextWindow).toBe(131_072)
    expect(byId.get("mystery")?.vision).toBe(false)
  })

  it("keeps working with constants when the native endpoint is unavailable", async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).endsWith("/api/v0/models")) return new Response("nope", { status: 404 })
      return new Response(JSON.stringify({ data: [{ id: "qwen3" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const models = await fetchLmStudioModels("http://127.0.0.1:1234/v1", undefined, fetchImpl)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: "qwen3", contextWindow: 131_072, vision: false })
  })

  it("degraded path (no native endpoint): embedding-named models are filtered by naming convention (F18)", async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).endsWith("/api/v0/models")) return new Response("nope", { status: 404 })
      return new Response(
        JSON.stringify({
          data: [
            { id: "text-embedding-nomic-embed-text-v1.5" },
            { id: "nomic-embed-text" },
            // "embedding" concatenated with the family name — no separator
            // after it; the naive boundary-only regex missed these (audit X3).
            { id: "embeddinggemma-300m" },
            { id: "google/embeddinggemma-300m" },
            { id: "qwen3-8b" },
            { id: "bedded-insight-4b" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
    const models = await fetchLmStudioModels("http://127.0.0.1:1234/v1", undefined, fetchImpl)
    // embedding-named ids dropped; ordinary ids kept (incl. ones merely containing "bed")
    expect(models.map((m) => m.id)).toEqual(["qwen3-8b", "bedded-insight-4b"])
  })

  it("native metadata overrides the name filter: a model typed llm is kept even with 'embed' in its name (F18)", async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).endsWith("/api/v0/models")) {
        return new Response(JSON.stringify({ data: [{ id: "embed-chat-hybrid", type: "llm", max_context_length: 4096 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: [{ id: "embed-chat-hybrid" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    const models = await fetchLmStudioModels("http://127.0.0.1:1234/v1", undefined, fetchImpl)
    expect(models.map((m) => m.id)).toEqual(["embed-chat-hybrid"])
  })

  it("rejects ids that could parse as lms flags or contain unsafe characters", async () => {
    const fetchImpl = (async (url: unknown) => {
      if (String(url).endsWith("/api/v0/models")) return new Response("nope", { status: 404 })
      return new Response(JSON.stringify({ data: [{ id: "-rf" }, { id: "ok-model" }, { id: "bad id\n" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const models = await fetchLmStudioModels("http://127.0.0.1:1234/v1", undefined, fetchImpl)
    expect(models.map((m) => m.id)).toEqual(["ok-model"])
  })
})

describe("createWarmGate process hygiene", () => {
  it("repeated createWarmGate calls do not accumulate process exit listeners (F31)", () => {
    const before = process.listeners("exit").length
    for (let i = 0; i < 15; i++) {
      const dir = fs.mkdtempSync(path.join(UNIT_SANDBOX, "gate-"))
      createWarmGate(
        resolveOptions(
          DEFAULTS,
          {},
          {
            logFile: path.join(dir, "warm.log"),
            lockDir: path.join(dir, "warm.lock"),
            lmsPath: path.join(dir, "lms-does-not-exist"),
          },
        ),
      )
    }
    const after = process.listeners("exit").length
    expect(after - before).toBeLessThanOrEqual(1)
  })
})

