import { describe, expect, it } from "vitest"
import {
  compareToAllowlist,
  npmFindings,
  parseAllowlist,
  pipFindings,
} from "../ci_gates/check_known_advisories.mjs"

const npmReport = {
  auditReportVersion: 2,
  vulnerabilities: {
    next: {
      name: "next",
      severity: "critical",
      via: [
        { source: 1, name: "next", title: "RCE", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", severity: "critical" },
        { source: 2, name: "next", title: "minor", url: "https://github.com/advisories/GHSA-low1-low1-low1", severity: "moderate" },
      ],
    },
    shadcn: { name: "shadcn", severity: "high", via: ["fast-glob"] },
    undici: {
      name: "undici",
      severity: "high",
      via: [{ source: 3, name: "undici", title: "DoS", url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", severity: "high" }],
    },
  },
}

const allowlistMd = `
# Known advisories

| scope | advisory | package | severity | reason | owner | review by |
| --- | --- | --- | --- | --- | --- | --- |
| npm:root | GHSA-aaaa-bbbb-cccc | next | critical | needs next 16.4 | Shamail | 2026-11-01 |
| npm:functions | GHSA-zzzz-zzzz-zzzz | uuid | high | gone already | Shamail | 2026-11-01 |
| pip:corpus_service | PYSEC-2026-1 | lxml | unknown | no fix | Shamail | 2026-11-01 |
`

describe("known-advisories gate (ci_gates/check_known_advisories.mjs)", () => {
  it("takes only high and critical advisories from npm audit, one per GHSA, ignoring transitive pointers", () => {
    expect(npmFindings("npm:root", npmReport)).toEqual([
      { scope: "npm:root", id: "GHSA-aaaa-bbbb-cccc", pkg: "next", severity: "critical", title: "RCE" },
      { scope: "npm:root", id: "GHSA-dddd-eeee-ffff", pkg: "undici", severity: "high", title: "DoS" },
    ])
  })

  it("refuses an npm audit report it cannot read (an error report is not a clean report)", () => {
    expect(() => npmFindings("npm:root", { error: { code: "ENOLOCK" } })).toThrow(/npm:root/)
    expect(() => npmFindings("npm:root", {})).toThrow(/npm:root/)
  })

  it("takes every pip-audit vulnerability (pip-audit reports no severity)", () => {
    const report = {
      dependencies: [
        { name: "lxml", version: "5.0", vulns: [{ id: "PYSEC-2026-1", aliases: ["CVE-2026-1"], description: "x" }] },
        { name: "httpx", version: "1.0", vulns: [] },
        { name: "skipped", skip_reason: "not on PyPI" },
      ],
    }
    expect(pipFindings("pip:corpus_service", report)).toEqual([
      { scope: "pip:corpus_service", id: "PYSEC-2026-1", pkg: "lxml", severity: "unknown", title: "x", aliases: ["CVE-2026-1"] },
    ])
  })

  it("parses the allowlist table and rejects a row without reason or owner", () => {
    const rows = parseAllowlist(allowlistMd)
    expect(rows.map((r) => `${r.scope} ${r.id} ${r.pkg}`)).toEqual([
      "npm:root GHSA-aaaa-bbbb-cccc next",
      "npm:functions GHSA-zzzz-zzzz-zzzz uuid",
      "pip:corpus_service PYSEC-2026-1 lxml",
    ])
    const noOwner = allowlistMd.replace("| needs next 16.4 | Shamail |", "| needs next 16.4 |  |")
    expect(() => parseAllowlist(noOwner)).toThrow(/owner/)
    const noReason = allowlistMd.replace("| needs next 16.4 | Shamail |", "|  | Shamail |")
    expect(() => parseAllowlist(noReason)).toThrow(/reason/)
  })

  it("fails on a new advisory, passes on listed ones, and reports stale entries without failing", () => {
    const findings = [
      ...npmFindings("npm:root", npmReport),
      { scope: "pip:corpus_service", id: "PYSEC-2026-1", pkg: "lxml", severity: "unknown", title: "x", aliases: [] },
    ]
    const result = compareToAllowlist(findings, parseAllowlist(allowlistMd))
    expect(result.unlisted.map((f) => f.id)).toEqual(["GHSA-dddd-eeee-ffff"])
    expect(result.listed.map((f) => f.id)).toEqual(["GHSA-aaaa-bbbb-cccc", "PYSEC-2026-1"])
    expect(result.stale.map((r) => r.id)).toEqual(["GHSA-zzzz-zzzz-zzzz"])
  })

  it("matches a listed advisory only in its own scope", () => {
    const findings = [{ scope: "npm:functions", id: "GHSA-aaaa-bbbb-cccc", pkg: "next", severity: "critical", title: "RCE" }]
    expect(compareToAllowlist(findings, parseAllowlist(allowlistMd)).unlisted).toHaveLength(1)
  })

  it("matches a pip finding listed under one of its aliases", () => {
    const findings = [{ scope: "pip:corpus_service", id: "GHSA-pppp-pppp-pppp", pkg: "lxml", severity: "unknown", title: "x", aliases: ["PYSEC-2026-1"] }]
    expect(compareToAllowlist(findings, parseAllowlist(allowlistMd)).unlisted).toHaveLength(0)
  })
})
