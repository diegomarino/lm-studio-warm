import * as os from "node:os"
import * as path from "node:path"

import { loadConfigFrom, type ConfigLoadResult, type RuntimeProfile } from "lm-studio-warm-core"

/**
 * opencode's runtime profile — the opencode-shaped defaults for this package.
 *
 * NOTE the two config filenames: the new canonical `lm-studio-warm.json` is
 * probed first, and the legacy `lmstudio-warm.json` second, so an existing
 * install's tuning file keeps working after the rename.
 *
 * `envBaseUrl: false` and no notify UI are deliberate opencode host semantics:
 * opencode gates through `chat.params` and surfaces plugin stderr in its logs,
 * so the visible inactive-notice is a `console.error`, not a UI toast.
 */
export const OPENCODE_PROFILE: RuntimeProfile = {
  runtime: "opencode",
  providers: ["lmstudio"],
  logFile: "~/.cache/opencode/lm-studio-warm.log",
  envBaseUrl: false,
  configNames: ["lm-studio-warm.json", "lmstudio-warm.json"],
}

/**
 * Load opencode's config from `~/.config/opencode/`, returning the shared
 * two-tier {@link ConfigLoadResult}. Callers of the plugin factory treat a
 * `missing` result as ACTIVE-with-defaults (opencode's published contract),
 * which differs from omp/pi where missing means a silent no-op.
 */
export function loadOpencodeConfig(options?: {
  home?: string
  env?: NodeJS.ProcessEnv
  readFile?: (p: string) => string
}): ConfigLoadResult {
  const home = options?.home ?? process.env.HOME ?? os.homedir()
  return loadConfigFrom({
    candidateDirs: [path.join(home, ".config/opencode")],
    profile: OPENCODE_PROFILE,
    home,
    env: options?.env,
    readFile: options?.readFile,
  })
}
