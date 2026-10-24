import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("F32 firestore.indexes.json TTL overrides", () => {
  const root = path.resolve(__dirname, "..")
  const indexesPath = path.join(root, "firestore.indexes.json")
  const manifestPath = path.join(root, "infra/deploy-manifest.json")

  it("firebase.json names asia-south1 and nodejs22", () => {
    const firebase = JSON.parse(readFileSync(path.join(root, "firebase.json"), "utf8")) as {
      firestore?: { location?: string }
      functions?: { runtime?: string }
    }
    expect(firebase.firestore?.location).toBe("asia-south1")
    expect(firebase.functions?.runtime).toBe("nodejs22")
  })

  it("every manifest TTL collection has a ttl fieldOverride validated by firebase-tools", async () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      firestore: { ttl: { collectionGroup: string; fieldPath: string }[] }
    }
    const indexes = JSON.parse(readFileSync(indexesPath, "utf8")) as {
      fieldOverrides?: { collectionGroup: string; fieldPath: string; ttl?: boolean; indexes?: unknown[] }[]
    }
    const { createRequire } = await import("node:module")
    const require = createRequire(import.meta.url)
    const { FirestoreApi } = require("firebase-tools/lib/firestore/api") as { FirestoreApi: new () => { validateField: (f: unknown) => void } }
    const api = new FirestoreApi()
    for (const ttl of manifest.firestore.ttl) {
      const override = indexes.fieldOverrides?.find((o) => o.collectionGroup === ttl.collectionGroup && o.fieldPath === ttl.fieldPath)
      expect(override, ttl.collectionGroup).toBeDefined()
      expect(override!.ttl).toBe(true)
      expect(override!.indexes?.length).toBeGreaterThanOrEqual(3)
      expect(() => api.validateField(override!)).not.toThrow()
    }
  })
})
