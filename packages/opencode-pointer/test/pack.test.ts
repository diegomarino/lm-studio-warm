import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, it, expect, beforeAll, afterAll } from "bun:test"

/**
 * Static tarball assertions (spec Testing §5). A real `bun add <tarball>`
 * pre-publish cannot resolve the unpublished `opencode-lm-studio-warm`
 * dependency from a co-installed local path — bun resolves semver ranges
 * from the registry only. So instead of an install-based test, this packs
 * the pointer package with `bun pm pack`, untars the result, and asserts
 * directly on the shipped tarball content: the things a bad `files` or
 * `exports` entry would silently break under workspace resolution but not
 * under a real npm install. The full install-and-import resolution check is
 * a mandatory post-publish step documented in RELEASING.md.
 */

const packageDir = path.join(import.meta.dir, "..")

let workDir: string
let extractedDir: string

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-pointer-pack-"))

  const pack = Bun.spawnSync({
    cmd: ["bun", "pm", "pack", "--destination", workDir],
    cwd: packageDir,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (pack.exitCode !== 0) {
    throw new Error(`bun pm pack failed (exit ${pack.exitCode}): ${pack.stderr.toString()}`)
  }

  const tarball = fs.readdirSync(workDir).find((f) => f.endsWith(".tgz"))
  if (!tarball) {
    throw new Error(`bun pm pack did not produce a .tgz in ${workDir}`)
  }
  const tarballPath = path.join(workDir, tarball)

  extractedDir = path.join(workDir, "extracted")
  fs.mkdirSync(extractedDir)
  const untar = Bun.spawnSync({
    cmd: ["tar", "-xzf", tarballPath, "-C", extractedDir],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (untar.exitCode !== 0) {
    throw new Error(`tar extraction failed (exit ${untar.exitCode}): ${untar.stderr.toString()}`)
  }
})

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe("opencode-lmstudio-warm tarball (bun pm pack)", () => {
  it("(a) ships src/index.ts that re-exports opencode-lm-studio-warm", () => {
    const indexPath = path.join(extractedDir, "package", "src", "index.ts")
    expect(fs.existsSync(indexPath)).toBe(true)
    const content = fs.readFileSync(indexPath, "utf8")
    expect(content).toMatch(/export \* from ["']opencode-lm-studio-warm["']/)
  })

  it("(b) package.json main/exports point at ./src/index.ts", () => {
    const pkgPath = path.join(extractedDir, "package", "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    expect(pkg.main).toBe("./src/index.ts")
    expect(pkg.exports?.["."]?.types).toBe("./src/index.ts")
    expect(pkg.exports?.["."]?.import).toBe("./src/index.ts")
  })

  it("(c) depends on opencode-lm-studio-warm via a real semver range, not a workspace: protocol", () => {
    const pkgPath = path.join(extractedDir, "package", "package.json")
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
    const range: string = pkg.dependencies?.["opencode-lm-studio-warm"]
    expect(range).toBeDefined()
    expect(range).not.toMatch(/^workspace:/)
    expect(range).toMatch(/^[~^>=<\d]/)
  })

  it("(d) ships README.md and LICENSE", () => {
    expect(fs.existsSync(path.join(extractedDir, "package", "README.md"))).toBe(true)
    expect(fs.existsSync(path.join(extractedDir, "package", "LICENSE"))).toBe(true)
  })
})
