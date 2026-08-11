import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Provider } from "@earendil-works/pi-ai"

import { buildDefaults, resolveOptions } from "lm-studio-warm-core"
import { PI_PROFILE } from "../src/config"
import { activateExtension } from "../src/index"

// Scriptable stand-in for the lms CLI (verbatim pattern from core's
// integration suite): state lives in state.json, invocations are appended to
// calls.log so eager-warm assertions can poll for a real "load" call.
const FAKE_LMS = `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const stateFile = path.join(__dirname, "state.json")
const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"))
const write = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2))
const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify(args) + "\\n")
;(async () => {
  const state = read()
  const cmd = args[0]
  if (cmd === "ps") {
    console.log(JSON.stringify(state.instances))
    return
  }
  if (cmd === "ls") {
    console.log(JSON.stringify(state.downloaded ?? []))
    return
  }
  if (cmd === "server") return
  if (cmd === "unload") {
    state.instances = state.instances.filter((i) => i.identifier !== args[1])
    write(state)
    return
  }
  if (cmd === "load") {
    const key = args[1]
    const already = state.instances.filter((i) => i.modelKey === key).length
    const identifier = already === 0 ? key : key + ":" + (already + 1)
    state.instances.push({ modelKey: key, identifier, status: "idle", queued: 0 })
    write(state)
    return
  }
  console.error("unknown command: " + cmd)
  process.exit(1)
})()
`

let server: http.Server
let serverURL: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.endsWith("/api/v0/models")) {
      res.writeHead(404, { "content-type": "application/json" }).end("{}")
      return
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ data: [{ id: "discovered-model" }] }),
    )
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const addr = server.address() as { port: number }
  serverURL = `http://127.0.0.1:${addr.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

type Sandbox = {
  dir: string
  logFile: string
  lockDir: string
  callsLog: string
}

function makeSandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lmswarm-provider-"))
  dirs.push(dir)
  const lmsPath = path.join(dir, "lms.cjs")
  fs.writeFileSync(lmsPath, FAKE_LMS, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ instances: [] }))
  return {
    dir,
    logFile: path.join(dir, "warm.log"),
    lockDir: path.join(dir, "warm.lock"),
    callsLog: path.join(dir, "calls.log"),
  }
}

function readCalls(sb: Sandbox): string[][] {
  try {
    return fs
      .readFileSync(sb.callsLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function makePi() {
  const providers: Provider[] = []
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {}
  const pi = {
    registerProvider: (provider: Provider) => providers.push(provider),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers[event] = handler
    },
  } as unknown as ExtensionAPI
  return { pi, providers, handlers }
}

function makeCtx(over: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    hasUI: true,
    ui: { notify: () => {}, setStatus: () => {}, setWorkingMessage: () => {} },
    model: undefined,
    ...over,
  } as unknown as ExtensionContext
}

async function activate(sb: Sandbox, opts: Partial<Parameters<typeof resolveOptions>[1]> = {}) {
  const { pi, providers, handlers } = makePi()
  const lmsPath = path.join(sb.dir, "lms.cjs")

  await activateExtension(pi, () => ({
    active: true,
    sourcePath: "/tmp/lm-studio-warm.yml",
    warnings: [],
    opts: resolveOptions(
      buildDefaults(PI_PROFILE),
      {},
      {
        lmsPath,
        baseURL: serverURL,
        logFile: sb.logFile,
        lockDir: sb.lockDir,
        providers: ["lm-studio"],
        failMode: "hybrid",
        eager: true,
        launchAppFallback: false,
        loadTimeoutMs: 10_000,
        serverStartTimeoutMs: 2_000,
        lockWaitTimeoutMs: 2_000,
        ...opts,
      },
    ),
  }))

  return { pi, providers, handlers }
}

describe("activateExtension active path (real pi-ai Provider)", () => {
  it("calls registerProvider with a Provider whose id is lm-studio", async () => {
    const sb = makeSandbox()
    const { providers } = await activate(sb)

    expect(providers).toHaveLength(1)
    expect(providers[0]?.id).toBe("lm-studio")
    expect(providers[0]?.name).toBe("LM Studio (warm)")
  })

  it("getModels() reflects discovery against the configured baseURL", async () => {
    const sb = makeSandbox()
    const { providers } = await activate(sb)

    const models = providers[0]?.getModels() ?? []
    expect(models.map((m) => m.id)).toContain("discovered-model")
    expect(models[0]?.api).toBe("openai-completions")
    expect(models[0]?.provider).toBe("lm-studio")
    expect(models[0]?.baseUrl).toBe(serverURL)
  })

  it("eager warm fires for a current model with provider lm-studio", async () => {
    const sb = makeSandbox()
    const { handlers } = await activate(sb)

    expect(typeof handlers.session_start).toBe("function")

    const ctx = makeCtx({ model: { id: "eager-model", provider: "lm-studio", baseUrl: "" } as never })
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx)

    const deadline = Date.now() + 10_000
    while (
      !readCalls(sb).some((c) => c[0] === "load" && c[1] === "eager-model") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25))
    }

    expect(readCalls(sb).some((c) => c[0] === "load" && c[1] === "eager-model")).toBe(true)
  })

  it("does not eager-warm a current model belonging to a different provider", async () => {
    const sb = makeSandbox()
    const { handlers } = await activate(sb)

    const ctx = makeCtx({ model: { id: "other-provider-model", provider: "anthropic", baseUrl: "" } as never })
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx)

    // Give any (incorrect) warm a moment to have shown up, then assert absence.
    await new Promise((r) => setTimeout(r, 200))
    expect(readCalls(sb).some((c) => c[0] === "load" && c[1] === "other-provider-model")).toBe(false)
  })

  it("session_shutdown releases a lock this process holds", async () => {
    const sb = makeSandbox()
    const { handlers } = await activate(sb, { eager: false })

    expect(typeof handlers.session_shutdown).toBe("function")

    // Simulate this process currently holding the warm-gate lock.
    fs.mkdirSync(sb.lockDir, { recursive: true })
    fs.writeFileSync(path.join(sb.lockDir, "pid"), String(process.pid))

    await handlers.session_shutdown?.({ type: "session_shutdown", reason: "quit" }, makeCtx())

    expect(fs.existsSync(sb.lockDir)).toBe(false)
  })
})
