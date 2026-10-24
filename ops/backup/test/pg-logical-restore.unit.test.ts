import { describe, expect, it } from "vitest"
import { logicalPgRestoreArgv } from "../postgres/logical"

describe("logicalPgRestoreArgv", () => {
  it("restores ACL grants (no --no-acl)", () => {
    const argv = logicalPgRestoreArgv("restore_db", "/tmp/dump.part")
    expect(argv).toContain("--no-owner")
    expect(argv).not.toContain("--no-acl")
    expect(argv[0]).toBe("pg_restore")
  })
})
