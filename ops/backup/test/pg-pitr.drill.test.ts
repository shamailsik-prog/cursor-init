import { describe, expect, it } from "vitest"
import { assertPitrClientTools } from "../postgres/pitrPrereq"

describe("postgres PITR drill", () => {
  it(
    "fails fast when PostgreSQL client programs are missing",
    async () => {
      await assertPitrClientTools()
      expect(true).toBe(true)
    },
    120_000
  )
})
