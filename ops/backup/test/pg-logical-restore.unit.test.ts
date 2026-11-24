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
  it("puts the identity assertion first and again only after a line-start connect", async () => {
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
    const hop = mod.idempotentHop("host=/tmp/sikander-backup-drill/sock port=5432 dbname=legal_scraper user=postgres", guard)
    expect(hop).toContain("\\connect")
    expect(hop.split("\\connect")[1] ?? "").toContain("RAISE EXCEPTION")
    const sql = "CREATE DATABASE x;\n\\connect legal_scraper\nCREATE TABLE t ();\n"
    const out = mod.withIdentityGuards(sql, guard)
    expect(out.startsWith(guard)).toBe(true)
    expect(out.split("\\connect legal_scraper\n")[1]?.startsWith(guard)).toBe(true)
    const portRaises = guard.match(/connected server port does not match the explicit target/g) ?? []
    expect(portRaises).toHaveLength(1)
    expect(guard).toMatch(/IF current_setting\('port'\) IS DISTINCT FROM '5432' THEN/)
    expect(guard).toMatch(/IF NOT ok THEN/)
    expect(guard).toMatch(/IF addr <> '' THEN/)
    const tcp = mod.identityGuardSql({ expectedSystemIdentifier: "99", host: "127.0.0.1", port: "5432" })
    expect(tcp).toMatch(/IF addr <> '127.0.0.1' AND addr <> '::1' THEN/)
    expect(tcp).toMatch(/IF prt IS DISTINCT FROM '5432' THEN/)
    expect(() => mod.identityGuardSql({ expectedSystemIdentifier: "99", host: "/tmp/sikander-backup-drill/../etc", port: "5432" })).toThrow(/socket directory/)
    expect(() => mod.identityGuardSql({ expectedSystemIdentifier: "abc", host: "/tmp/sikander-backup-drill/sock", port: "5432" })).toThrow(/system identifier/)
    const copy = "COPY public.t FROM stdin;\n\\\\connect sneaky\n\\.\n"
    const copied = mod.withIdentityGuards(copy, guard)
    const copyBody = copied.split("FROM stdin;\n")[1]?.split("\n\\.\n")[0] ?? ""
    expect(copyBody).toContain("\\connect sneaky")
    expect(copyBody).not.toContain("RAISE EXCEPTION")
    for (const sql of [
      "SELECT 1; \\connect other\n",
      "SELECT 1;\\connect other\n",
      "SELECT 1\\connect other\n",
      "\\x\\c other\n",
      "/* x */\\connect other\n",
      "\\echo a\\\\\\c other\n",
      "\\ir /tmp/inc.sql\n",
      "\\c other\n",
      "\\set v 'x'\n:v\n",
    ]) {
      expect(() => mod.withIdentityGuards(sql, guard), sql).toThrow(/not allowlisted|variable interpolation/)
    }
    const dollar = "CREATE FUNCTION zzf() RETURNS int LANGUAGE sql AS $q$\nCOPY zz FROM stdin;\nSELECT 1 $q$;\n\\connect legal\nCREATE TABLE zz_14 ();\n"
    const dollarOut = mod.withIdentityGuards(dollar, guard)
    expect(dollarOut.split("\\connect legal\n")[1]?.startsWith(guard)).toBe(true)
    const restrict = "\\restrict abcdef\nSELECT 1;\n\\unrestrict abcdef\n"
    expect(mod.withIdentityGuards(restrict, guard)).toContain("\\restrict abcdef\n")
    const { createScriptGuard } = await import("../postgres/scriptGuard")
    const scanner = createScriptGuard("GUARD\n", () => true)
    const script = "\\connect legal\nSELECT 1;\n"
    let streamed = ""
    for (let i = 0; i < script.length; i += 3) streamed += scanner.push(script.slice(i, i + 3))
    streamed += scanner.end()
    expect(streamed.startsWith("\\connect legal\nGUARD\n")).toBe(true)
    const copyScan = createScriptGuard("GUARD\n", () => true)
    copyScan.push("COPY public.t FROM stdin;\n")
    const row = "x".repeat(1000)
    for (let n = 0; n < 2000; n += 1) copyScan.push(row)
    copyScan.push("\n\\.\n")
    expect(copyScan.bufferedBytes()).toBeLessThan(8192)
  })
})
