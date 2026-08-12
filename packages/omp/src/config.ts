import { getAgentDir } from "@oh-my-pi/pi-coding-agent"
import { loadConfigFrom, type ConfigLoadResult, type RuntimeProfile } from "lm-studio-warm-core"

/** omp's runtime profile: the omp-shaped defaults this package used to bake into core. */
export const OMP_PROFILE: RuntimeProfile = {
  runtime: "omp",
  providers: ["lm-studio"],
  logFile: "~/.cache/omp/lm-studio-warm.log",
  envBaseUrl: true,
}

export function loadConfig(options?: {
  home?: string
  env?: NodeJS.ProcessEnv
  readFile?: (p: string) => string
  /** Test seam: overrides the real `getAgentDir()` lookup. */
  agentDir?: string
}): ConfigLoadResult {
  const { agentDir, ...rest } = options ?? {}
  return loadConfigFrom({
    candidateDirs: [agentDir ?? getAgentDir()],
    profile: OMP_PROFILE,
    ...rest,
  })
}
