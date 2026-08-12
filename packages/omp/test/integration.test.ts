import { describe, it, expect } from "bun:test"
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai"
import type { Context, Model } from "@oh-my-pi/pi-ai"

import { createGatedStreamFn } from "../src/stream"

function fakeModel(over: Partial<Model> = {}): Model {
  return {
    id: "k",
    name: "k",
    api: "lm-studio-warm",
    provider: "lm-studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
    compat: {},
    ...over,
  } as Model
}

describe("createGatedStreamFn", () => {
  it("awaits warm before calling streamCompletions", async () => {
    const order: string[] = []
    const warm = async () => {
      order.push("warm")
      return { ok: true, confirmed: false, reason: "" }
    }
    const streamCompletions = () => {
      order.push("stream")
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        const msg = {
          role: "assistant" as const,
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
          stopReason: "stop" as const,
          timestamp: Date.now(),
        }
        s.push({ type: "done", reason: "stop", message: msg as any })
      })
      return s
    }

    const fn = createGatedStreamFn({ warm, failMode: "hybrid", logFile: "/tmp/x.log", baseURL: "http://127.0.0.1:1234/v1", streamCompletions })
    const stream = fn(fakeModel(), { messages: [] } as Context)
    expect(stream).toBeTruthy()

    const events: unknown[] = []
    for await (const ev of stream) events.push(ev)

    expect(order).toEqual(["warm", "stream"])
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "done" }))
  })

  it("hybrid confirmed failure emits terminal error and never streams", async () => {
    let streamed = false

    const fn = createGatedStreamFn({
      warm: async () => ({ ok: false, confirmed: true, reason: "load failed" }),
      failMode: "hybrid",
      logFile: "/tmp/x.log",
      baseURL: "http://127.0.0.1:1234/v1",
      streamCompletions: () => {
        streamed = true
        return createAssistantMessageEventStream()
      },
    })

    const stream = fn(fakeModel(), { messages: [] } as Context)
    const events: unknown[] = []
    for await (const ev of stream) events.push(ev)

    expect(streamed).toBe(false)
    expect(events).toHaveLength(1)
    expect((events[0] as { type: string; error?: { errorMessage?: string } }).type).toBe("error")
    expect(events[0]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          errorMessage: expect.stringContaining('lm-studio-warm: cannot ensure model "k"'),
        }),
      }),
    )
  })

  it("hybrid ambiguous failure fail-opens into streamCompletions", async () => {
    let streamed = false

    const fn = createGatedStreamFn({
      warm: async () => ({ ok: false, confirmed: false, reason: "lock contention timeout" }),
      failMode: "hybrid",
      logFile: "/tmp/x.log",
      baseURL: "http://127.0.0.1:1234/v1",
      streamCompletions: () => {
        streamed = true
        const s = createAssistantMessageEventStream()
        queueMicrotask(() => {
          s.push({
            type: "done",
            reason: "stop",
            message: {
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
            } as any,
          })
        })
        return s
      },
    })

    const events: unknown[] = []
    for await (const ev of fn(fakeModel(), { messages: [] } as Context)) events.push(ev)

    expect(streamed).toBe(true)
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "done" }))
  })

  it("returns the outer stream synchronously (not a Promise)", () => {
    const fn = createGatedStreamFn({
      warm: async () => ({ ok: true, confirmed: false, reason: "" }),
      failMode: "open",
      logFile: "/tmp/x.log",
      baseURL: "http://127.0.0.1:1234/v1",
      streamCompletions: () => {
        const s = createAssistantMessageEventStream()
        queueMicrotask(() =>
          s.push({
            type: "done",
            reason: "stop",
            message: {
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
            } as any,
          }),
        )
        return s
      },
    })

    const ret = fn(fakeModel(), { messages: [] } as Context)
    expect(typeof (ret as { then?: unknown }).then).toBe("undefined")
  })
})
