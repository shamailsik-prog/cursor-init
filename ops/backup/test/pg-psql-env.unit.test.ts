import { describe, expect, it } from "vitest"
import { PG_MANIFEST_PGOPTIONS, withManifestPsqlEnv } from "../postgres/psqlEnv"

describe("manifest psql env", () => {
  it("forces UTC session options for digest-stable restores (F33-A)", () => {
    const env = withManifestPsqlEnv({ ...process.env, CUSTOM: "1" })
    expect(env.PGOPTIONS).toContain("TimeZone=UTC")
    expect(env.PGOPTIONS).toContain(PG_MANIFEST_PGOPTIONS)
  })
})
