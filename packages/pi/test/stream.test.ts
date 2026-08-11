import { describe, expect, it } from "bun:test"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai"

import type { WarmResult } from "lm-studio-warm-core"
import { createGatedProviderStreams, type GatedStreamDeps, type GatedStreamUi } from "../src/stream"

function fakeModel(over: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
  return {
    id: "k",
    name: "k",
    api: "openai-completions",
    provider: "lm-studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
    ...over,
  }
}

function doneMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "lm-studio",
    model: "k",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

const context: Context = { messages: [] }

function baseDeps(over: Partial<GatedStreamDeps> = {}): GatedStreamDeps {
  return {
    warm: async () => ({ ok: true, confirmed: false, reason: "" }),
    failMode: "hybrid",
    logFile: "/tmp/pi-lmswarm-stream-test.log",
    baseURL: "http://127.0.0.1:1234/v1",
    ...over,
  }
}

describe("createGatedProviderStreams", () => {
  it("returns both stream and streamSimple synchronously (not a Promise)", () => {
    const innerStream = (() => createAssistantMessageEventStream()) as GatedStreamDeps["innerStream"]
    const innerStreamSimple = (() => createAssistantMessageEventStream()) as GatedStreamDeps["innerStreamSimple"]
    const streams = createGatedProviderStreams(baseDeps({ innerStream, innerStreamSimple }))

    const ret1 = streams.stream(fakeModel(), context)
    const ret2 = streams.streamSimple(fakeModel(), context)
    expect(typeof (ret1 as { then?: unknown }).then).toBe("undefined")
    expect(typeof (ret2 as { then?: unknown }).then).toBe("undefined")
  })

  it("forwards events from the inner stream after warm resolves, in order", async () => {
    const order: string[] = []
    const warm = async () => {
      order.push("warm")
      return { ok: true, confirmed: false, reason: "" } as WarmResult
    }
    const innerStream: GatedStreamDeps["innerStream"] = ((model: Model<"openai-completions">) => {
      order.push("stream")
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        s.push({ type: "done", reason: "stop", message: { ...doneMessage(), model: model.id } })
      })
      return s
    }) as GatedStreamDeps["innerStream"]

    const streams = createGatedProviderStreams(baseDeps({ warm, innerStream }))
    const out = streams.stream(fakeModel(), context)

    const events: unknown[] = []
    for await (const ev of out) events.push(ev)

    expect(order).toEqual(["warm", "stream"])
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({ type: "done" }))
  })

  it('warm failure + failMode "closed" yields a terminal error event whose error.errorMessage contains the warm reason', async () => {
    let streamed = false
    const innerStream: GatedStreamDeps["innerStream"] = (() => {
      streamed = true
      return createAssistantMessageEventStream()
    }) as GatedStreamDeps["innerStream"]

    const streams = createGatedProviderStreams(
      baseDeps({
        warm: async () => ({ ok: false, confirmed: false, reason: "lock contention timeout" }),
        failMode: "closed",
        innerStream,
      }),
    )

    const out = streams.stream(fakeModel(), context)
    const events: unknown[] = []
    for await (const ev of out) events.push(ev)

    expect(streamed).toBe(false)
    expect(events).toHaveLength(1)
    const ev = events[0] as { type: string; reason: string; error: { errorMessage?: string } }
    expect(ev.type).toBe("error")
    expect(ev.reason).toBe("error")
    expect(ev.error.errorMessage).toContain("lock contention timeout")
  })

  it("an aborted signal produces a terminal error event with reason \"aborted\"", async () => {
    const controller = new AbortController()
    controller.abort()

    const innerStream: GatedStreamDeps["innerStream"] = (() => {
      throw new Error("boom during stream")
    }) as GatedStreamDeps["innerStream"]

    const streams = createGatedProviderStreams(baseDeps({ innerStream }))
    const out = streams.stream(fakeModel(), context, { signal: controller.signal })

    const events: unknown[] = []
    for await (const ev of out) events.push(ev)

    expect(events).toHaveLength(1)
    const ev = events[0] as { type: string; reason: string }
    expect(ev.type).toBe("error")
    expect(ev.reason).toBe("aborted")
  })

  it("calls setStatus/setWorkingMessage with the model id while warming, and clears both afterwards", async () => {
    const uiCalls: Array<[string, ...unknown[]]> = []
    const ui: GatedStreamUi = {
      setStatus: (key, text) => uiCalls.push(["setStatus", key, text]),
      setWorkingMessage: (message) => uiCalls.push(["setWorkingMessage", message]),
    }

    let release: (() => void) | undefined
    const warmStarted = new Promise<void>((r) => (release = r))
    const warm = async () => {
      await warmStarted
      return { ok: true, confirmed: false, reason: "" } as WarmResult
    }
    const innerStream: GatedStreamDeps["innerStream"] = ((model: Model<"openai-completions">) => {
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        s.push({ type: "done", reason: "stop", message: { ...doneMessage(), model: model.id } })
      })
      return s
    }) as GatedStreamDeps["innerStream"]

    const streams = createGatedProviderStreams(baseDeps({ warm, innerStream, getUi: () => ui }))
    const out = streams.stream(fakeModel({ id: "big-model" }), context)

    const deadline = Date.now() + 1_000
    while (
      !uiCalls.some(([m, , text]) => m === "setStatus" && String(text).includes("big-model")) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(uiCalls).toContainEqual(["setStatus", "lm-studio-warm", "warming big-model"])
    expect(uiCalls).toContainEqual(["setWorkingMessage", "warming big-model"])

    release?.()
    const events: unknown[] = []
    for await (const ev of out) events.push(ev)
    void events

    const statuses = uiCalls.filter(([m]) => m === "setStatus")
    expect(statuses.at(-1)).toEqual(["setStatus", "lm-studio-warm", undefined])
    const working = uiCalls.filter(([m]) => m === "setWorkingMessage")
    expect(working.at(-1)).toEqual(["setWorkingMessage", undefined])
  })
})
