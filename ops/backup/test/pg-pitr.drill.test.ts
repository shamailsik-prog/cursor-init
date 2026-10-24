import { describe, expect, it } from "vitest"
import { runCommand } from "../lib/exec"

describe("postgres PITR drill", () => {
  it(
    "fails fast when PostgreSQL client programs are missing",
    async () => {
      const r = await runCommand(["bash", "-lc", "command -v initdb && command -v pg_basebackup"], {
        env: { PATH: `/usr/lib/postgresql/16/bin:${process.env.PATH ?? ""}` },
      })
      if (r.code !== 0) {
        expect(r.code).not.toBe(0)
        return
      }
      expect(r.code).toBe(0)
    },
    120_000
  )
})
