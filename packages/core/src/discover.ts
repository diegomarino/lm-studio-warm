const DEFAULT_CONTEXT = 131_072
const DEFAULT_MAX_TOKENS = 32_768

// Server-supplied ids end up in lms argv and model registries: accept a
// conservative charset and never a leading "-" (could parse as an lms flag).
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/

/** Native LM Studio metadata (GET /api/v0/models) keyed by model id. */
type NativeModelInfo = {
  type?: string
  max_context_length?: number
}

async function fetchNativeMetadata(
  root: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Map<string, NativeModelInfo>> {
  const map = new Map<string, NativeModelInfo>()
  try {
    const origin = root.replace(/\/v1$/, "")
    const res = await fetchImpl(`${origin}/api/v0/models`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return map

    const body: unknown = await res.json()
    const data =
      body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
        ? ((body as { data: unknown[] }).data)
        : []

    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue
      const { id, type, max_context_length } = entry as { id?: unknown; type?: unknown; max_context_length?: unknown }
      if (typeof id !== "string" || id.length === 0) continue
      map.set(id, {
        type: typeof type === "string" ? type : undefined,
        max_context_length:
          typeof max_context_length === "number" && Number.isFinite(max_context_length) && max_context_length > 0
            ? max_context_length
            : undefined,
      })
    }
  } catch {
    // Native endpoint unavailable (older LM Studio, remote proxy): fall back
    // to the conservative constants below.
  }
  return map
}

export type WarmModelRecord = { id: string; contextWindow: number; maxTokens: number; vision: boolean }

export async function fetchLmStudioModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<WarmModelRecord[]> {
  const root = baseUrl.replace(/\/+$/, "")
  const headers: Record<string, string> = { Accept: "application/json" }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  try {
    const [res, native] = await Promise.all([
      fetchImpl(`${root}/models`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetchNativeMetadata(root, headers, fetchImpl),
    ])

    if (!res.ok) return []

    const body: unknown = await res.json()
    const data =
      body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
        ? ((body as { data: unknown[] }).data)
        : []

    const out: WarmModelRecord[] = []
    for (const entry of data) {
      if (!entry || typeof entry !== "object") continue
      const id = (entry as { id?: unknown }).id
      if (typeof id !== "string" || id.length === 0 || !SAFE_MODEL_ID.test(id)) continue

      const info = native.get(id)
      if (info?.type === "embedding" || info?.type === "embeddings") continue

      const contextWindow = info?.max_context_length ?? DEFAULT_CONTEXT
      out.push({
        id,
        contextWindow,
        maxTokens: Math.min(DEFAULT_MAX_TOKENS, contextWindow),
        vision: info?.type === "vlm",
      })
    }

    return out
  } catch {
    return []
  }
}
