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
