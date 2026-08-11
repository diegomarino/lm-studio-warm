import { describe, it, expect } from "bun:test"
import {
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
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fetchLmStudioModels } from "../src/discover"
import { configCandidatePaths, parseConfigFile, loadConfig } from "../src/config"
import { createWarmGate } from "../src/warm-gate"
import { createLmsClient, type Runner } from "../src/lms"

// Hermetic scratch dir: no test in this file may touch real-$HOME state.
const UNIT_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "core-lmswarm-unit-"))

const MiB = 1024 * 1024

function opts(over: Partial<WarmOptions> = {}): WarmOptions {
  return resolveOptions({}, over)
}

describe("resolveOptions", () => {
  it("applies defaults when nothing is provided", () => {
    const o = resolveOptions({}, undefined)
    expect(o.providers).toEqual(["lm-studio"])
    expect(o.failMode).toBe("hybrid")
    expect(o.ttlSeconds).toBe(0)
    expect(o.eager).toBe(true)
    expect(o.enabled).toBe(true)
  })

  it("file options override defaults, plugin options override file", () => {
    const o = resolveOptions({ parallel: 2, ttlSeconds: 10 }, { parallel: 5 })
    expect(o.parallel).toBe(5)
    expect(o.ttlSeconds).toBe(10)
  })

  it("plugin failMode overrides file failMode", () => {
    expect(resolveOptions({ failMode: "closed" }, { failMode: "open" }).failMode).toBe("open")
  })
})

describe("unknownOptionKeys", () => {
  it("lists keys the plugin does not know", () => {
    expect(unknownOptionKeys({ verifycachems: 1, failMode: "open" })).toEqual(["verifycachems"])
  })

  it("returns empty for known keys only, or an empty object", () => {
    expect(unknownOptionKeys({})).toEqual([])
    expect(unknownOptionKeys({ ttlSeconds: 5, eager: false })).toEqual([])
  })
})

describe("sanitizeOptions", () => {
  it("passes a valid config through unchanged with no warnings", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({}, { failMode: "closed", parallel: 2 }))
    expect(warnings).toEqual([])
    expect(o.failMode).toBe("closed")
    expect(o.parallel).toBe(2)
  })

  it("falls back to hybrid on unrecognized failMode", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ failMode: "Hybrid" as never }, null))
    expect(o.failMode).toBe("hybrid")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("failMode")
  })

  it("resets providers to default when not a non-empty string array", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ providers: "lm-studio" as never }, null))
    expect(o.providers).toEqual(["lm-studio"])
    expect(warnings).toHaveLength(1)
  })

  it("resets negative or non-numeric numeric options to their defaults", () => {
    const { opts: o, warnings } = sanitizeOptions(
      resolveOptions({ verifyCacheMs: -5, loadTimeoutMs: "big" as never }, null),
    )
    expect(o.verifyCacheMs).toBe(30_000)
    expect(o.loadTimeoutMs).toBe(900_000)
    expect(warnings).toHaveLength(2)
  })

  it("resets wrong-typed booleans and empty strings to their defaults", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ eager: "yes" as never, lmsPath: "" }, null))
    expect(o.eager).toBe(true)
    expect(o.lmsPath).not.toBe("")
    expect(warnings).toHaveLength(2)
  })

  it("resets a non-string-array evictProtect to the default empty list", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ evictProtect: [1, "ok"] as never }, null))
    expect(o.evictProtect).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it("drops a non-object perModel entry and keeps valid sibling entries", () => {
    const { opts: o, warnings } = sanitizeOptions(
      resolveOptions(
        {
          perModel: {
            good: { ttlSeconds: 10 },
            bad: null as never,
          },
        },
        null,
      ),
    )
    expect(o.perModel.good).toEqual({ ttlSeconds: 10 })
    expect(o.perModel.bad).toBeUndefined()
    expect(warnings.some((w) => w.includes('perModel["bad"]'))).toBe(true)
  })

  it("drops invalid/unknown perModel fields but keeps valid ones", () => {
    const { opts: o, warnings } = sanitizeOptions(
      resolveOptions(
        {
          perModel: {
            m: { ttlSeconds: 5, parallel: -1 as never, nope: 1 as never } as never,
          },
        },
        null,
      ),
    )
    expect(o.perModel.m).toEqual({ ttlSeconds: 5 })
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it("resets evictMaxVictims when negative", () => {
    const { opts: o, warnings } = sanitizeOptions(resolveOptions({ evictMaxVictims: -1 }, null))
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

  it("isMemoryPressureError matches guardrail/OOM only", () => {
    expect(isMemoryPressureError("insufficient system resources / memory guardrail")).toBe(true)
    expect(isMemoryPressureError("CUDA OOM")).toBe(true)
    expect(isMemoryPressureError("not enough VRAM")).toBe(true)
    expect(isMemoryPressureError("context length exceeds max")).toBe(false)
    expect(isMemoryPressureError("insufficient disk space")).toBe(false)
    expect(isMemoryPressureError("model not found")).toBe(false)
  })
})
describe("configCandidatePaths", () => {
  it("defaults to ~/.omp/agent lm-studio-warm.{yml,yaml,json}", () => {
    const home = "/tmp/fake-home"
    expect(configCandidatePaths(home, {})).toEqual([
      path.join(home, ".omp/agent/lm-studio-warm.yml"),
      path.join(home, ".omp/agent/lm-studio-warm.yaml"),
      path.join(home, ".omp/agent/lm-studio-warm.json"),
    ])
  })

  it("honors PI_CODING_AGENT_DIR over default agent dir", () => {
    const home = "/tmp/fake-home"
    const paths = configCandidatePaths(home, { PI_CODING_AGENT_DIR: "/custom/agent" })
    expect(paths[0]).toBe("/custom/agent/lm-studio-warm.yml")
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

  it("warns when top-level is not an object", () => {
    const { opts, warning } = parseConfigFile("[]", "x.json")
    expect(opts).toEqual({})
    expect(warning).toMatch(/object/i)
  })
})

describe("loadConfig", () => {
  it("missing file → inactive", () => {
    const r = loadConfig({
      home: "/no/such/home",
      env: {},
      readFile: () => {
        throw Object.assign(new Error("enoent"), { code: "ENOENT" })
      },
    })
    expect(r.active).toBe(false)
    if (!r.active) expect(r.reason).toBe("missing")
  })

  it("enabled:false → inactive disabled", () => {
    const r = loadConfig({
      home: "/h",
      env: {},
      readFile: (p) => {
        if (p.endsWith(".yml")) return "enabled: false\n"
        throw Object.assign(new Error("enoent"), { code: "ENOENT" })
      },
    })
    expect(r.active).toBe(false)
    if (!r.active) expect(r.reason).toBe("disabled")
  })

  it("present file → active with sanitized defaults merged", () => {
    const r = loadConfig({
      home: "/h",
      env: {},
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
})

describe("loadConfig two-tier safety", () => {
  const enoent = () => Object.assign(new Error("enoent"), { code: "ENOENT" })
  const withYml = (content: string) => (p: string) => {
    if (p.endsWith(".yml")) return content
    throw enoent()
  }

  it("enabled: no (YAML 1.2 string) deactivates with a named diagnostic instead of repairing to true", () => {
    const r = loadConfig({ home: "/h", env: {}, readFile: withYml("enabled: no\n") })
    expect(r.active).toBe(false)
    if (!r.active) {
      expect(r.reason).toBe("invalid")
      expect(r.warnings.join("\n")).toContain("INACTIVE")
      expect(r.warnings.join("\n")).toContain("enabled")
    }
  })

  it('quoted enabled: "false" deactivates as invalid (not silently active)', () => {
    const r = loadConfig({ home: "/h", env: {}, readFile: withYml('enabled: "false"\n') })
    expect(r.active).toBe(false)
    if (!r.active) expect(r.reason).toBe("invalid")
  })

  it("a syntactically broken file containing enabled: false deactivates with the parse error surfaced", () => {
    const r = loadConfig({ home: "/h", env: {}, readFile: withYml("enabled: false\n  bad: [unclosed\n") })
    expect(r.active).toBe(false)
    if (!r.active) {
      expect(r.reason).toBe("invalid")
      expect(r.warnings.join("\n")).toMatch(/parse/i)
    }
  })

  it("tuning-tier mistakes still repair to defaults with warnings (resilience preserved)", () => {
    const r = loadConfig({ home: "/h", env: {}, readFile: withYml("failMode: Wrong\nttlSeconds: -4\n") })
    expect(r.active).toBe(true)
    if (r.active) {
      expect(r.opts.failMode).toBe("hybrid")
      expect(r.opts.ttlSeconds).toBe(0)
      expect(r.warnings.length).toBeGreaterThanOrEqual(2)
    }
  })

  it("a found-but-unreadable config is reason unreadable, keeps its warning, and names the file", () => {
    const r = loadConfig({
      home: "/h",
      env: {},
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
    const r = loadConfig({
      home: "/home/u",
      env: {},
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
    const r = loadConfig({
      home: "/home/u",
      env: {},
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
  it("returns [] on HTTP failure", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 })
    await expect(
      fetchLmStudioModels("http://127.0.0.1:9/v1", undefined, fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual([])
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

