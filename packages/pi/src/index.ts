import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

import { appendLog } from "lm-studio-warm-core"
import { loadPiConfig } from "./config"

/** One user-facing line for a batch of config warnings; the first names its file. */
function summarizeWarnings(warnings: string[], logFile: string): string {
  const headline = warnings.find((w) => w.includes("INACTIVE")) ?? warnings[0] ?? ""
  const prefixed = headline.startsWith("lm-studio-warm") ? headline : `lm-studio-warm: ${headline}`
  const rest = warnings.length - 1
  return `${prefixed}${rest > 0 ? ` (+${rest} more — see ${logFile})` : ""}`
}

export function activateExtension(pi: ExtensionAPI, load: typeof loadPiConfig = loadPiConfig): void {
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

  for (const warning of loaded.warnings) {
    appendLog(opts.logFile, `config warning: ${warning}`)
  }

  // Stub: provider registration, gated streams, eager warm and session
  // events land in the next commit — this task only wires the inactive
  // paths, so an active config is acknowledged with a single log line and
  // otherwise left untouched.
  appendLog(opts.logFile, "active: provider registration lands in the next commit")
}

export default async function lmStudioWarm(pi: ExtensionAPI): Promise<void> {
  activateExtension(pi, loadPiConfig)
}
