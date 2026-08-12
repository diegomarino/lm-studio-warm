import {
  createAssistantMessageEventStream,
  streamOpenAICompletions,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai"
import { createProviderErrorMessage } from "@oh-my-pi/pi-ai/providers/error-message"

import { shouldFailRequest, type WarmOptions, type WarmResult } from "lm-studio-warm-core"

type OpenAIOptions = Parameters<typeof streamOpenAICompletions>[2]

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
  streamCompletions?: (
    model: Model<"openai-completions">,
    context: Context,
    options?: OpenAIOptions,
  ) => AssistantMessageEventStream
}

export function createGatedStreamFn(deps: GatedStreamDeps): (
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  const streamCompletions = deps.streamCompletions ?? streamOpenAICompletions

  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const outer = createAssistantMessageEventStream()
    const openAIOptions = options as OpenAIOptions

    void (async () => {
      // A cold load can legitimately take minutes: name what is happening in
      // the status/working area for the whole pre-stream gate, and always
      // clear it before streaming (or erroring) so the message cannot stick.
      const ui = deps.getUi?.() ?? null
      const showProgress = () => {
        try {
          ui?.setStatus("lm-studio-warm", `warming ${model.id}`)
          ui?.setWorkingMessage(`lm-studio-warm: ensuring ${model.id} is loaded (a cold load can take minutes)`)
        } catch {}
      }
      const clearProgress = () => {
        try {
          ui?.setStatus("lm-studio-warm", undefined)
          ui?.setWorkingMessage()
        } catch {}
      }

      try {
        const baseURL =
          typeof model.baseUrl === "string" && model.baseUrl.startsWith("http")
            ? model.baseUrl
            : deps.baseURL

        showProgress()
        const result = await deps.warm(model.id, baseURL).finally(clearProgress)
        if (!result.ok && shouldFailRequest(deps.failMode, result)) {
          const err = new Error(
            `lm-studio-warm: cannot ensure model "${model.id}" is loaded — ${result.reason}. See ${deps.logFile}`,
          )
          outer.push({
            type: "error",
            reason: "error",
            error: createProviderErrorMessage(model, err),
          })
          return
        }

        const wireModel = {
          ...model,
          api: "openai-completions",
        } as Model<"openai-completions">

        const inner = streamCompletions(wireModel, context, openAIOptions)
        for await (const event of inner) {
          outer.push(event)
        }
      } catch (err) {
        const aborted = options?.signal?.aborted === true
        outer.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: createProviderErrorMessage(model, err),
        })
      }
    })()

    return outer
  }
}
