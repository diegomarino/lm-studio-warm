import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent"
import { fetchLmStudioModels } from "lm-studio-warm-core"

export async function fetchLmStudioWarmModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelConfig[]> {
  const records = await fetchLmStudioModels(baseUrl, apiKey, fetchImpl)
  return records.map((m) => ({
    id: m.id,
    name: m.id,
    api: "lm-studio-warm",
    reasoning: false,
    input: m.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }))
}
