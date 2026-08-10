import { execFile, type ExecFileOptionsWithBufferEncoding } from "node:child_process"

import { decodeProcessOutput, parseLmsJsonArray, type LmsInstance } from "./pure"

export type RunResult = {
  ok: boolean
  timedOut: boolean
  stdout: string
  stderr: string
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
        resolve({
          ok: !err,
          timedOut: Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed),
          stdout: decodeProcessOutput(stdout),
          stderr: decodeProcessOutput(stderr),
        })
      })
    })
  }
}

export function createLmsClient(
  lmsPath: string,
  run: Runner,
  log: (msg: string) => void = () => {},
) {
  const lms = (args: string[], timeoutMs: number) => run(lmsPath, args, timeoutMs)

  async function psInstances(): Promise<LmsInstance[] | null> {
    const res = await lms(["ps", "--json"], 15_000)
    if (!res.ok) {
      log(`lms ps failed: ${res.stderr.trim().slice(0, 300)}`)
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
      log(`lms ls failed: ${res.stderr.trim().slice(0, 200)}`)
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

  return { lms, psInstances, lsModels }
}
