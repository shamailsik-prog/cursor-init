import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  assertTtlCollectionServerDenyOnly,
  extractMatchBlocks,
  matchBlocksForCollectionGroup,
  normalizeRuleBody,
  stripRulesComments,
  TTL_ONLY_RULE,
} from "./lib/f32-ttl-rules"

const RULES = readFileSync("firestore.rules", "utf8")
const manifest = JSON.parse(readFileSync("infra/deploy-manifest.json", "utf8")) as {
  firestore: { ttl: { collectionGroup: string }[] }
}

describe("F32 TTL rules static shape (R116-001 / R116-002)", () => {
  it("strips line and block comments before normalizing", () => {
    const sample = `match /x/{id} {
      // comment
      allow read, write: if false;
      /* block */
    }`
    const body = extractMatchBlocks(sample).find((b) => b.path === "/x/{id}")?.body ?? ""
    expect(normalizeRuleBody(body)).toBe(TTL_ONLY_RULE)
    expect(stripRulesComments(sample)).not.toMatch(/comment|block/)
  })

  for (const { collectionGroup } of manifest.firestore.ttl) {
    it(`${collectionGroup}: every applicable match block is server-deny only`, () => {
      assertTtlCollectionServerDenyOnly(RULES, collectionGroup)
      const blocks = matchBlocksForCollectionGroup(RULES, collectionGroup)
      expect(blocks.length).toBeGreaterThanOrEqual(1)
      const direct = blocks.find((b) => b.path === `/${collectionGroup}/{id}`)
      expect(direct, `expected direct match /${collectionGroup}/{id}`).toBeDefined()
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

  it("rejects mutant allow rules in synthetic TTL blocks", () => {
    const mutantAdmin = `match /rate_limits/{id} { allow read: if request.auth.token.platformAdmin == true; }`
    expect(() => assertTtlCollectionServerDenyOnly(mutantAdmin, "rate_limits")).toThrow()
    const mutantVictim = `match /counters/{id} { allow get: if id == 'victim'; }`
    expect(() => assertTtlCollectionServerDenyOnly(mutantVictim, "counters")).toThrow()
    const mutantUid = `match /counters/{id} { allow read: if request.auth.uid == 'allowed'; }`
    expect(() => assertTtlCollectionServerDenyOnly(mutantUid, "counters")).toThrow()
  })
})
