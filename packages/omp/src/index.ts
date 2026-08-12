import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent"

import { appendLog, createWarmGate, summarizeWarnings, type ConfigLoadResult } from "lm-studio-warm-core"
import { loadConfig } from "./config"
import { fetchLmStudioWarmModels } from "./discover-adapter"
import { createGatedStreamFn } from "./stream"

export function activateExtension(
  pi: ExtensionAPI,
  load: () => ConfigLoadResult = loadConfig,
): void {
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
      for (const warning of loaded.warnings) {
        try {
          pi.logger.warn(`lm-studio-warm: ${warning}`)
        } catch {}
      }
      const summary = summarizeWarnings(loaded.warnings, loaded.logFile)
      pi.on("session_start", async (_event, ctx: ExtensionContext) => {
        if (ctx.hasUI) ctx.ui.notify(summary, "warning")
      })
    }
    return
  }

  const opts = loaded.opts

  for (const warning of loaded.warnings) {
    appendLog(opts.logFile, `config warning: ${warning}`)
    try {
      pi.logger.warn(`lm-studio-warm: config warning: ${warning}`)
    } catch {}
  }

  appendLog(
    opts.logFile,
    `active from ${loaded.sourcePath} (providers=${opts.providers.join(",")} failMode=${opts.failMode} eager=${opts.eager})`,
  )

  let uiCtx: ExtensionContext | null = null

  const gate = createWarmGate(opts, {
    notify: (message, type) => {
      if (uiCtx?.hasUI) uiCtx.ui.notify(message, type)
    },
  })
  const streamSimple = createGatedStreamFn({
    warm: (key, baseURL) => gate.warm(key, baseURL),
    failMode: opts.failMode,
    logFile: opts.logFile,
    baseURL: opts.baseURL,
    getUi: () => (uiCtx?.hasUI ? uiCtx.ui : null),
  })

  const apiKey = process.env.LM_STUDIO_API_KEY?.trim() || undefined

  pi.registerProvider("lm-studio", {
    baseUrl: opts.baseURL,
    api: "lm-studio-warm",
    apiKey,
    authHeader: true,
    fetchDynamicModels: (resolvedKey) =>
      fetchLmStudioWarmModels(opts.baseURL, resolvedKey ?? apiKey, fetch),
    streamSimple,
  })

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    uiCtx = ctx

    if (loaded.warnings.length > 0 && ctx.hasUI) {
      ctx.ui.notify(summarizeWarnings(loaded.warnings, opts.logFile), "warning")
    }

    if (!opts.eager) return

    const seen = new Set<string>()
    const candidates = [ctx.models.current(), ctx.models.resolve("@smol")]

    for (const model of candidates) {
      if (!model) continue
      if (!opts.providers.includes(model.provider)) continue
      if (seen.has(model.id)) continue

      seen.add(model.id)
      const baseURL =
        typeof model.baseUrl === "string" && model.baseUrl.startsWith("http") ? model.baseUrl : opts.baseURL

      appendLog(opts.logFile, `eager warm queued for ${model.id}`)
      void gate.warm(model.id, baseURL)
    }
  })

  pi.on("session_shutdown", async () => {
    gate.releaseLockIfOurs()
  })
}

export default function lmStudioWarm(pi: ExtensionAPI): void {
  activateExtension(pi, loadConfig)
}
