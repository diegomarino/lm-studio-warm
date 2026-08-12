import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createProvider } from "@earendil-works/pi-ai"

import { appendLog, createWarmGate, fetchLmStudioModels, summarizeWarnings } from "lm-studio-warm-core"
import { loadPiConfig } from "./config"
import { toPiModels } from "./models"
import { createGatedProviderStreams } from "./stream"

export async function activateExtension(pi: ExtensionAPI, load: typeof loadPiConfig = loadPiConfig): Promise<void> {
  const loaded = load()

  if (!loaded.active) {
    // Warnings are never discarded: every inactive path logs them to the
    // resolved log file (honoring a configured logFile when readable).
    for (const warning of loaded.warnings) {
      appendLog(loaded.logFile, `config warning: ${warning}`)
    }
    if (loaded.reason !== "missing") {
      appendLog(loaded.logFile, `inactive: ${loaded.reason} (${loaded.sourcePath ?? "no readable config file"})`)
    }

    // A config the user wrote but that cannot take effect (unparseable,
    // unreadable, non-boolean kill switch) is surfaced on host channels —
    // configured-and-broken must never look like not-configured. A missing
    // config (true opt-in no-op) and an honored `enabled: false` stay quiet.
    if (loaded.reason === "invalid" || loaded.reason === "unreadable") {
      const summary = summarizeWarnings(loaded.warnings, loaded.logFile)
      pi.on("session_start", async (_event, ctx: ExtensionContext) => {
        if (ctx.hasUI) ctx.ui.notify(summary, "warning")
      })
    }
    return
  }

  const opts = loaded.opts
  const warnings = loaded.warnings

  for (const warning of warnings) {
    appendLog(opts.logFile, `config warning: ${warning}`)
  }

  appendLog(
    opts.logFile,
    `active from ${loaded.sourcePath} (providers=${opts.providers.join(",")} failMode=${opts.failMode} eager=${opts.eager})`,
  )

  const apiKey = process.env.LM_STUDIO_API_KEY?.trim() || undefined

  let uiCtx: ExtensionContext | null = null

  const gate = createWarmGate(opts, {
    notify: (m, t) => {
      if (uiCtx?.hasUI) uiCtx.ui.notify(m, t)
    },
  })

  const streams = createGatedProviderStreams({
    warm: (key, baseURL) => gate.warm(key, baseURL),
    failMode: opts.failMode,
    logFile: opts.logFile,
    baseURL: opts.baseURL,
    getUi: () => (uiCtx?.hasUI ? uiCtx.ui : null),
  })

  const discover = () => fetchLmStudioModels(opts.baseURL, apiKey, fetch)
  const initial = toPiModels(await discover().catch(() => []), opts.baseURL)

  pi.registerProvider(
    createProvider({
      id: "lm-studio",
      name: "LM Studio (warm)",
      baseUrl: opts.baseURL,
      auth: {
        apiKey: {
          name: "LM Studio API key",
          resolve: async () => ({ auth: { apiKey: apiKey ?? "lm-studio" }, source: "lm-studio-warm" }),
        },
      },
      models: initial,
      // refresh replaces the dynamic overlay; baseline `models` snapshot
      // entries persist until restart (createProvider merges baseline ∪
      // dynamic overlay, so a model removed upstream is never pruned mid-session).
      fetchModels: async () => toPiModels(await discover(), opts.baseURL),
      api: streams,
    }),
  )

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    uiCtx = ctx

    if (warnings.length > 0 && ctx.hasUI) {
      ctx.ui.notify(summarizeWarnings(warnings, opts.logFile), "warning")
    }

    if (opts.eager) {
      // Stock pi has no smol/secondary role — only the current model can be
      // eagerly warmed (Spec adaptation note 3).
      const m = ctx.model
      if (m && opts.providers.includes(m.provider)) {
        const baseURL = m.baseUrl?.startsWith("http") ? m.baseUrl : opts.baseURL
        appendLog(opts.logFile, `eager warm queued for ${m.id}`)
        void gate.warm(m.id, baseURL)
      }
    }
  })

  pi.on("session_shutdown", async () => {
    gate.releaseLockIfOurs()
  })
}

export default async function lmStudioWarm(pi: ExtensionAPI): Promise<void> {
  await activateExtension(pi, loadPiConfig)
}
