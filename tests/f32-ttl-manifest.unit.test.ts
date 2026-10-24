import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("F32 TTL manifest (R4-002)", () => {
  it("lists every manifest firestore.ttl collectionGroup", () => {
    const manifest = JSON.parse(readFileSync("infra/deploy-manifest.json", "utf8")) as {
      firestore: { ttl: { collectionGroup: string }[] }
    }
    const fromManifest = manifest.firestore.ttl.map((t) => t.collectionGroup).sort()
    expect(fromManifest).toEqual(
      [
        "conflict_index_breaks",
        "counters",
        "idempotency_effects",
        "idempotency_keys",
        "rate_limits",
      ].sort(),
    )
  })
})
