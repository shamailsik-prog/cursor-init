import { describe, expect, it } from "vitest"
import { logicalPgRestoreArgv } from "../postgres/logical"

describe("logicalPgRestoreArgv", () => {
  it("writes SQL to stdout and does not open a database connection", () => {
    const argv = logicalPgRestoreArgv("/tmp/dump.part")
    expect(argv).toEqual(["pg_restore", "--no-owner", "-f", "-", "/tmp/dump.part"])
    expect(argv).not.toContain("-d")
    expect(argv).not.toContain("--no-acl")
  })
})

describe("writing-session identity guard", () => {
  it("puts the server-side identity assertion first and again after every connect", async () => {
    const mod = await import("../postgres/logical")
    expect(typeof mod.identityGuardSql).toBe("function")
    expect(typeof mod.withIdentityGuards).toBe("function")
    const guard = mod.identityGuardSql({
      expectedSystemIdentifier: "99",
      host: "/tmp/sikander-backup-drill/sock",
      port: "5432",
    })
    expect(guard).toMatch(/system_identifier/)
    expect(guard).toMatch(/inet_server_addr/)
    expect(guard).toMatch(/inet_server_port/)
    expect(guard).toMatch(/unix_socket_directories/)
    expect(guard).toMatch(/RAISE EXCEPTION/)
    const sql = "CREATE DATABASE x;\n\\connect legal_scraper\nCREATE TABLE t ();\n"
    const out = mod.withIdentityGuards(sql, guard)
    expect(out.startsWith(guard)).toBe(true)
    expect(out.split("\\connect legal_scraper\n")[1]?.startsWith(guard)).toBe(true)
  })
})
