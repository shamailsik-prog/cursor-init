import { describe, expect, it } from "vitest"
import { comparePgManifests, type PgManifest } from "../postgres/manifest"

function base(): PgManifest {
  return {
    meta: {
      serverVersion: "16",
      database: "d",
      encoding: "UTF8",
      collation: "C",
      backupTime: "t",
      snapshotId: "s",
    },
    tables: {},
    sequences: {},
    foreignKeys: {},
    links: {},
    extensions: {},
    definitions: [],
    roles: ["app_role"],
    grants: ["GRANT SELECT ON public.judgment TO app_role"],
  }
}

describe("comparePgManifests grants", () => {
  it("reports missing table grants after restore", () => {
    const a = base()
    const b = { ...base(), grants: [] }
    const lines = comparePgManifests(a, b)
    expect(lines.some((l) => l.includes("grants"))).toBe(true)
  })
})
