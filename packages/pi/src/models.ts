import type { Model } from "@earendil-works/pi-ai"
import type { WarmModelRecord } from "lm-studio-warm-core"

/** Map core's provider-agnostic model records onto pi's openai-completions Model shape. */
export function toPiModels(records: WarmModelRecord[], baseUrl: string): Model<"openai-completions">[] {
  return records.map((m) => ({
    id: m.id,
    name: m.id,
    api: "openai-completions" as const,
    provider: "lm-studio",
    baseUrl,
    reasoning: false,
    input: m.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }))
}
