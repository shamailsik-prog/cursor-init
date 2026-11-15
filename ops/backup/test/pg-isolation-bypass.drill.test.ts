import { randomBytes } from "node:crypto"
import { chmodSync, lstatSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { insideTempDir, isolationProblems } from "../drill/target"
import { makeKeyRing } from "../lib/envelope.mjs"
import { psqlArgv } from "../lib/exec"
import { backupLogical, restoreLogical } from "../postgres/logical"
import { DRILL_CLUSTER_TIMEZONE, startCluster, type PgCluster } from "./helpers/cluster"
import { seedAnnexA, seedRows } from "./helpers/seeds"

/**
 * B1–B5 and a command prefix, each against two disposable clusters.
 * The decoy is the unchecked cluster. A bypass that still returns ok, or that creates
 * legal_scraper there, is a failed isolation claim.
 */
describe("postgres restore isolation bypasses", () => {
  let source: PgCluster
  let target: PgCluster
  let decoy: PgCluster
  let bundleDir: string
  let out: string
  let ring: ReturnType<typeof makeKeyRing>
  let targetId: string
  const priorTmp = process.env.TMPDIR

  async function databaseCount(cluster: PgCluster): Promise<number> {
    const listed = await cluster.runAs(
      psqlArgv("postgres", ["-t", "-A", "-c", "SELECT count(*) FROM pg_database WHERE datname = 'legal_scraper';"])
    )
    expect(listed.code, listed.stderr || listed.stdout).toBe(0)
    return Number(listed.stdout.trim())
  }

  beforeAll(async () => {
    const key = randomBytes(32)
    ring = makeKeyRing(key)
    out = mkdtempSync(path.join(os.tmpdir(), "f33-bypass-bundles-"))
    source = await startCluster({ port: 56132, timezone: DRILL_CLUSTER_TIMEZONE })
    target = await startCluster({ port: 56133, timezone: DRILL_CLUSTER_TIMEZONE })
    decoy = await startCluster({ port: 56134, timezone: DRILL_CLUSTER_TIMEZONE })
    await seedAnnexA(source)
    await seedRows(source)
    const backed = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
    bundleDir = backed.dir
    const ident = await target.runAs(
      psqlArgv("postgres", ["-t", "-A", "-c", "SELECT system_identifier::text FROM pg_control_system();"])
    )
    expect(ident.code, ident.stderr || ident.stdout).toBe(0)
    targetId = ident.stdout.trim()
  }, 180_000)

  afterAll(async () => {
    if (priorTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = priorTmp
    await source?.stop()
    await target?.stop()
    await decoy?.stop()
    if (out) rmSync(out, { recursive: true, force: true })
  }, 60_000)

  async function dropDatabase(cluster: PgCluster): Promise<void> {
    const dropped = await cluster.runAs(
      psqlArgv("postgres", ["-v", "ON_ERROR_STOP=1", "-c", "DROP DATABASE IF EXISTS legal_scraper;"])
    )
    expect(dropped.code, dropped.stderr || dropped.stdout).toBe(0)
  }

  async function dropExtraRoles(cluster: PgCluster): Promise<void> {
    const listed = await cluster.runAs(
      psqlArgv("postgres", [
        "-t",
        "-A",
        "-c",
        "SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg_%' AND rolname <> 'postgres';",
      ])
    )
    expect(listed.code, listed.stderr || listed.stdout).toBe(0)
    for (const role of listed.stdout.split("\n").map((name) => name.trim()).filter(Boolean)) {
      const dropped = await cluster.runAs(
        psqlArgv("postgres", ["-c", `DROP OWNED BY "${role}" CASCADE; DROP ROLE "${role}";`])
      )
      expect(dropped.code, dropped.stderr || dropped.stdout).toBe(0)
    }
  }

  async function expectDecoyUntouched(res: { ok: boolean; differences: string[] }): Promise<void> {
    expect(res.ok, res.differences.join("\n")).toBe(false)
    expect(await databaseCount(decoy)).toBe(0)
    expect(await databaseCount(target)).toBe(0)
  }

  it("B1 refuses PGHOSTADDR and does not restore into the unchecked cluster", async () => {
    const res = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      expectedSystemIdentifier: targetId,
      env: { ...target.env, PGHOSTADDR: "127.0.0.1", PGPORT: String(decoy.port) },
    })
    expect(res.differences.join("\n")).toMatch(/PGHOSTADDR/)
    await expectDecoyUntouched(res)
  }, 120_000)

  it("B2 refuses PGSERVICE and PGSERVICEFILE", async () => {
    const serviceFile = path.join(out, "pg_service.conf")
    writeFileSync(
      serviceFile,
      `[decoy]\nhost=${decoy.dir}\nport=${decoy.port}\nuser=postgres\ndbname=legal_scraper\n`
    )
    const byName = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      expectedSystemIdentifier: targetId,
      env: { ...target.env, PGSERVICE: "decoy", PGSERVICEFILE: serviceFile },
    })
    expect(byName.differences.join("\n")).toMatch(/PGSERVICE/)
    await expectDecoyUntouched(byName)

    const byFile = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      expectedSystemIdentifier: targetId,
      env: { ...target.env, PGSERVICEFILE: serviceFile },
    })
    expect(byFile.differences.join("\n")).toMatch(/PGSERVICEFILE/)
    await expectDecoyUntouched(byFile)

    const passFile = path.join(out, "pgpass")
    writeFileSync(passFile, `127.0.0.1:${decoy.port}:legal_scraper:postgres:secret\n`, { mode: 0o600 })
    const byPass = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      expectedSystemIdentifier: targetId,
      env: { ...target.env, PGPASSFILE: passFile },
    })
    expect(byPass.differences.join("\n")).toMatch(/PGPASSFILE/)
    await expectDecoyUntouched(byPass)
  }, 120_000)

  it("B3 refuses a conninfo or URI passed as the database name", async () => {
    const conninfo = `host=${decoy.dir} port=${decoy.port} dbname=legal_scraper user=postgres`
    const asConn = await restoreLogical({
      bundleDir,
      ring,
      db: conninfo,
      expectedSystemIdentifier: targetId,
      env: target.env,
    })
    expect(asConn.differences.join("\n")).toMatch(/conninfo or URI/)
    await expectDecoyUntouched(asConn)

    const asUri = await restoreLogical({
      bundleDir,
      ring,
      db: `postgresql://127.0.0.1:${decoy.port}/legal_scraper`,
      expectedSystemIdentifier: targetId,
      env: target.env,
    })
    expect(asUri.differences.join("\n")).toMatch(/conninfo or URI/)
    await expectDecoyUntouched(asUri)
  }, 120_000)

  it("B4 refuses a symlink socket directory and does not follow it to the unchecked cluster", async () => {
    const link = path.join(out, "socket-link")
    symlinkSync(decoy.dir, link)
    const res = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      expectedSystemIdentifier: targetId,
      env: { ...target.env, PGHOST: link },
    })
    expect(res.differences.join("\n")).toMatch(/symlink/)
    await expectDecoyUntouched(res)
  }, 120_000)

  it("B5 refuses TMPDIR=/ with a path outside the drill root", async () => {
    process.env.TMPDIR = "/"
    try {
      expect(insideTempDir("/opt/production-pgdata")).toBe(false)
      const problems = isolationProblems({
        kind: "temp",
        engine: "postgres",
        host: "/opt/production-pgdata",
        database: "legal_scraper",
        dataDir: "/opt/production-pgdata",
      })
      expect(problems.join("\n")).toMatch(/isolated temp/)
      const res = await restoreLogical({
        bundleDir,
        ring,
        db: "legal_scraper",
        expectedSystemIdentifier: targetId,
        env: { ...target.env, PGHOST: "/opt/production-pgdata", PGPORT: String(decoy.port) },
      })
      expect(res.differences.join("\n")).toMatch(/isolated temp/)
      await expectDecoyUntouched(res)
    } finally {
      if (priorTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = priorTmp
    }
  }, 120_000)

  it("L3 a command prefix that retargets psql fails the post-connect system identifier check", async () => {
    const wrapper = path.join(out, "redirect-psql.sh")
    writeFileSync(
      wrapper,
      `#!/bin/bash
set -euo pipefail
decoy_host="$1"
decoy_port="$2"
shift 2
args=("$@")
for i in "\${!args[@]}"; do
  if [[ "\${args[$i]}" == "-d" ]]; then
    orig="\${args[$((i+1))]}"
    dbname="postgres"
    if [[ "$orig" =~ dbname=([^[:space:]\\']+) ]]; then
      dbname="\${BASH_REMATCH[1]}"
    fi
    args[$((i+1))]="host=\${decoy_host} port=\${decoy_port} dbname=\${dbname} user=postgres"
  fi
done
exec "\${args[@]}"
`
    )
    chmodSync(wrapper, 0o755)
    const res = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      expectedSystemIdentifier: targetId,
      env: target.env,
      pgPrefix: [wrapper, decoy.dir, String(decoy.port)],
    })
    expect(res.ok, res.differences.join("\n")).toBe(false)
    expect(res.differences.join("\n")).toMatch(/system identifier/)
    expect(await databaseCount(decoy)).toBe(0)
  }, 120_000)

  it("CLAIM-R2-001 a prefix that forwards only the identity query is refused", async () => {
    const wrapper = path.join(out, "identity-only.sh")
    writeFileSync(
      wrapper,
      `#!/bin/bash
set -euo pipefail
decoy_host="$1"
decoy_port="$2"
shift 2
args=("$@")
sql=""
for a in "\${args[@]}"; do
  if [[ "$a" == *inet_server_addr* ]]; then
    sql="$a"
  fi
done
if [[ -n "$sql" && "$sql" != *pg_class* && "$sql" != *information_schema* && "$sql" != *pg_namespace* ]]; then
  exec "\${args[@]}"
fi
for i in "\${!args[@]}"; do
  if [[ "\${args[$i]}" == "-d" ]]; then
    orig="\${args[$((i+1))]}"
    dbname="postgres"
    if [[ "$orig" =~ dbname=([^[:space:]\\']+) ]]; then
      dbname="\${BASH_REMATCH[1]}"
    fi
    args[$((i+1))]="host=\${decoy_host} port=\${decoy_port} dbname=\${dbname} user=postgres"
  fi
done
exec "\${args[@]}"
`
    )
    chmodSync(wrapper, 0o755)
    try {
      const res = await restoreLogical({
        bundleDir,
        ring,
        db: "legal_scraper",
        expectedSystemIdentifier: targetId,
        env: target.env,
        pgPrefix: [wrapper, decoy.dir, String(decoy.port)],
      })
      expect(res.ok, res.differences.join("\n")).toBe(false)
      expect(res.differences.join("\n")).toMatch(/system identifier/)
    } finally {
      await dropDatabase(decoy)
    }
  }, 120_000)

  it("refuses when the socket file is replaced after the identity query", async () => {
    const wrapper = path.join(out, "swap-socket.sh")
    const targetSock = path.join(target.dir, `.s.PGSQL.${target.port}`)
    const decoySock = path.join(decoy.dir, `.s.PGSQL.${decoy.port}`)
    writeFileSync(
      wrapper,
      `#!/bin/bash
set -euo pipefail
decoy_sock="$1"
target_sock="$2"
shift 2
args=("$@")
joined="\${args[*]}"
if [[ "$joined" == *pg_restore* && ! -L "$target_sock" ]]; then
  mv "$target_sock" "\${target_sock}.real"
  ln -s "$decoy_sock" "$target_sock"
fi
exec "\${args[@]}"
`
    )
    chmodSync(wrapper, 0o755)
    const held = `${targetSock}.real`
    try {
      const res = await restoreLogical({
        bundleDir,
        ring,
        db: "legal_scraper",
        expectedSystemIdentifier: targetId,
        env: target.env,
        pgPrefix: [wrapper, decoySock, targetSock],
      })
      expect(res.ok, res.differences.join("\n")).toBe(false)
      expect(res.differences.join("\n")).toMatch(/postgres socket is a symlink|postgres socket changed after the restore/)
    } finally {
      try {
        if (lstatSync(targetSock).isSymbolicLink()) rmSync(targetSock)
      } catch {
        // the socket path is already gone
      }
      try {
        renameSync(held, targetSock)
      } catch {
        // pg_restore never swapped the socket
      }
      await dropDatabase(decoy)
      await dropDatabase(target)
      await dropExtraRoles(target)
    }
  }, 120_000)

  it("F24 refuses a restore that does not name the expected system identifier", async () => {
    const res = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      env: target.env,
    })
    expect(res.ok, res.differences.join("\n")).toBe(false)
    expect(res.differences).toEqual(["expected cluster system identifier is required"])
    expect(await databaseCount(decoy)).toBe(0)
  }, 120_000)

  it("restores only the drill cluster when TMPDIR is /", async () => {
    process.env.TMPDIR = "/"
    try {
      const res = await restoreLogical({
        bundleDir,
        ring,
        db: "legal_scraper",
        expectedSystemIdentifier: targetId,
        env: target.env,
        recordStore: "postgres-logical-bypass",
      })
      expect(res.ok, res.differences.join("\n")).toBe(true)
      expect(res.content.length).toBeGreaterThan(0)
      expect(await databaseCount(target)).toBe(1)
      expect(await databaseCount(decoy)).toBe(0)
      const again = await restoreLogical({
        bundleDir,
        ring,
        db: "legal_scraper",
        expectedSystemIdentifier: targetId,
        env: target.env,
        recordStore: "postgres-logical-bypass",
      })
      expect(again.ok, again.differences.join("\n")).toBe(true)
      expect(again.idempotent).toBe(true)
    } finally {
      if (priorTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = priorTmp
    }
  }, 180_000)
})
