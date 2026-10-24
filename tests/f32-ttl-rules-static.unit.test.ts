import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  assertBlockIsServerDenyOnly,
  assertTtlCollectionServerDenyOnly,
  extractMatchBlocks,
  matchBlocksForCollectionGroup,
  matchPathAppliesToCollectionGroup,
  normalizeRuleBody,
  stripRulesComments,
} from "./lib/f32-ttl-rules"

const RULES = readFileSync("firestore.rules", "utf8")
const manifest = JSON.parse(readFileSync("infra/deploy-manifest.json", "utf8")) as {
  firestore: { ttl: { collectionGroup: string }[] }
}

describe("F32 TTL rules static shape (R117-001..003 / R117-006)", () => {
  it("strips line and block comments before normalizing but not inside strings", () => {
    const sample = `match /x/{id} {
      // comment
      allow read, write: if false;
      /* block */
    }`
    const body = extractMatchBlocks(sample).find((b) => b.path === "/x/{id}")?.body ?? ""
    expect(() => assertBlockIsServerDenyOnly(body)).not.toThrow()
    expect(stripRulesComments(sample)).not.toMatch(/comment|block/)

    const stringGuard = `match /y/{id} {
      allow read, write: if resource.data.note == "/* not a comment */";
    }`
    expect(stripRulesComments(stringGuard)).toContain("/* not a comment */")
    expect(() => assertBlockIsServerDenyOnly(extractMatchBlocks(stringGuard)[0].body)).toThrow()
  })

  it("treats variable-segment and recursive match paths as applicable", () => {
    expect(matchPathAppliesToCollectionGroup("/orgs/{orgId}/rate_limits/{rid}", "rate_limits")).toBe(true)
    expect(matchPathAppliesToCollectionGroup("/{document=**}", "counters")).toBe(true)
    expect(matchPathAppliesToCollectionGroup("{document=**}", "idempotency_keys")).toBe(true)
  })

  it("accepts equivalent full-deny allow shapes", () => {
    const variants = [
      "allow read, write: if false;",
      "allow write , read : if false ;",
      "allow read: if false; allow write: if false;",
      "allow read,write: if false;",
    ]
    for (const rules of variants) {
      expect(() => assertBlockIsServerDenyOnly(rules)).not.toThrow()
    }
  })

  for (const { collectionGroup } of manifest.firestore.ttl) {
    it(`${collectionGroup}: every applicable match block is server-deny only`, () => {
      assertTtlCollectionServerDenyOnly(RULES, collectionGroup)
      const blocks = matchBlocksForCollectionGroup(RULES, collectionGroup)
      expect(blocks.length).toBeGreaterThanOrEqual(1)
      const direct = blocks.find((b) => b.path === `/${collectionGroup}/{id}`)
      expect(direct, `expected direct match /${collectionGroup}/{id}`).toBeDefined()
      expect(blocks.some((b) => b.path === "/{document=**}" || b.path === "{document=**}")).toBe(true)
    })
  }

  it("parser finds nested match blocks when present in synthetic rules", () => {
    const synthetic = `
      match /firms/{firmId} {
        match /idempotency_keys/{id} { allow read, write: if false; }
      }
    `
    const blocks = extractMatchBlocks(synthetic)
    expect(blocks.some((b) => b.path.includes("idempotency_keys"))).toBe(true)
    assertTtlCollectionServerDenyOnly(synthetic, "idempotency_keys")
  })

  it("rejects conditional allows via structural check (not literal mutant names)", () => {
    const supportClaim = `match /orgs/{orgId}/rate_limits/{rid} { allow read: if request.auth.token.support == true; }`
    expect(() => assertTtlCollectionServerDenyOnly(supportClaim, "rate_limits")).toThrow()
    const targetDoc = `match /counters/{id} { allow get: if id == 'target'; }`
    expect(() => assertTtlCollectionServerDenyOnly(targetDoc, "counters")).toThrow()
    const splitMutant = `match /counters/{id} { allow read: if false; allow write: if request.auth != null; }`
    expect(() => assertTtlCollectionServerDenyOnly(splitMutant, "counters")).toThrow()
  })
})
