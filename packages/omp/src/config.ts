import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { parse as parseYaml } from "yaml"
import {
  DEFAULTS,
  resolveOptions,
  sanitizeOptions,
  unknownOptionKeys,
  type WarmOptions,
} from "./pure"

/**
 * Two-tier config handling:
 *
 * - Identity tier (hard-deactivate, visible diagnostic): a file that fails to
 *   parse, a file whose top level is not an object, or an `enabled` value that
 *   is not a strict YAML/JSON boolean. YAML 1.2 (which the `yaml` package
 *   implements) parses the YAML 1.1 spellings `no`/`off`/`yes`/`on` as plain
 *   strings — those are rejected with a named error instead of being
 *   "repaired" to the default `true`, so a mistyped kill switch can never
 *   silently activate the plugin.
 * - Tuning tier (resilient): every other option keeps repair-to-default with a
 *   collected warning; warnings are surfaced by the activation layer on every
 *   path, active or not.
 */
export type ConfigLoadResult =
  | {
      active: false
      reason: "missing" | "unreadable" | "disabled" | "invalid"
      warnings: string[]
      sourcePath: string | null
      /** Where inactive-path diagnostics should be written (honors a configured logFile when one is readable). */
      logFile: string
    }
  | {
      active: true
      opts: WarmOptions
      warnings: string[]
      sourcePath: string
    }

function expandHome(p: string, home: string): string {
  if (p === "~") return home
  if (p.startsWith("~/")) return path.join(home, p.slice(2))
  return p
}

export function configCandidatePaths(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const agentDir = env.PI_CODING_AGENT_DIR
    ? expandHome(env.PI_CODING_AGENT_DIR, home)
    : path.join(home, ".omp/agent")

  return [
    path.join(agentDir, "lm-studio-warm.yml"),
    path.join(agentDir, "lm-studio-warm.yaml"),
    path.join(agentDir, "lm-studio-warm.json"),
  ]
}

export function parseConfigFile(
  content: string,
  sourcePath: string,
): { opts: Partial<WarmOptions>; warning: string | null } {
  let parsed: unknown

  try {
    if (sourcePath.endsWith(".json")) parsed = JSON.parse(content)
    else parsed = parseYaml(content)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { opts: {}, warning: `failed to parse ${sourcePath}: ${msg}` }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { opts: {}, warning: `${sourcePath} must contain a top-level object` }
  }

  return { opts: parsed as Partial<WarmOptions>, warning: null }
}

/** Best-effort logFile for inactive-path diagnostics: configured value when usable, else default. */
function inactiveLogFile(fileOpts: Partial<WarmOptions>, home: string): string {
  const configured = (fileOpts as Record<string, unknown>).logFile
  const chosen = typeof configured === "string" && configured !== "" ? configured : DEFAULTS.logFile
  return expandHome(chosen, home)
}

export function loadConfig(options?: {
  home?: string
  env?: NodeJS.ProcessEnv
  readFile?: (path: string) => string
}): ConfigLoadResult {
  const home = options?.home ?? os.homedir()
  const env = options?.env ?? process.env
  const readFile = options?.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"))

  const warnings: string[] = []
  let sourcePath: string | null = null
  let fileOpts: Partial<WarmOptions> = {}
  let firstUnreadable: string | null = null

  for (const candidate of configCandidatePaths(home, env)) {
    try {
      const content = readFile(candidate)
      sourcePath = candidate
      const parsed = parseConfigFile(content, candidate)
      if (parsed.warning) {
        // Identity tier: an unparseable config cannot express intent — deactivate loudly.
        warnings.push(parsed.warning)
        warnings.push(
          `lm-studio-warm is INACTIVE: ${candidate} could not be parsed — fix the file (or delete it) to choose between enabled and disabled`,
        )
        return { active: false, reason: "invalid", warnings, sourcePath, logFile: expandHome(DEFAULTS.logFile, home) }
      }
      fileOpts = parsed.opts
      break
    } catch (err: any) {
      if (err?.code === "ENOENT") continue

      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`failed to read ${candidate}: ${msg}`)
      firstUnreadable = firstUnreadable ?? candidate
      continue
    }
  }

  if (!sourcePath) {
    if (firstUnreadable) {
      warnings.push(
        `lm-studio-warm is INACTIVE: config file ${firstUnreadable} exists but could not be read — check its permissions`,
      )
    }
    return {
      active: false,
      reason: firstUnreadable ? "unreadable" : "missing",
      warnings,
      sourcePath,
      logFile: expandHome(DEFAULTS.logFile, home),
    }
  }

  // Identity tier: `enabled` is the kill switch — only strict booleans are accepted.
  const rawEnabled = (fileOpts as Record<string, unknown>).enabled
  if (rawEnabled !== undefined && typeof rawEnabled !== "boolean") {
    warnings.push(
      `lm-studio-warm is INACTIVE: enabled is ${JSON.stringify(rawEnabled)} in ${sourcePath} — it must be the literal boolean true or false` +
        ` (YAML 1.2 reads no/off/yes/on and quoted values as strings, not booleans)`,
    )
    return { active: false, reason: "invalid", warnings, sourcePath, logFile: inactiveLogFile(fileOpts, home) }
  }

  for (const k of unknownOptionKeys(fileOpts as Record<string, unknown>)) {
    warnings.push(`unknown option "${k}" in ${sourcePath}`)
  }

  const { opts, warnings: sanitizeWarnings } = sanitizeOptions(resolveOptions(fileOpts, null))
  warnings.push(...sanitizeWarnings)

  // Tilde in user-supplied paths is expanded, not taken literally.
  opts.lmsPath = expandHome(opts.lmsPath, home)
  opts.logFile = expandHome(opts.logFile, home)
  opts.lockDir = expandHome(opts.lockDir, home)

  if (opts.enabled === false) {
    return {
      active: false,
      reason: "disabled",
      warnings,
      sourcePath,
      logFile: opts.logFile,
    }
  }

  if (
    opts.baseURL === DEFAULTS.baseURL &&
    typeof env.LM_STUDIO_BASE_URL === "string" &&
    env.LM_STUDIO_BASE_URL.startsWith("http")
  ) {
    opts.baseURL = env.LM_STUDIO_BASE_URL
  }

  return { active: true, opts, warnings, sourcePath }
}
