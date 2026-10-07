// Review round 1, finding 6: every Firestore collection whose rows carry matterId must gate
// reads on membership (R-2: "No matter access without membership, and no role is exempt").
// This guard derives the list the same way the rules change was generated: rules match blocks
// -> writer row types (firestoreSpineRepositories generic calls and the deny-by-default
// workflow-ops collection map -> SpineStore Map<string, Row> fields) -> does Row declare
// matterId? Writer-less dedicated lattice views (`*_viewNNN`) are covered as well.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const rules = readFileSync("firestore.rules", "utf8")
const store = readFileSync("platform/spine/store.ts", "utf8")
const repo = readFileSync("platform/persistence/firestoreSpineRepositories.ts", "utf8")
const dbd = readFileSync("platform/persistence/denyByDefaultWorkflowOpsRepository.ts", "utf8")

const MEMBERSHIP = /isMember\(|memberReader\(|matterScoped\(|canAccessScope\(/

function readCondition(coll: string): string {
  const at = rules.indexOf(`match /${coll}/{`)
  const start = rules.indexOf("allow read: if", at)
  const end = rules.indexOf(";", start)
  return rules.slice(start, end)
}

function rowTypeHasMatterId(type: string): boolean | null {
  const m = new RegExp(`export type ${type}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`).exec(store)
  if (!m || m[1] === undefined) return null
  return /^\s*matterId\??:/m.test(m[1])
}

function matterBoundCollections(): string[] {
  const colls = [...rules.matchAll(/match \/(\w+)\/\{/g)].map((m) => m[1] ?? "")
  const types = new Map<string, Set<string>>()
  const add = (coll: string, type: string) => {
    const set = types.get(coll) ?? new Set<string>()
    set.add(type)
    types.set(coll, set)
  }
  for (const m of repo.matchAll(/<(\w+)(?:\s*&[^>]*)?>\(\s*db,\s*"(\w+)"/g)) add(m[2] ?? "", m[1] ?? "")
  const fields = new Map(
    [...store.matchAll(/^ {2}(\w+)\s*=\s*\n?\s*new Map<\s*string,\s*(\w+)\s*>/gm)].map((m) => [m[1] ?? "", m[2] ?? ""])
  )
  for (const m of dbd.matchAll(/^\s{4}(\w+):\s*\n\s*"(\w+)"/gm)) {
    const type = fields.get(m[1] ?? "")
    if (type) add(m[2] ?? "", type)
  }
  return colls.filter((coll) => {
    if (/_view\d+$/.test(coll)) return true
    return [...(types.get(coll) ?? [])].some((type) => rowTypeHasMatterId(type) === true)
  })
}

describe("firestore.rules: matter-bound collections gate reads on membership", () => {
  const bound = matterBoundCollections()

  it("derives a substantial list (sanity: the derivation still finds the writers)", () => {
    expect(bound.length).toBeGreaterThan(150)
    for (const coll of ["filing_packet_artifacts", "committee_outputs", "workflow_ops_activity", "drafts", "jobs"]) {
      expect(bound).toContain(coll)
    }
  })

  it.each(bound.map((coll) => [coll.length > 90 ? `${coll.slice(0, 60)}…${coll.slice(-25)}` : coll, coll]))(
    "%s",
    (_label, coll) => {
      expect(readCondition(coll)).toMatch(MEMBERSHIP)
    }
  )

  it("no read rule relies on an undefined helper (isSignedIn)", () => {
    expect(rules).not.toMatch(/isSignedIn\(\)/)
  })
})
