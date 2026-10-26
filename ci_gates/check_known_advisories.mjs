#!/usr/bin/env node
// Dependency-audit gate (.github/workflows/security.yml; docs/audits/README.md).
//
// `npm audit` and `pip-audit` run report-only: the repo carries advisories that
// need major bumps, so their own exit codes cannot gate. This script is the
// gate: it fails when a high or critical npm advisory, or any pip-audit
// vulnerability (pip-audit reports no severity), is not listed in
// docs/audits/known-advisories.md for that scope. Listed advisories that no
// longer appear are reported as stale (prune them) but do not fail.
//
//   node ci_gates/check_known_advisories.mjs \
//     --npm npm:root=root-prod.json --npm npm:root:dev=root-full.json \
//     --npm npm:functions=functions-prod.json --npm npm:functions:dev=functions-full.json \
//     --pip pip:corpus_service=pip-audit.json [--allowlist docs/audits/known-advisories.md]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const GATING = new Set(["high", "critical"])

/** High/critical advisories in an `npm audit --json` (v2) report, one per (GHSA, package). */
export function npmFindings(scope, report) {
  if (!report || typeof report !== "object" || report.error || typeof report.vulnerabilities !== "object") {
    throw new Error(`${scope}: not an npm audit report (${JSON.stringify(report?.error ?? report).slice(0, 200)})`)
  }
  const out = new Map()
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      // A string is a pointer to the dependency that carries the advisory; that
      // dependency's own entry lists it.
      if (typeof via !== "object" || !GATING.has(via.severity)) continue
      const id = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(via.url ?? "")?.[0] ?? `npm-${via.source}`
      const key = `${id} ${via.name}`
      if (!out.has(key)) out.set(key, { scope, id, pkg: via.name, severity: via.severity, title: via.title })
    }
  }
  return [...out.values()].sort((a, b) => a.pkg.localeCompare(b.pkg) || a.id.localeCompare(b.id))
}

/** Every vulnerability in a `pip-audit -f json` report. */
export function pipFindings(scope, report) {
  if (!report || !Array.isArray(report.dependencies)) {
    throw new Error(`${scope}: not a pip-audit report`)
  }
  const out = []
  for (const dep of report.dependencies) {
    for (const v of dep.vulns ?? []) {
      out.push({ scope, id: v.id, pkg: dep.name, severity: "unknown", title: v.description ?? "", aliases: v.aliases ?? [] })
    }
  }
  return out
}

const COLUMNS = ["scope", "advisory", "package", "severity", "reason", "owner", "review by"]

/** Rows of the allowlist table in known-advisories.md (the table whose header is COLUMNS). */
export function parseAllowlist(markdown) {
  const rows = []
  let inTable = false
  for (const raw of markdown.split("\n")) {
    const line = raw.trim()
    if (!line.startsWith("|")) {
      inTable = false
      continue
    }
    const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
    if (cells.map((c) => c.toLowerCase()).join("|") === COLUMNS.join("|")) {
      inTable = true
      continue
    }
    if (!inTable || cells.every((c) => /^:?-+:?$/.test(c))) continue
    const [scope, id, pkg, severity, reason, owner, reviewBy] = cells
    for (const [name, value] of [["scope", scope], ["advisory", id], ["package", pkg], ["reason", reason], ["owner", owner]]) {
      if (!value) throw new Error(`known-advisories: row "${line}" has no ${name}`)
    }
    rows.push({ scope, id, pkg, severity, reason, owner, reviewBy })
  }
  return rows
}

export function compareToAllowlist(findings, allowlist) {
  const listedKey = new Set(allowlist.map((r) => `${r.scope} ${r.id}`))
  const matches = (f) => [f.id, ...(f.aliases ?? [])].some((id) => listedKey.has(`${f.scope} ${id}`))
  const listed = findings.filter(matches)
  const unlisted = findings.filter((f) => !matches(f))
  const seen = new Set(findings.flatMap((f) => [f.id, ...(f.aliases ?? [])].map((id) => `${f.scope} ${id}`)))
  const stale = allowlist.filter((r) => !seen.has(`${r.scope} ${r.id}`))
  return { listed, unlisted, stale }
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  let allowlistPath = path.join(root, "docs/audits/known-advisories.md")
  const findings = []
  const scopes = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--allowlist") {
      allowlistPath = argv[++i]
      continue
    }
    if (flag !== "--npm" && flag !== "--pip") throw new Error(`unknown argument ${flag}`)
    const [scope, file] = argv[++i].split(/=(.*)/s)
    const report = JSON.parse(fs.readFileSync(file, "utf8"))
    findings.push(...(flag === "--npm" ? npmFindings(scope, report) : pipFindings(scope, report)))
    scopes.push(scope)
  }
  const allowlist = parseAllowlist(fs.readFileSync(allowlistPath, "utf8")).filter((r) => scopes.includes(r.scope))
  const { listed, unlisted, stale } = compareToAllowlist(findings, allowlist)
  const show = (f) => `  ${f.scope.padEnd(20)} ${f.id.padEnd(22)} ${f.pkg.padEnd(28)} ${f.severity.padEnd(9)} ${f.title}`
  console.log(`dependency audit: ${findings.length} gating advisories in ${scopes.join(", ")}`)
  if (listed.length) console.log(`listed in ${path.relative(root, allowlistPath)} (${listed.length}):\n${listed.map(show).join("\n")}`)
  if (stale.length) {
    console.log(`stale allowlist entries (no longer reported; remove them):\n${stale.map((r) => `  ${r.scope} ${r.id} ${r.pkg}`).join("\n")}`)
  }
  if (unlisted.length) {
    console.log(`NEW advisories not in the allowlist (${unlisted.length}):\n${unlisted.map(show).join("\n")}`)
    console.log("FAIL: fix them, or list each with a reason and an owner in docs/audits/known-advisories.md")
    return 1
  }
  console.log("PASS: no unlisted high/critical advisory")
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (err) {
    console.error(`FAIL: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
