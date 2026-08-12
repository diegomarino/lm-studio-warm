import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { RuntimeProfile } from "./profile"

export type PerModel = { ttlSeconds?: number; parallel?: number; contextLength?: number }

export type WarmOptions = {
  enabled: boolean
  providers: string[]
  lmsPath: string
  baseURL: string
  ttlSeconds: number
  parallel: number
  contextLength: number
  perModel: Record<string, PerModel>
  verifyCacheMs: number
  retryCooldownMs: number
  loadTimeoutMs: number
  serverStartTimeoutMs: number
  lockWaitTimeoutMs: number
  failMode: "open" | "closed" | "hybrid"
  reconcileDuplicates: boolean
  launchAppFallback: boolean
  eager: boolean
  evictOnPressure: boolean
  ramBudgetMB: number
  evictHeadroomMB: number
  evictProtect: string[]
  evictMaxVictims: number
  logFile: string
  lockDir: string
}

export type LmsInstance = {
  modelKey?: string
  identifier?: string
  status?: string
  ttlMs?: number | null
  parallel?: number
  queued?: number
  /** On-disk weight size (bytes) as reported by `lms ps`/`lms ls`. */
  sizeBytes?: number
  /** Epoch ms of last use — the LRU signal for eviction. */
  lastUsedTime?: number
}

/** Warm outcome. `confirmed` marks a definitive failure (vs. ambiguity). */
export type WarmResult = { ok: boolean; confirmed: boolean; reason: string }

export type PsCheck =
  | { state: "unknown" }
  | { state: "addressable" }
  | { state: "absent" }
  | { state: "duplicates"; dups: LmsInstance[]; busy: boolean }

export type EvictionPlan = { victims: LmsInstance[]; fitsAfter: boolean }

export const RAM_BUDGET_AUTO_FRACTION = 0.9
export const BYTES_PER_MB = 1024 * 1024
/** evictHeadroomMB's built-in default — shared with the "still at default" heuristic in warm-gate. */
export const DEFAULT_EVICT_HEADROOM_MB = 4096

export const OK: WarmResult = { ok: true, confirmed: false, reason: "" }

/** Expand a leading `~` (or `~/...`) against `home`; any other path passes through unchanged. */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home
  if (p.startsWith("~/")) return path.join(home, p.slice(2))
  return p
}

/**
 * Build the runtime+host-specific defaults. Computed lazily from the passed
 * `home` — never from a module-load `os.homedir()` capture, so tests (and
 * hosts) can inject a hermetic home without mutating process.env.HOME.
 *
 * `lockDir` is intentionally the same across every profile: the lock is a
 * cross-runtime resource (one physical LM Studio instance), so every wiring
 * package must contend on the same path regardless of `runtime`.
 */
export function buildDefaults(profile: RuntimeProfile, home: string = os.homedir()): WarmOptions {
  const bundledLms = path.join(home, ".lmstudio/bin/lms")
  return {
    enabled: true,
    providers: [...profile.providers],
    lmsPath: fs.existsSync(bundledLms) ? bundledLms : "lms",
    baseURL: "http://127.0.0.1:1234/v1",
    ttlSeconds: 0,
    parallel: 0,
    contextLength: 0,
    perModel: {},
    verifyCacheMs: 30_000,
    retryCooldownMs: 60_000,
    loadTimeoutMs: 900_000,
    serverStartTimeoutMs: 90_000,
    lockWaitTimeoutMs: 1_200_000,
    failMode: "hybrid",
    reconcileDuplicates: true,
    launchAppFallback: true,
    eager: true,
    evictOnPressure: false,
    ramBudgetMB: 0,
    evictHeadroomMB: DEFAULT_EVICT_HEADROOM_MB,
    evictProtect: [],
    evictMaxVictims: 8,
    logFile: expandHome(profile.logFile, home),
    lockDir: path.join(home, ".cache/lm-studio-warm/lock"),
  }
}

/** Merge config in precedence order: defaults < file options < plugin options. */
export function resolveOptions(
  defaults: WarmOptions,
  fileOpts: Partial<WarmOptions>,
  pluginOpts?: Partial<WarmOptions> | null,
): WarmOptions {
  return { ...defaults, ...fileOpts, ...(pluginOpts ?? {}) }
}

/** Keys in a raw options object that the plugin does not know. */
export function unknownOptionKeys(raw: Record<string, unknown>, defaults: WarmOptions): string[] {
  return Object.keys(raw).filter((k) => !(k in defaults))
}

const NUMERIC_KEYS = [
  "ttlSeconds",
  "parallel",
  "contextLength",
  "verifyCacheMs",
  "retryCooldownMs",
  "loadTimeoutMs",
  "serverStartTimeoutMs",
  "lockWaitTimeoutMs",
  "ramBudgetMB",
  "evictHeadroomMB",
  "evictMaxVictims",
] as const

const BOOLEAN_KEYS = ["enabled", "reconcileDuplicates", "launchAppFallback", "eager", "evictOnPressure"] as const
const STRING_KEYS = ["lmsPath", "baseURL", "logFile", "lockDir"] as const

/** Repair invalid option VALUES back to `defaults`, collecting one warning per repair. */
export function sanitizeOptions(o: WarmOptions, defaults: WarmOptions): { opts: WarmOptions; warnings: string[] } {
  const warnings: string[] = []
  const out: WarmOptions = { ...o }
  const fix = (key: keyof WarmOptions, why: string) => {
    warnings.push(`${key} ${why} — using default ${JSON.stringify(defaults[key])}`)
    ;(out as Record<string, unknown>)[key] = defaults[key]
  }

  if (!["open", "closed", "hybrid"].includes(out.failMode)) fix("failMode", `"${out.failMode}" is not open|closed|hybrid`)
  if (!Array.isArray(out.providers) || out.providers.length === 0 || out.providers.some((p) => typeof p !== "string" || p === ""))
    fix("providers", "must be a non-empty array of non-empty strings")

  for (const k of NUMERIC_KEYS) if (typeof out[k] !== "number" || !Number.isFinite(out[k]) || out[k] < 0) fix(k, "must be a non-negative number")
  for (const k of BOOLEAN_KEYS) if (typeof out[k] !== "boolean") fix(k, "must be a boolean")
  for (const k of STRING_KEYS) if (typeof out[k] !== "string" || out[k] === "") fix(k, "must be a non-empty string")

  if (out.perModel === null || typeof out.perModel !== "object" || Array.isArray(out.perModel)) fix("perModel", "must be an object")
  else out.perModel = sanitizePerModel(out.perModel, warnings)

  if (!Array.isArray(out.evictProtect) || out.evictProtect.some((p) => typeof p !== "string"))
    fix("evictProtect", "must be a string array")

  return { opts: out, warnings }
}

const PER_MODEL_FIELDS = ["ttlSeconds", "parallel", "contextLength"] as const

function sanitizePerModel(perModel: Record<string, PerModel>, warnings: string[]): Record<string, PerModel> {
  const cleaned: Record<string, PerModel> = {}
  for (const [key, per] of Object.entries(perModel)) {
    if (per === null || typeof per !== "object" || Array.isArray(per)) {
      warnings.push(`perModel["${key}"] must be an object — ignoring the entry`)
      continue
    }
    const entry: PerModel = {}
    for (const [field, value] of Object.entries(per)) {
      if (!PER_MODEL_FIELDS.includes(field as (typeof PER_MODEL_FIELDS)[number])) {
        warnings.push(`perModel["${key}"] has unknown field "${field}" — ignoring it`)
        continue
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        warnings.push(`perModel["${key}"].${field} must be a non-negative number — ignoring it`)
        continue
      }
      entry[field as (typeof PER_MODEL_FIELDS)[number]] = value
    }
    cleaned[key] = entry
  }
  return cleaned
}

/** Addressable when an instance identifier equals the bare key. */
export function addressable(instances: LmsInstance[], key: string): boolean {
  return Array.isArray(instances) && instances.some((i) => i?.identifier === key)
}

/** Classify `lms ps` output for a key. */
export function classifyPs(instances: LmsInstance[] | null, key: string): PsCheck {
  if (!Array.isArray(instances)) return { state: "unknown" }
  if (addressable(instances, key)) return { state: "addressable" }

  const dups = instances.filter((i) => i?.modelKey === key)
  if (dups.length === 0) return { state: "absent" }

  const busy = dups.some((i) => i.status === "generating" || (i.queued ?? 0) > 0)
  return { state: "duplicates", dups, busy }
}


/** Parse `lms … --json` stdout into an array, leniently. */
export function parseLmsJsonArray(stdout: string, unwrapKeys: string[] = []): unknown[] | null {
  if (typeof stdout !== "string") return null
  const cleaned = stdout.replace(/^\uFEFF/, "").trim()
  if (cleaned === "") return null

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }

  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === "object") {
    for (const k of unwrapKeys) {
      const v = (parsed as Record<string, unknown>)[k]
      if (Array.isArray(v)) return v
    }
  }
  return null
}

/** Decode child process output bytes, honoring UTF-16 BOM variants. */
export function decodeProcessOutput(out: Buffer | string): string {
  if (typeof out === "string") return out
  if (out.length >= 2 && out[0] === 0xff && out[1] === 0xfe) return out.toString("utf16le")
  if (out.length >= 2 && out[0] === 0xfe && out[1] === 0xff && out.length % 2 === 0) {
    const swapped = Buffer.from(out)
    swapped.swap16()
    return swapped.toString("utf16le")
  }
  return out.toString("utf8")
}

/** Split `provider/key` on first slash, preserving slashed key tails. */
export function parseModelRef(ref: unknown): { providerID: string; key: string } | null {
  if (typeof ref !== "string" || !ref.includes("/")) return null
  const slash = ref.indexOf("/")
  return { providerID: ref.slice(0, slash), key: ref.slice(slash + 1) }
}

/** Build `lms load` argv for a key. */
export function loadArgs(opts: WarmOptions, key: string): string[] {
  const per = opts.perModel[key] ?? {}
  const ttl = per.ttlSeconds ?? opts.ttlSeconds
  const parallel = per.parallel ?? opts.parallel
  const ctx = per.contextLength ?? opts.contextLength

  const args = ["load", key, "-y"]
  if (ttl > 0) args.push("--ttl", String(ttl))
  if (parallel > 0) args.push("--parallel", String(parallel))
  if (ctx > 0) args.push("--context-length", String(ctx))
  return args
}

/** RAM budget for eviction planning. */
export function resolveBudgetBytes(opts: WarmOptions, totalmemBytes: number): number {
  if (opts.ramBudgetMB > 0) return opts.ramBudgetMB * BYTES_PER_MB
  return Math.floor(totalmemBytes * RAM_BUDGET_AUTO_FRACTION)
}

/** The target model's on-disk weight size from `lms ls --json`. */
export function parseModelSize(lsArray: Array<{ modelKey?: string; sizeBytes?: number }> | null, key: string): number | null {
  if (lsArray === null) return null
  const hit = lsArray.find((m) => m.modelKey === key)
  return typeof hit?.sizeBytes === "number" ? hit.sizeBytes : null
}

/** Safe LRU victims list for eviction. */
export function evictionCandidates(instances: LmsInstance[], targetKey: string, protect: string[]): LmsInstance[] {
  if (!Array.isArray(instances)) return []
  return instances
    .filter(
      (i) =>
        typeof i.identifier === "string" &&
        i.identifier !== targetKey &&
        i.modelKey !== targetKey &&
        i.status !== "generating" &&
        (i.queued ?? 0) === 0 &&
        !protect.includes(i.identifier) &&
        !protect.includes(i.modelKey ?? ""),
    )
    .sort((a, b) => (a.lastUsedTime ?? 0) - (b.lastUsedTime ?? 0))
}

/** Decide which idle instances to unload so the target fits under budget. */
export function planEviction(p: {
  instances: LmsInstance[]
  targetKey: string
  targetSizeBytes: number
  budgetBytes: number
  headroomBytes: number
  protect: string[]
}): EvictionPlan {
  const currentUsage = p.instances.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0)
  const needed = p.targetSizeBytes + p.headroomBytes
  let available = p.budgetBytes - currentUsage

  if (available >= needed) return { victims: [], fitsAfter: true }

  const victims: LmsInstance[] = []
  for (const c of evictionCandidates(p.instances, p.targetKey, p.protect)) {
    victims.push(c)
    available += c.sizeBytes ?? 0
    if (available >= needed) break
  }

  return { victims, fitsAfter: available >= needed }
}

/** RAM-pressure error heuristic. */
export function isMemoryPressureError(text: string): boolean {
  const s = text.toLowerCase()
  if (s.includes("guardrail")) return true
  if (s.includes("out of memory") || /\boom\b/.test(s)) return true
  if (/not enough|insufficient/.test(s) && /\b(memory|ram|vram)\b/.test(s)) return true
  return false
}

/** Is a process alive? */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM"
  }
}

/** Parse pid from lock-file text. */
export function parseLockPid(content: string | null): number | null {
  if (content == null) return null
  const n = Number.parseInt(content.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Parse the holder-recorded deadline (decimal epoch-ms) from lock-file text. */
export function parseLockDeadline(content: string | null): number | null {
  if (content == null) return null
  const n = Number.parseInt(content.trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Given outcome and failMode, should request fail? */
export function shouldFailRequest(failMode: WarmOptions["failMode"], result: WarmResult): boolean {
  if (result.ok) return false
  return failMode === "closed" || (failMode === "hybrid" && result.confirmed)
}
