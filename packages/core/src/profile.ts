/**
 * A RuntimeProfile carries the only host-specific knowledge core needs:
 * which providers the warm gate applies to, where its log lives by default,
 * whether the host wants LM_STUDIO_BASE_URL honored, and (optionally) which
 * config filenames to probe for. Core stays ignorant of any host's env vars,
 * agent directories, or on-disk layout — every wiring package (omp, pi,
 * opencode, ...) supplies its own profile plus its own candidate directories.
 */
export type RuntimeProfile = {
  /** "omp" | "pi" | "opencode" — used only for messages/docs, never branched on. */
  runtime: string
  /** Host provider ids the warm gate applies to. */
  providers: string[]
  /** Default log path (~-relative ok). */
  logFile: string
  /** Honor LM_STUDIO_BASE_URL when baseURL is still the default. */
  envBaseUrl: boolean
  /** Candidate config filenames, in probe order. Defaults to lm-studio-warm.{yml,yaml,json}. */
  configNames?: string[]
}
