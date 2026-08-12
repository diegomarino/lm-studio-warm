/**
 * opencode-lm-studio-warm — deterministic LM Studio model pre-warm gate for
 * opencode, now a thin adapter over `lm-studio-warm-core`.
 *
 * The pure helpers, the lms client, and the audited warm gate all live in the
 * shared core; this file keeps only the opencode-specific host wiring:
 *  - the two hooks opencode awaits (`config`, `chat.params`) with their exact
 *    (undocumented) input-shape reads, verified against opencode v1.17.10;
 *  - throw-on-gate-failure in `chat.params` per `failMode` (opencode has no
 *    non-throwing way to fail a request);
 *  - contract-drift canaries (one log line when an input shape is unexpected);
 *  - a fire-and-forget eager warm of `model` + `small_model` in `config`;
 *  - two-tier config activation (missing ⇒ active with defaults — opencode's
 *    published contract; invalid/unreadable ⇒ inactive + a visible
 *    `console.error` notice; `enabled: false` ⇒ silent log-only).
 *
 * Options precedence stays DEFAULTS < config file < plugin-options tuple.
 */
import * as os from "node:os"

import type { Plugin } from "@opencode-ai/plugin"

import {
  appendLog,
  buildDefaults,
  createWarmGate,
  expandHome,
  parseModelRef,
  resolveOptions,
  sanitizeOptions,
  shouldFailRequest,
  unknownOptionKeys,
  type WarmOptions,
  type WarmResult,
} from "lm-studio-warm-core"

import { OPENCODE_PROFILE, loadOpencodeConfig } from "./config"

export { OPENCODE_PROFILE, loadOpencodeConfig } from "./config"
export type { WarmOptions, WarmResult, LmsInstance, PerModel } from "lm-studio-warm-core"

const OK: WarmResult = { ok: true, confirmed: false, reason: "" }

/** One user-facing line for a batch of config warnings; the first names its file. */
function summarizeWarnings(warnings: string[], logFile: string): string {
  const headline = warnings.find((w) => w.includes("INACTIVE")) ?? warnings[0] ?? ""
  const prefixed = headline.startsWith("lm-studio-warm") ? headline : `lm-studio-warm: ${headline}`
  const rest = warnings.length - 1
  return `${prefixed}${rest > 0 ? ` (+${rest} more — see ${logFile})` : ""}`
}

/** Hooks with no gating — returned on every inactive path so opencode loads cleanly. */
const INACTIVE_HOOKS = {}

export const LMStudioWarm: Plugin = async (_input, pluginOptions) => {
  // Prefer $HOME over os.homedir(): on POSIX they agree, but os.homedir()
  // reflects only the launch-time environment (it does not observe a later
  // process.env.HOME mutation), whereas honoring $HOME keeps the config/log/
  // lock lookup correct for a relocated home and lets the test suite isolate
  // against a scratch HOME.
  const home = process.env.HOME || os.homedir()
  const defaults = buildDefaults(OPENCODE_PROFILE, home)
  const plugOpts = (pluginOptions ?? {}) as Partial<WarmOptions>
  const loaded = loadOpencodeConfig({ home })
  const warnings = [...loaded.warnings]

  // Two-tier inactive paths. Missing is NOT inactive for opencode — it means
  // "active with pure defaults" (the published contract), handled below.
  if (!loaded.active && loaded.reason !== "missing") {
    for (const w of warnings) appendLog(loaded.logFile, `config warning: ${w}`)
    appendLog(loaded.logFile, `inactive: ${loaded.reason} (${loaded.sourcePath ?? "no readable config file"})`)
    // A config the user wrote but that cannot take effect (unparseable,
    // unreadable) is surfaced loudly — opencode has no notify UI, so its logs
    // (which capture plugin stderr) are the channel. An honored `enabled:false`
    // stays quiet: the user asked for it off.
    if (loaded.reason === "invalid" || loaded.reason === "unreadable") {
      console.error("[lm-studio-warm] " + summarizeWarnings(warnings, loaded.logFile))
    }
    return INACTIVE_HOOKS
  }

  // Active (config present + enabled) OR missing (pure defaults). Layer the
  // plugin-options tuple on top, preserving DEFAULTS < file < plugin precedence,
  // then re-sanitize so a bad plugin-supplied value is repaired + warned too.
  const base = loaded.active ? loaded.opts : defaults
  const merged = resolveOptions(base, plugOpts)
  const { opts, warnings: sanitizeWarnings } = sanitizeOptions(merged, defaults)
  warnings.push(...sanitizeWarnings)
  for (const k of unknownOptionKeys(plugOpts as Record<string, unknown>, defaults)) {
    warnings.push(`unknown option "${k}" in plugin options`)
  }

  // Expand ~ in plugin-supplied paths (file paths were expanded by the loader).
  opts.lmsPath = expandHome(opts.lmsPath, home)
  opts.logFile = expandHome(opts.logFile, home)
  opts.lockDir = expandHome(opts.lockDir, home)

  // Plugin-option kill switch (the file kill switch is handled by the loader).
  if (opts.enabled === false) {
    for (const w of warnings) appendLog(opts.logFile, `config warning: ${w}`)
    appendLog(opts.logFile, "inactive: disabled (plugin options)")
    return INACTIVE_HOOKS
  }

  for (const w of warnings) appendLog(opts.logFile, `config warning: ${w}`)

  const loggedOnce = new Set<string>()
  function logOnce(msg: string) {
    if (loggedOnce.has(msg)) return
    loggedOnce.add(msg)
    appendLog(opts.logFile, msg)
  }

  // opencode has no plugin UI channel — leave `notify` unset so core stays
  // log-only, matching the old opencode behavior (no UI side effects).
  const gate = createWarmGate(opts, {})

  appendLog(
    opts.logFile,
    `plugin loaded (providers=${opts.providers.join(",")} ttl=${opts.ttlSeconds || "none"} ` +
      `parallel=${opts.parallel || "default"} failMode=${opts.failMode} ` +
      `source=${loaded.active ? loaded.sourcePath : "defaults (no config file)"})`,
  )

  return {
    // Fires once at instance start with the resolved config. Background eager
    // warm of both pinned models — NOT awaited, so startup isn't delayed; the
    // chat.params gate below remains the deterministic barrier.
    config: async (cfg: any) => {
      if (!opts.eager) return
      const warmed = new Set<string>()
      for (const ref of [cfg?.model, cfg?.small_model]) {
        const parsed = parseModelRef(ref)
        if (!parsed || !opts.providers.includes(parsed.providerID)) continue
        if (warmed.has(parsed.key)) continue // model === small_model ⇒ warm the key once
        warmed.add(parsed.key)
        const configured = cfg?.provider?.[parsed.providerID]?.options?.baseURL
        const baseURL = typeof configured === "string" && configured.startsWith("http") ? configured : opts.baseURL
        appendLog(opts.logFile, `eager warm queued for ${parsed.key}`)
        void gate.warm(parsed.key, baseURL)
      }
    },

    // Awaited by opencode before EVERY LLM request (main and small model alike):
    // the deterministic pre-warm gate. Heals cold starts and TTL evictions.
    "chat.params": async (input: any) => {
      let result: WarmResult = OK
      let key: string | undefined
      try {
        // Contract-drift canaries: this plugin depends on undocumented input
        // shapes verified against opencode v1.17.10. If an upgrade changes
        // them the gate silently no-ops — these one-time log lines are the
        // only signal that would remain.
        const providerID: string | undefined = input?.provider?.info?.id ?? input?.model?.providerID
        if (!providerID) {
          logOnce("chat.params input carries no provider id — opencode hook shape may have changed; gate skipped")
          return
        }
        if (!opts.providers.includes(providerID)) return
        // model.api.id is the exact string opencode sends as the API `model`
        // field (== LM Studio model key for config-defined models).
        key = input?.model?.api?.id ?? input?.model?.id
        if (!key) {
          logOnce(
            `chat.params for gated provider "${providerID}" carries no model key — opencode hook shape may have changed; gate skipped`,
          )
          return
        }
        const configured = input?.provider?.options?.baseURL
        const baseURL = typeof configured === "string" && configured.startsWith("http") ? configured : opts.baseURL
        result = await gate.warm(key, baseURL)
      } catch (err) {
        appendLog(opts.logFile, `chat.params hook error: ${err instanceof Error ? err.message : String(err)}`)
        result = { ok: false, confirmed: false, reason: "hook error (see log)" }
      }
      if (result.ok) return
      if (shouldFailRequest(opts.failMode, result)) {
        throw new Error(`lmstudio-warm: cannot ensure model "${key}" is loaded — ${result.reason}. See ${opts.logFile}`)
      }
      appendLog(opts.logFile, `warm(${key}) not ensured (${result.reason}) — proceeding fail-open`)
    },
  }
}
