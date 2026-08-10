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

export type ConfigLoadResult =
  | {
      active: false
      reason: "missing" | "disabled"
      warnings: string[]
      sourcePath: string | null
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

  for (const candidate of configCandidatePaths(home, env)) {
    try {
      const content = readFile(candidate)
      sourcePath = candidate
      const parsed = parseConfigFile(content, candidate)
      if (parsed.warning) warnings.push(parsed.warning)
      fileOpts = parsed.opts
      break
    } catch (err: any) {
      if (err?.code === "ENOENT") continue

      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`failed to read ${candidate}: ${msg}`)
      continue
    }
  }

  if (!sourcePath) {
    return {
      active: false,
      reason: "missing",
      warnings,
      sourcePath,
    }
  }

  for (const k of unknownOptionKeys(fileOpts as Record<string, unknown>)) {
    warnings.push(`unknown option "${k}" in ${sourcePath}`)
  }

  const { opts, warnings: sanitizeWarnings } = sanitizeOptions(resolveOptions(fileOpts, null))
  warnings.push(...sanitizeWarnings)

  if (opts.enabled === false) {
    return {
      active: false,
      reason: "disabled",
      warnings,
      sourcePath,
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
