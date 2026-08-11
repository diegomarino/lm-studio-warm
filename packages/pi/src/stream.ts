import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type StreamOptions,
} from "@earendil-works/pi-ai"
import { stream as openAIStream, streamSimple as openAIStreamSimple } from "@earendil-works/pi-ai/api/openai-completions"

import { appendLog, shouldFailRequest, type WarmOptions, type WarmResult } from "lm-studio-warm-core"

/** Minimal slice of the host's ExtensionUIContext the gate needs for progress. */
export type GatedStreamUi = {
  setStatus(key: string, text: string | undefined): void
  setWorkingMessage(message?: string): void
}

export type GatedStreamDeps = {
  warm: (key: string, baseURL: string) => Promise<WarmResult>
  failMode: WarmOptions["failMode"]
  logFile: string
  /** Configured baseURL — the warm-target fallback when the model record has none. */
  baseURL: string
  /** Session UI accessor (null when no UI is available yet). */
  getUi?: () => GatedStreamUi | null
  /** Test seams — default to the real openai-completions API implementation. */
  innerStream?: typeof openAIStream
  innerStreamSimple?: typeof openAIStreamSimple
}

/** Hand-built terminal AssistantMessage for a warm failure — pi-ai has no error-message helper. */
function warmFailureMessage(model: Model<"openai-completions">, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: text,
    timestamp: Date.now(),
  }
}

/**
 * Wraps pi-ai's openai-completions `stream`/`streamSimple` with the same
 * warm-gate pattern as omp's `createGatedStreamFn`, generalized to produce
 * both `ProviderStreams` members from one gate.
 */
export function createGatedProviderStreams(deps: GatedStreamDeps): ProviderStreams {
  const gate = <TOpts extends StreamOptions>(
    inner: (model: Model<"openai-completions">, context: Context, options?: TOpts) => AssistantMessageEventStream,
  ) =>
    (model: Model<"openai-completions">, context: Context, options?: TOpts): AssistantMessageEventStream => {
      const outer = createAssistantMessageEventStream()

      void (async () => {
        // A cold load can legitimately take minutes: name what is happening in
        // the status/working area for the whole pre-stream gate, and always
        // clear it before streaming (or erroring) so the message cannot stick.
        const ui = deps.getUi?.() ?? null
        const showProgress = () => {
          ui?.setStatus("lm-studio-warm", `warming ${model.id}`)
          ui?.setWorkingMessage(`warming ${model.id}`)
        }
        const clearProgress = () => {
          ui?.setStatus("lm-studio-warm", undefined)
          ui?.setWorkingMessage()
        }

        try {
          const baseURL = model.baseUrl.startsWith("http") ? model.baseUrl : deps.baseURL
          showProgress()
          const result = await deps.warm(model.id, baseURL).finally(clearProgress)
          if (!result.ok && shouldFailRequest(deps.failMode, result)) {
            outer.push({
              type: "error",
              reason: "error",
              error: warmFailureMessage(model, `lm-studio-warm: ${result.reason}`),
            })
            return
          }

          for await (const event of inner(model, context, options)) outer.push(event)
        } catch (err) {
          const aborted = options?.signal?.aborted === true
          const msg = err instanceof Error ? err.message : String(err)
          appendLog(deps.logFile, `stream error (${model.id}): ${msg}`)
          outer.push({
            type: "error",
            reason: aborted ? "aborted" : "error",
            error: warmFailureMessage(model, msg),
          })
        }
      })()

      return outer
    }

  return {
    stream: gate(deps.innerStream ?? openAIStream),
    streamSimple: gate(deps.innerStreamSimple ?? openAIStreamSimple),
  }
}
