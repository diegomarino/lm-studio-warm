import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { loadConfigFrom, type ConfigLoadResult, type RuntimeProfile } from "lm-studio-warm-core"

/** pi's runtime profile: the pi-shaped defaults for this package. */
export const PI_PROFILE: RuntimeProfile = {
  runtime: "pi",
  providers: ["lm-studio"],
  logFile: "~/.cache/pi/lm-studio-warm.log",
  envBaseUrl: true,
}

export function loadPiConfig(options?: {
  home?: string
  env?: NodeJS.ProcessEnv
  readFile?: (p: string) => string
  /** Test seam: overrides the real `getAgentDir()` lookup. */
  agentDir?: string
}): ConfigLoadResult {
  const { agentDir, ...rest } = options ?? {}
  return loadConfigFrom({
    candidateDirs: [agentDir ?? getAgentDir()],
    profile: PI_PROFILE,
    ...rest,
  })
}
