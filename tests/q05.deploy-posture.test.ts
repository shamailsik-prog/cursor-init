import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const REPO = process.cwd()

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8")
}

function extractAssignedRegex(source: string, name: string): RegExp {
  const match = source.match(new RegExp(`${name}='([^']*)'`))
  if (!match) throw new Error(`missing ${name}`)
  return new RegExp(match[1])
}

function postgresDdlScriptFiles(): string[] {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const script = pkg.scripts["test:postgres-ddl"]
  return script.match(/tests\/[^\s]+\.ts/g) ?? []
}

function bindMountedRepoPaths(suiteFiles: string[]): string[] {
  const found: string[] = []
  const re = /path\.join\(REPO,\s*"([^"]+)"\)/g
  for (const rel of suiteFiles) {
    const text = read(rel)
    for (const match of text.matchAll(re)) found.push(match[1])
  }
  return found
}

function annexFileLists(script: string): { loop: string[]; psql: string[] } {
  const loopMatch = script.match(/for f in ([^;]+);\s*do/)
  if (!loopMatch) throw new Error("apply-annex-a readability loop not found")
  const loop = loopMatch[1].trim().split(/\s+/)
  const psql = [...script.matchAll(/-f "\$ddl\/([^"]+)"/g)].map((m) => m[1])
  return { loop, psql }
}

function ddlMinusPlatform(): string[] {
  return fs
    .readdirSync(path.join(REPO, "postgres/ddl"))
    .filter((name) => name.endsWith(".sql") && name !== "002_platform.sql")
    .sort()
}

function nonCommentLines(text: string): string[] {
  return text.split("\n").filter((line) => {
    const trimmed = line.trim()
    return trimmed.length > 0 && !trimmed.startsWith("#")
  })
}

/**
 * Forbidden write commands (SPEC Q05 C4 runbook lint).
 * A line is a hit when it matches this pattern.
 * A hit is allowed only when the trimmed line starts with ">" or the line contains "do not"
 * (prose that says not to run the command). Every other hit fails the lint.
 * `--enabled` does not match `enable` (word-bounded). `get-iam-policy` does not match `set-iam-policy`.
 */
const FORBIDDEN_COMMAND = new RegExp(
  [
    String.raw`\bgcloud\b[^\n]*\b(?:deploy|update|delete|create|set-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|enable|disable)\b`,
    String.raw`\bfirebase\s+deploy\b`,
    String.raw`\bterraform\s+(?:apply|import|destroy)\b`,
    String.raw`\bvercel\s+(?:deploy|env\s+add|env\s+rm|--prod)\b`,
    String.raw`\brotate_postgres_password\b`,
    String.raw`\bapply-annex-a\b`,
    String.raw`\bprovision-roles\b`,
  ].join("|"),
  "i",
)

/**
 * SQL write statements. `COPY ... FROM` is the import form (COPY not preceded by a backslash).
 * The psql export meta-command `\copy ( ... ) TO` is not that form.
 * `.` does not cross newlines, matching the SPEC pattern `COPY .* FROM`.
 */
const SQL_WRITE =
  /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|GRANT|REVOKE|CREATE|TRUNCATE|COMMIT)\b|(?<!\\)\bCOPY\b[^\n]*\bFROM\b/i

const SECRET_RES: RegExp[] = [
  /postgres(?:ql)?:\/\/[^<\s]*:[^<\s]*@/,
  /password\s*=\s*[^<\s]/i,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{35}/,
]

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

function sectionBody(text: string, id: string, nextIds: string[]): string {
  const start = text.indexOf(`## ${id}`)
  if (start < 0) return ""
  let end = text.length
  for (const next of nextIds) {
    const at = text.indexOf(`## ${next}`, start + 4)
    if (at >= 0 && at < end) end = at
  }
  return text.slice(start, end)
}

export function lintVerificationRunbook(text: string): string[] {
  const problems: string[] = []
  for (const id of ["§0", "§A", "§B", "§C", "§D", "§E"]) {
    if (!text.includes(`## ${id}`)) problems.push(`missing section ${id}`)
  }
  const lines = text.split("\n")
  for (const line of lines) {
    if (!FORBIDDEN_COMMAND.test(line)) continue
    const trimmed = line.trim()
    if (trimmed.startsWith(">") || line.includes("do not")) continue
    problems.push(`forbidden command: ${trimmed}`)
  }
  const sqlRe = /```sql\r?\n([\s\S]*?)```/g
  const blocks = [...text.matchAll(sqlRe)].map((m) => m[1])
  if (blocks.length === 0) problems.push("no sql block")
  for (const [index, block] of blocks.entries()) {
    const contentLines = block.split("\n").filter((line) => line.trim().length > 0)
    if (contentLines[0] !== "SET default_transaction_read_only = on;") {
      problems.push(`sql ${index} does not begin with SET default_transaction_read_only = on;`)
    }
    if (contentLines[1] !== "BEGIN READ ONLY;") {
      problems.push(`sql ${index} does not begin with BEGIN READ ONLY;`)
    }
    if (contentLines[contentLines.length - 1] !== "ROLLBACK;") {
      problems.push(`sql ${index} does not end with ROLLBACK;`)
    }
    const write = block.match(SQL_WRITE)
    if (write) problems.push(`sql ${index} write statement: ${write[0]}`)
  }
  for (const re of SECRET_RES) {
    const hit = text.match(re)
    if (hit) problems.push(`secret-shaped text: ${hit[0]}`)
  }
  for (const match of text.matchAll(EMAIL_RE)) {
    const at = match.index ?? 0
    const before = at > 0 ? text[at - 1] : ""
    if (before === "<") continue
    problems.push(`email address: ${match[0]}`)
  }
  const sectionA = sectionBody(text, "§A", ["§B", "§C", "§D", "§E"])
  if (!sectionA.includes("check_deploy_drift.py")) problems.push("§A missing check_deploy_drift.py")
  if (!sectionA.includes("deploy-preflight.sh")) problems.push("§A missing deploy-preflight.sh")
  const sectionD = sectionBody(text, "§D", ["§E"])
  if (!sectionD.includes("BLOCKED")) problems.push("§D missing BLOCKED")
  return problems
}

const STALE_FILES = [
  "corpus_service/docker-compose.yml",
  "corpus_service/scripts/rotate_postgres_password.sh",
  "corpus_service/docker/postgres/provision-roles.sh",
  "corpus_service/tests/e2e/lib.sh",
]

describe("Q05 deploy posture", () => {
  it("path gate coverage", () => {
    const workflow = read(".github/workflows/gate-g0.yml")
    const postgresDdl = extractAssignedRegex(workflow, "postgres_ddl_re")
    const corpusService = extractAssignedRegex(workflow, "corpus_service_re")
    const suites = postgresDdlScriptFiles()
    const mounted = bindMountedRepoPaths(suites)
    const paths = [...suites, ...mounted]
    const misses = paths.filter((rel) => !postgresDdl.test(rel))
    expect(misses, `path gate SKIP:\n${misses.join("\n")}`).toEqual([])
    expect(corpusService.test("corpus_service/docker/postgres/apply-annex-a.sh")).toBe(true)
    expect(corpusService.test("postgres/ddl/008_classification_inventory.sql")).toBe(true)
  })

  it("deploy gate tests wired", () => {
    const gate = read("ci_gates/gate_g0.sh")
    const contract = gate.match(
      /python3 ci_gates\/test_check_deploy_contract\.py[^\n]*\|\| \{[^}]*fail=1; \}/,
    )
    const drift = gate.match(/python3 ci_gates\/test_check_deploy_drift\.py[^\n]*\|\| \{[^}]*fail=1; \}/)
    expect(contract, "test_check_deploy_contract.py is not wired under [20]").not.toBeNull()
    expect(drift, "test_check_deploy_drift.py is not wired under [20]").not.toBeNull()
  })

  it("annex list parity", () => {
    const script = read("corpus_service/docker/postgres/apply-annex-a.sh")
    const { loop, psql } = annexFileLists(script)
    const disk = ddlMinusPlatform()
    expect(loop).toEqual(psql)
    expect(psql).toEqual(disk)
    const i007 = psql.indexOf("007_classification_coverage.sql")
    const i008 = psql.indexOf("008_classification_inventory.sql")
    expect(i007).not.toBe(-1)
    expect(i008).not.toBe(-1)
    expect(i007).toBeLessThan(i008)
    expect(script.includes("--single-transaction")).toBe(true)
    expect(script.includes("ON_ERROR_STOP=1")).toBe(true)
  })

  it("init and upgrade order", () => {
    const compose = read("corpus_service/docker-compose.yml")
    expect(compose.includes("./init.sql:/docker-entrypoint-initdb.d/10-init.sql:ro")).toBe(true)
    expect(
      compose.includes("./docker/postgres/apply-annex-a.sh:/docker-entrypoint-initdb.d/15-apply-annex-a.sh:ro"),
    ).toBe(true)
    expect(
      compose.includes(
        "./docker/postgres/provision-roles.sh:/docker-entrypoint-initdb.d/20-provision-roles.sh:ro",
      ),
    ).toBe(true)
    expect(compose.includes("../postgres/ddl:/etc/postgresql/corpus/ddl:ro")).toBe(true)
    const rotate = read("corpus_service/scripts/rotate_postgres_password.sh")
    const commands = nonCommentLines(rotate)
    const i15 = commands.findIndex((line) => line.includes("15-apply-annex-a.sh"))
    const i20 = commands.findIndex((line) => line.includes("20-provision-roles.sh"))
    expect(i15).not.toBe(-1)
    expect(i20).not.toBe(-1)
    expect(i15).toBeLessThan(i20)
    expect(rotate.includes("refusing: new password must be >=16 chars and not a default")).toBe(true)
  })

  it("provision refusal present", () => {
    const script = read("corpus_service/docker/postgres/provision-roles.sh")
    expect(script.includes("Annex A is not applied: run 15-apply-annex-a.sh first")).toBe(true)
    expect(script.includes("re-apply 007/008 with 15-apply-annex-a.sh")).toBe(true)
  })

  it("runbook lint", () => {
    const rel = "docs/deploy/DEPLOY_VERIFICATION_RUNBOOK.md"
    expect(fs.existsSync(path.join(REPO, rel)), `${rel} is absent`).toBe(true)
    const text = read(rel)
    expect(lintVerificationRunbook(text)).toEqual([])
    const planted = `${text}\ngcloud functions deploy planted\n`
    expect(lintVerificationRunbook(planted)).toEqual(["forbidden command: gcloud functions deploy planted"])
  })

  it("stale comment gone", () => {
    const hits: string[] = []
    for (const rel of STALE_FILES) {
      const text = read(rel)
      // `001 + 003` is the one-line form. The rotate script splits it as `001 +` then a
      // comment continuation. The spec names `#   003` (three spaces); the file at 6f7dea3 has five.
      if (
        text.includes("001 + 003") ||
        text.includes("001 +\n#   003") ||
        text.includes("001 +\n#     003")
      ) {
        hits.push(rel)
      }
    }
    expect(hits, `stale 001 + 003 comments:\n${hits.join("\n")}`).toEqual([])
  })
})
