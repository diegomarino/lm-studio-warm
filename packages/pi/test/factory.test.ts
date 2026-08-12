import { describe, it, expect } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { buildDefaults, resolveOptions } from "lm-studio-warm-core"
import { loadPiConfig, PI_PROFILE } from "../src/config"
import { activateExtension } from "../src/index"

// Hermetic scratch dir: no test in this file may touch real-$HOME state.
const UNIT_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lmswarm-unit-"))

const enoent = () => Object.assign(new Error("enoent"), { code: "ENOENT" })

describe("PI_PROFILE", () => {
  it("matches the pi-shaped defaults for this package", () => {
    expect(PI_PROFILE).toEqual({
      runtime: "pi",
      providers: ["lm-studio"],
      logFile: "~/.cache/pi/lm-studio-warm.log",
      envBaseUrl: true,
    })
  })
})

describe("loadPiConfig agentDir wiring", () => {
  it("probes under the injected agentDir seam instead of the real getAgentDir", () => {
    const seen: string[] = []
    const r = loadPiConfig({
      agentDir: "/custom/agent",
      home: "/h",
      env: {},
      readFile: (p) => {
        seen.push(p)
        throw enoent()
      },
    })
    expect(r.active).toBe(false)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((p) => p.startsWith("/custom/agent"))).toBe(true)
  })

  it("delegates to the real getAgentDir() when no agentDir override is given", () => {
    const seen: string[] = []
    loadPiConfig({
      home: "/h",
      env: {},
      readFile: (p) => {
        seen.push(p)
        throw enoent()
      },
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((p) => p.startsWith(getAgentDir()))).toBe(true)
  })
})

describe("extension factory", () => {
  const sandboxPaths = () => {
    const dir = fs.mkdtempSync(path.join(UNIT_SANDBOX, "factory-"))
    return { logFile: path.join(dir, "warm.log"), lockDir: path.join(dir, "warm.lock") }
  }

  it("inactive when config missing: does not register anything or touch on()", () => {
    const calls: unknown[] = []
    const onCalls: unknown[] = []
    const pi = {
      registerProvider: (...args: unknown[]) => calls.push(args),
      on: (...args: unknown[]) => onCalls.push(args),
    } as unknown as ExtensionAPI

    activateExtension(pi, () => ({
      active: false,
      reason: "missing",
      warnings: [],
      sourcePath: null,
      logFile: sandboxPaths().logFile,
    }))

    expect(calls).toEqual([])
    expect(onCalls).toEqual([])
  })

  it("invalid config: does not registerProvider and logs the diagnostic (kill switch cannot fail open)", () => {
    const calls: unknown[] = []
    const { logFile } = sandboxPaths()
    const pi = {
      registerProvider: (...args: unknown[]) => calls.push(args),
      on: () => {},
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

  it("invalid config: registers a session_start handler that notifies the UI with a summary containing INACTIVE", async () => {
    const { logFile } = sandboxPaths()
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {}
    const pi = {
      registerProvider: () => {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[event] = handler
      },
    } as unknown as ExtensionAPI

    activateExtension(pi, () => ({
      active: false,
      reason: "invalid",
      warnings: ['lm-studio-warm is INACTIVE: /x/lm-studio-warm.yml could not be parsed — fix the file (or delete it) to choose between enabled and disabled'],
      sourcePath: "/x/lm-studio-warm.yml",
      logFile,
    }))

    expect(typeof handlers.session_start).toBe("function")

    const notifications: Array<[string, string | undefined]> = []
    await handlers.session_start?.({}, {
      hasUI: true,
      ui: { notify: (message: string, type?: string) => notifications.push([message, type]) },
    })

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.[0]).toContain("INACTIVE")
    expect(notifications[0]?.[1]).toBe("warning")
  })

  it("invalid config: the session_start handler stays quiet when ctx.hasUI is false", async () => {
    const { logFile } = sandboxPaths()
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {}
    const pi = {
      registerProvider: () => {},
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers[event] = handler
      },
    } as unknown as ExtensionAPI

    activateExtension(pi, () => ({
      active: false,
      reason: "unreadable",
      warnings: ["lm-studio-warm is INACTIVE: config file /x/lm-studio-warm.yml exists but could not be read — check its permissions"],
      sourcePath: null,
      logFile,
    }))

    const notifications: unknown[] = []
    await handlers.session_start?.({}, {
      hasUI: false,
      ui: { notify: (...args: unknown[]) => notifications.push(args) },
    })

    expect(notifications).toEqual([])
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

  it("disabled config: does not registerProvider or register a session_start handler", () => {
    const calls: unknown[] = []
    const onCalls: unknown[] = []
    const { logFile } = sandboxPaths()
    const pi = {
      registerProvider: (...args: unknown[]) => calls.push(args),
      on: (...args: unknown[]) => onCalls.push(args),
    } as unknown as ExtensionAPI

    activateExtension(pi, () => ({
      active: false,
      reason: "disabled",
      warnings: [],
      sourcePath: "/x/lm-studio-warm.yml",
      logFile,
    }))

    expect(calls).toEqual([])
    expect(onCalls).toEqual([])
  })

  // Full coverage of the active path (registerProvider shape, discovery,
  // eager warm, lock release) lives in provider.test.ts, which sets up a
  // real loopback HTTP server + fake lms binary. This is a lightweight
  // smoke test that the active path reaches registerProvider/on at all.
  it("active config: registers the lm-studio provider and session handlers (real wiring, not the earlier stub)", async () => {
    const calls: unknown[] = []
    const onCalls: string[] = []
    const { logFile, lockDir } = sandboxPaths()

    const pi = {
      registerProvider: (...args: unknown[]) => calls.push(args),
      on: (event: string) => onCalls.push(event),
    } as unknown as ExtensionAPI

    // Deliberately unreachable loopback port (discard, RFC 863): discovery
    // fails fast and falls back to an empty model list without depending on
    // any real LM Studio instance on the host.
    await activateExtension(pi, () => ({
      active: true,
      sourcePath: "/tmp/lm-studio-warm.yml",
      warnings: [],
      opts: resolveOptions(buildDefaults(PI_PROFILE), {}, { eager: true, baseURL: "http://127.0.0.1:9/v1", logFile, lockDir }),
    }))

    expect(calls).toHaveLength(1)
    expect((calls[0] as [{ id: string }])[0].id).toBe("lm-studio")
    expect(onCalls).toEqual(["session_start", "session_shutdown"])
    expect(fs.readFileSync(logFile, "utf8")).toContain("active from /tmp/lm-studio-warm.yml")
  })
})
