import { afterAll, describe, expect, it } from "vitest"
import { startCluster } from "./helpers/cluster"
import { seedAnnexA, seedRows } from "./helpers/seeds"
import { PsqlSession } from "../lib/exec"
import { takePgManifest, comparePgManifests } from "../postgres/manifest"

describe("postgres manifest drill", () => {
  it(
    "manifest of seeded DB is stable and detects tamper",
    async () => {
      const cluster = await startCluster({})
      try {
        await seedAnnexA(cluster)
        await seedRows(cluster)
        const session = new PsqlSession(undefined, cluster.env, "legal_scraper")
        const m1 = await takePgManifest(session, "legal_scraper")
        const session2 = new PsqlSession(undefined, cluster.env, "legal_scraper")
        const m2 = await takePgManifest(session2, "legal_scraper")
        expect(comparePgManifests(m1, m2)).toEqual([])
        expect(m1.tables["public.judgment"]?.rows).toBeGreaterThan(0)
        const tampered = { ...m2, tables: { ...m2.tables, "public.judgment": { rows: 0, digest: "dead" } } }
        expect(comparePgManifests(m1, tampered).length).toBeGreaterThan(0)
      } finally {
        await cluster.stop()
      }
    },
    120_000
  )
})
