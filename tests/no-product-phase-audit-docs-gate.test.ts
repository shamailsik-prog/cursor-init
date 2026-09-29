import { execSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const GATE_SCRIPT = resolve(process.cwd(), "ci_gates/check_no_product_phase_audit_docs.sh")

function initRepo(root: string) {
  execSync("git init -b main", { cwd: root, stdio: "pipe" })
  execSync('git config user.email "gate@test.local"', { cwd: root, stdio: "pipe" })
  execSync('git config user.name "gate"', { cwd: root, stdio: "pipe" })
}

function writeFile(root: string, relativePath: string, content: string) {
  const absolutePath = join(root, relativePath)
  mkdirSync(resolve(absolutePath, ".."), { recursive: true })
  writeFileSync(absolutePath, content, "utf-8")
}

function commitAll(root: string, message: string) {
  execSync("git add -A", { cwd: root, stdio: "pipe" })
  execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: root, stdio: "pipe" })
}

function runGate(root: string, base: string, head: string) {
  return execSync(`bash "${GATE_SCRIPT}"`, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, BASE: base, HEAD: head },
  })
}

function expectGateFail(root: string, base: string, head: string) {
  let threw = false
  try {
    runGate(root, base, head)
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

describe("check_no_product_phase_audit_docs gate", () => {
  it("fails when product and audit-doc paths change together", () => {
    const root = mkdtempSync(join(tmpdir(), "no-product-audit-gate-"))
    initRepo(root)
    writeFile(root, "README.md", "seed\n")
    commitAll(root, "seed")

    writeFile(root, "app/example.ts", "export const x = 1\n")
    writeFile(root, "docs/audits/pr-example-get-529-530-audit.md", "# audit\n")
    commitAll(root, "product plus audit doc")

    expectGateFail(root, "HEAD~1", "HEAD")
  })

  it("fails when product and LEGAL_OS_PHASE_VERIFICATION change together", () => {
    const root = mkdtempSync(join(tmpdir(), "no-product-audit-gate-"))
    initRepo(root)
    writeFile(root, "README.md", "seed\n")
    commitAll(root, "seed")

    writeFile(root, "platform/foo.ts", "export const y = 2\n")
    writeFile(root, "docs/LEGAL_OS_PHASE_VERIFICATION.md", "# verify\n")
    commitAll(root, "product plus verification doc")

    expectGateFail(root, "HEAD~1", "HEAD")
  })

  it("passes for docs-only PRs", () => {
    const root = mkdtempSync(join(tmpdir(), "no-product-audit-gate-"))
    initRepo(root)
    writeFile(root, "README.md", "seed\n")
    commitAll(root, "seed")

    writeFile(root, "docs/audits/pr-example-audit.md", "# audit only\n")
    commitAll(root, "docs only")

    const out = runGate(root, "HEAD~1", "HEAD")
    expect(out).toContain("PASS")
  })

  it("passes for product-only PRs", () => {
    const root = mkdtempSync(join(tmpdir(), "no-product-audit-gate-"))
    initRepo(root)
    writeFile(root, "README.md", "seed\n")
    commitAll(root, "seed")

    writeFile(root, "tests/example.test.ts", "import { describe, it } from 'vitest'\n")
    commitAll(root, "product only")

    const out = runGate(root, "HEAD~1", "HEAD")
    expect(out).toContain("PASS")
  })
})
