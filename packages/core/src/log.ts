import * as fs from "node:fs"
import * as path from "node:path"

/** Append a timestamped, pid-tagged line to `logFile`, creating its parent directory as needed. Never throws. */
export function appendLog(logFile: string, msg: string): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`)
  } catch {
    // ignore
  }
}

/** One user-facing line for a batch of config warnings; the first names its file. */
export function summarizeWarnings(warnings: string[], logFile: string): string {
  const headline = warnings.find((w) => w.includes("INACTIVE")) ?? warnings[0] ?? ""
  const prefixed = headline.startsWith("lm-studio-warm") ? headline : `lm-studio-warm: ${headline}`
  const rest = warnings.length - 1
  return `${prefixed}${rest > 0 ? ` (+${rest} more — see ${logFile})` : ""}`
}
