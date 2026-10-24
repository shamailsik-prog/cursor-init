import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const RULES = readFileSync("firestore.rules", "utf8")
const manifest = JSON.parse(readFileSync("infra/deploy-manifest.json", "utf8")) as {
  firestore: { ttl: { collectionGroup: string }[] }
}
const TTL_ONLY_RULE = "allow read, write: if false;"

function normalizeRuleBody(body: string): string {
  return body.replace(/\s+/g, " ").trim()
}

function ttlMatchBody(rules: string, collectionGroup: string): string {
  const re = new RegExp(`match\\s+/${collectionGroup}/\\{[^}]+\\}\\s*\\{([^}]+)\\}`, "s")
  const m = rules.match(re)
  if (!m) throw new Error(`no rules match for TTL collection ${collectionGroup}`)
  return normalizeRuleBody(m[1])
}

describe("F32 TTL rules static shape (R5FU-001)", () => {
  for (const { collectionGroup } of manifest.firestore.ttl) {
    it(`${collectionGroup} has only server-deny rule`, () => {
      expect(ttlMatchBody(RULES, collectionGroup)).toBe(TTL_ONLY_RULE)
    })
  }
})
