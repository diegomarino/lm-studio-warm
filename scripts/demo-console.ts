#!/usr/bin/env bun
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`

function run(label: string, args: string[], env: Record<string, string> = {}) {
  const name = args[0] ?? ""
  const proc = spawnSync(name, args.slice(1), {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  })

  console.log(`\n${cyan(label)}`)
  console.log(dim(`$ ${[name, ...args.slice(1)].join(" ")}`))
  if (proc.stdout) process.stdout.write(proc.stdout)
  if (proc.stderr) process.stdout.write(proc.stderr)
  if ((proc.status ?? 0) !== 0) {
    throw new Error(`${label} failed (exit ${proc.status})`)
  }
}

async function main() {
  console.log(cyan("= omp-lm-studio-warm console demo"))
  console.log("")

  const emptyAgentDir = mkdtempSync(path.join(tmpdir(), "omp-lm-studio-warm-demo-no-config-"))
  const activeAgentDir = mkdtempSync(path.join(tmpdir(), "omp-lm-studio-warm-demo-active-"))

  const inactiveCmd = [
    "import f from './src/index.ts';",
    "const calls = [];",
    "const pi = { registerProvider: (...args) => calls.push(args), on: () => {} };",
    "f(pi);",
    "if (calls.length !== 0) throw new Error(`registered while inactive (${calls.length})`);",
    "console.log('inactive ok');",
  ].join(" ")

  // The demo keeps its log and lock inside its own temp dir: it must never
  // touch the real ~/.cache/omp state.
  const demoLogFile = path.join(activeAgentDir, "demo-warm.log")
  const demoLockDir = path.join(activeAgentDir, "demo-warm.lock")

  const activeConfig = [
    "eager: false",
    "failMode: hybrid",
    'providers: ["lm-studio"]',
    "# only for this demo",
    'baseURL: "http://127.0.0.1:1234/v1"',
    "ttlSeconds: 0",
    "verifyCacheMs: 30000",
    `logFile: ${JSON.stringify(demoLogFile)}`,
    `lockDir: ${JSON.stringify(demoLockDir)}`,
    "",
  ].join("\n")

  writeFileSync(path.join(activeAgentDir, "lm-studio-warm.yml"), activeConfig, "utf8")

  const activeCmd = [
    "import f from './src/index.ts';",
    "import { loadConfig } from './src/config.ts';",
    // The demo pins what it shows: the loaded options must equal the config it
    // wrote, or the run fails (a parse failure can no longer masquerade as ok).
    "const r = loadConfig();",
    "if (!r.active) throw new Error('demo config did not activate: ' + JSON.stringify(r));",
    "if (r.warnings.length > 0) throw new Error('demo config produced warnings: ' + r.warnings.join('; '));",
    "if (r.opts.eager !== false) throw new Error('demo config was not applied: eager=' + r.opts.eager);",
    `if (r.opts.logFile !== ${JSON.stringify(demoLogFile)}) throw new Error('demo logFile not applied: ' + r.opts.logFile);`,
    "const calls = [];",
    "const events = [];",
    "const pi = {",
    "  registerProvider: (name, config) => calls.push({ name, config }),",
    "  on: (event) => events.push(event)",
    "};",
    "f(pi);",
    "if (calls.length === 0) throw new Error('did not register');",
    "const cfg = calls[0]?.config ?? {};",
    "console.log(JSON.stringify({ provider: calls[0]?.name, api: cfg.api, eager: r.opts.eager, hooks: events }));",
  ].join(" ")

  try {
    run(
      "1) Inactive mode (no config file): should not register provider",
      ["bun", "-e", inactiveCmd],
      { PI_CODING_AGENT_DIR: emptyAgentDir },
    )

    run(
      "2) Active mode: provider re-homed to api=lm-studio-warm",
      ["bun", "-e", activeCmd],
      { PI_CODING_AGENT_DIR: activeAgentDir },
    )

    run(
      "3) Focused integration test: gated stream order/fail-open path",
      [
        "bun",
        "test",
        "test/integration.test.ts",
        "-t",
        "awaits warm before calling streamCompletions",
      ],
      {
        PI_CODING_AGENT_DIR: activeAgentDir,
      },
    )

    console.log(`\n${green("✓ Demo run complete")}`)
    console.log("")
    console.log(cyan("What to do next:"))
    console.log("  - rerun active config check with your real ~/.omp/agent/lm-studio-warm.yml")
    console.log("  - open the configured logFile (default `~/.cache/omp/lm-studio-warm.log`) and inspect warm activity")
  } finally {
    rmSync(emptyAgentDir, { recursive: true, force: true })
    rmSync(activeAgentDir, { recursive: true, force: true })
  }
}

await main()
