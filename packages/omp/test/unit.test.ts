import { describe, it, expect } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"
import { resolveOptions } from "lm-studio-warm-core"
import { fetchLmStudioWarmModels } from "../src/discover-adapter"
import { activateExtension } from "../src/index"
import { createGatedStreamFn } from "../src/stream"

// Hermetic scratch dir: no test in this file may touch real-$HOME state.
const UNIT_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lmswarm-unit-"))

describe("fetchLmStudioWarmModels", () => {
  it("maps OpenAI /models data to ProviderModelConfig with api lm-studio-warm", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: [{ id: "qwen3" }, { id: "other" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })

    const models = await fetchLmStudioWarmModels("http://127.0.0.1:1234/v1", undefined, fetchImpl as unknown as typeof fetch)
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      id: "qwen3",
      name: "qwen3",
      api: "lm-studio-warm",
      reasoning: false,
      input: ["text"],
    })
  })
})

describe("createGatedStreamFn gating deps", () => {
  it("warm-target fallback uses the configured baseURL, not a hardcoded literal (F26)", async () => {
    const seen: string[] = []
    const fn = createGatedStreamFn({
      warm: async (_key, baseURL) => {
        seen.push(baseURL)
        return { ok: false, confirmed: true, reason: "stop here" }
      },
      failMode: "closed",
      logFile: path.join(UNIT_SANDBOX, "stream.log"),
      baseURL: "http://127.0.0.1:5678/v1",
    })

    const model = { id: "k", provider: "lm-studio", api: "lm-studio-warm", baseUrl: undefined } as never
    const events: unknown[] = []
    for await (const ev of fn(model, { messages: [] } as never)) events.push(ev)

    expect(seen).toEqual(["http://127.0.0.1:5678/v1"])
  })

  it("names the model in the status/working area while warming and clears it afterwards (F6)", async () => {
    const uiCalls: Array<[string, ...unknown[]]> = []
    const ui = {
      setStatus: (key: string, text: string | undefined) => uiCalls.push(["setStatus", key, text]),
      setWorkingMessage: (message?: string) => uiCalls.push(["setWorkingMessage", message]),
    }

    let release: (() => void) | undefined
    const warmStarted = new Promise<void>((r) => (release = r as never))
    const fn = createGatedStreamFn({
      warm: async () => {
        await warmStarted
        return { ok: false, confirmed: true, reason: "stop here" }
      },
      failMode: "closed",
      logFile: path.join(UNIT_SANDBOX, "stream.log"),
      baseURL: "http://127.0.0.1:1234/v1",
      getUi: () => ui,
    })

    const model = { id: "big-model", provider: "lm-studio", api: "lm-studio-warm", baseUrl: undefined } as never
    const stream = fn(model, { messages: [] } as never)

    // within ~1s of gating, the UI names the model being warmed
    const deadline = Date.now() + 1_000
    while (
      !uiCalls.some(([m, , text]) => m === "setStatus" && String(text).includes("big-model")) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(uiCalls.some(([m, , text]) => m === "setStatus" && String(text).includes("big-model"))).toBe(true)
    expect(uiCalls.some(([m, text]) => m === "setWorkingMessage" && String(text).includes("big-model"))).toBe(true)

    release?.()
    const events: unknown[] = []
    for await (const ev of stream) events.push(ev)

    // cleared: last setStatus for our key is undefined, last working message restored
    const statuses = uiCalls.filter(([m]) => m === "setStatus")
    expect(statuses.at(-1)?.[2]).toBeUndefined()
    const working = uiCalls.filter(([m]) => m === "setWorkingMessage")
    expect(working.at(-1)?.[1]).toBeUndefined()
  })
})

describe("extension factory", () => {
  const sandboxPaths = () => {
    const dir = fs.mkdtempSync(path.join(UNIT_SANDBOX, "factory-"))
    return { logFile: path.join(dir, "warm.log"), lockDir: path.join(dir, "warm.lock") }
  }

  it("inactive when config missing: does not registerProvider", () => {
    const calls: unknown[] = []
    const pi = {
      registerProvider: (...args: unknown[]) => calls.push(args),
      on: () => {},
    } as unknown as ExtensionAPI

    activateExtension(pi, () => ({
      active: false,
      reason: "missing",
      warnings: [],
      sourcePath: null,
      logFile: sandboxPaths().logFile,
    }))

    expect(calls).toEqual([])
  })

  it("invalid config: does not registerProvider and logs the diagnostic (kill switch cannot fail open)", () => {
    const calls: unknown[] = []
    const { logFile } = sandboxPaths()
    const pi = {
      registerProvider: (...args: unknown[]) => calls.push(args),
      on: () => {},
      logger: { warn: () => {} },
    } as unknown as ExtensionAPI

    activateExtension(pi, () => ({
      active: false,
      reason: "invalid",
      warnings: ['lm-studio-warm is INACTIVE: enabled is "no" in /x/lm-studio-warm.yml — it must be the literal boolean true or false'],
      sourcePath: "/x/lm-studio-warm.yml",
      logFile,
    }))

    expect(calls).toEqual([])
    const logged = fs.readFileSync(logFile, "utf8")
    expect(logged).toContain("INACTIVE")
    expect(logged).toContain("inactive: invalid")
  })

  it("disabled config: the notice lands in the configured logFile, not a HOME-derived default", () => {
    const { logFile } = sandboxPaths()
    const pi = {
      registerProvider: () => {},
      on: () => {},
    } as unknown as ExtensionAPI

    activateExtension(pi, () => ({
      active: false,
      reason: "disabled",
      warnings: [],
      sourcePath: "/x/lm-studio-warm.yml",
      logFile,
    }))

    expect(fs.readFileSync(logFile, "utf8")).toContain("inactive: disabled")
  })

  it("active config registers lm-studio with api lm-studio-warm and streamSimple", () => {
    const regs: Array<{ name: string; config: Record<string, unknown> }> = []
    const events: string[] = []
    const { logFile, lockDir } = sandboxPaths()

    const pi = {
      registerProvider: (name: string, config: Record<string, unknown>) => regs.push({ name, config }),
      on: (event: string) => events.push(event),
    } as unknown as ExtensionAPI

    activateExtension(pi, () => ({
      active: true,
      sourcePath: "/tmp/lm-studio-warm.yml",
      warnings: [],
      opts: resolveOptions({}, { eager: true, baseURL: "http://127.0.0.1:1234/v1", logFile, lockDir }),
    }))

    expect(regs).toHaveLength(1)
    expect(regs[0]?.name).toBe("lm-studio")
    expect(regs[0]?.config.api).toBe("lm-studio-warm")
    expect(typeof regs[0]?.config.streamSimple).toBe("function")
    expect(typeof regs[0]?.config.fetchDynamicModels).toBe("function")
    expect(events).toEqual(expect.arrayContaining(["session_start", "session_shutdown"]))
  })
})
