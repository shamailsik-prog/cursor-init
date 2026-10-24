import { describe, expect, it, vi } from "vitest"
import { PsqlSession } from "../lib/exec"
import { assertPgTargetClean, PgTargetNotCleanError } from "../postgres/guards"

function mockSession(scalars: Record<string, string>): PsqlSession {
  const s = new PsqlSession(undefined, {}, "postgres")
  vi.spyOn(s, "queryScalar").mockImplementation(async (sql: string) => {
    if (sql.includes("server_version")) return scalars.serverVersion ?? "16.4"
    if (sql.includes("pg_database")) return scalars.dbExists ?? "0"
    if (sql.includes("corpus_writer")) return scalars.roleExists ?? "0"
    if (sql.includes("pg_roles")) return scalars.genericRole ?? "0"
    return "0"
  })
  return s
}

describe("assertPgTargetClean", () => {
  it("passes when the target is clean", async () => {
    const s = mockSession({ dbExists: "0", roleExists: "0" })
    await expect(assertPgTargetClean(s, "restore_db", ["corpus_writer"], "16.0")).resolves.toBeUndefined()
  })

  it("refuses an existing database", async () => {
    const s = mockSession({ dbExists: "1" })
    await expect(assertPgTargetClean(s, "restore_db", [], "16.0")).rejects.toBeInstanceOf(PgTargetNotCleanError)
  })

  it("refuses an existing role from globals", async () => {
    const s = mockSession({ dbExists: "0", roleExists: "1" })
    await expect(assertPgTargetClean(s, "restore_db", ["corpus_writer"], "16.0")).rejects.toThrow(/corpus_writer/)
  })

  it("refuses an older server major version", async () => {
    const s = mockSession({ serverVersion: "15.2" })
    await expect(assertPgTargetClean(s, "restore_db", [], "16.0")).rejects.toThrow(/older/)
  })
})
