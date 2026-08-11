import { execFile, type ExecFileOptionsWithBufferEncoding } from "node:child_process"

import { decodeProcessOutput, parseLmsJsonArray, type LmsInstance } from "./pure"

export type RunResult = {
  ok: boolean
  timedOut: boolean
  stdout: string
  stderr: string
  /** `err.code` from execFile (e.g. "ENOENT" when the binary does not exist). */
  errorCode?: string
  /** `err.message` from execFile — the only diagnostic when stderr is empty. */
  errorMessage?: string
}

export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>

export function createExecRunner(env: NodeJS.ProcessEnv = process.env): Runner {
  return (cmd, args, timeoutMs) => {
    const execOpts: ExecFileOptionsWithBufferEncoding = {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env,
      encoding: "buffer",
    }

    return new Promise((resolve) => {
      execFile(cmd, args, execOpts, (err, stdout, stderr) => {
        const errno = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
        resolve({
          ok: !err,
          timedOut: Boolean(errno?.killed),
          stdout: decodeProcessOutput(stdout),
          stderr: decodeProcessOutput(stderr),
          ...(errno ? { errorCode: typeof errno.code === "string" ? errno.code : undefined, errorMessage: errno.message } : {}),
        })
      })
    })
  }
}

export type LmsExecError = { code?: string; message: string }

/** One log line per failure, naming the true cause even when stderr is empty. */
function describeFailure(res: RunResult, lmsPath: string): string {
  if (res.errorCode === "ENOENT") {
    return `lms binary not found at "${lmsPath}" — install the LM Studio CLI (lms) or set lmsPath in lm-studio-warm.yml`
  }
  const detail = res.stderr.trim().slice(0, 300) || res.errorMessage?.slice(0, 300) || "no diagnostic output"
  return detail
}

export function createLmsClient(
  lmsPath: string,
  run: Runner,
  log: (msg: string) => void = () => {},
) {
  let lastError: LmsExecError | null = null

  const lms = async (args: string[], timeoutMs: number) => {
    const res = await run(lmsPath, args, timeoutMs)
    lastError = res.ok ? null : { code: res.errorCode, message: describeFailure(res, lmsPath) }
    return res
  }

  async function psInstances(): Promise<LmsInstance[] | null> {
    const res = await lms(["ps", "--json"], 15_000)
    if (!res.ok) {
      log(`lms ps failed: ${describeFailure(res, lmsPath)}`)
      return null
    }

    const parsed = parseLmsJsonArray(res.stdout, ["instances"]) as LmsInstance[] | null
    if (parsed === null) log(`lms ps output unusable (not a JSON array): ${res.stdout.slice(0, 200)}`)
    return parsed
  }

  async function lsModels(): Promise<
    Array<{
      modelKey?: string
      sizeBytes?: number
    }> | null
  > {
    const res = await lms(["ls", "--json"], 15_000)
    if (!res.ok) {
      log(`lms ls failed: ${describeFailure(res, lmsPath)}`)
      return null
    }

    const parsed = parseLmsJsonArray(res.stdout, ["models"]) as
      | Array<{
          modelKey?: string
          sizeBytes?: number
        }>
      | null
    if (parsed === null) log(`lms ls output unusable (not a JSON array): ${res.stdout.slice(0, 200)}`)
    return parsed
  }

  return {
    lms,
    psInstances,
    lsModels,
    /** Exec-level cause of the most recent failed invocation (null after success). */
    lastRunError: (): LmsExecError | null => lastError,
  }
}
