import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
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
      psqlArgv("postgres", ["-v", "ON_ERROR_STOP=1", "-c", "DROP DATABASE IF EXISTS legal_scraper WITH (FORCE);"])
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

  async function names(cluster: PgCluster, sql: string): Promise<string[]> {
    const listed = await cluster.runAs(psqlArgv("postgres", ["-t", "-A", "-c", sql]))
    expect(listed.code, listed.stderr || listed.stdout).toBe(0)
    return listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  }

  function userDatabases(cluster: PgCluster): Promise<string[]> {
    return names(
      cluster,
      "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres' ORDER BY 1;"
    )
  }

  function userRoles(cluster: PgCluster): Promise<string[]> {
    return names(
      cluster,
      "SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg_%' AND rolname <> 'postgres' ORDER BY 1;"
    )
  }

  async function expectClusterUnwritten(cluster: PgCluster): Promise<void> {
    expect(await userDatabases(cluster)).toEqual([])
    expect(await userRoles(cluster)).toEqual([])
  }

  async function expectDecoyUntouched(res: { ok: boolean; differences: string[] }): Promise<void> {
    expect(res.ok, res.differences.join("\n")).toBe(false)
    expect(await databaseCount(decoy)).toBe(0)
    expect(await databaseCount(target)).toBe(0)
    await expectClusterUnwritten(decoy)
    await expectClusterUnwritten(target)
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
      `[decoy]\nhost=${decoy.socketDir}\nport=${decoy.port}\nuser=postgres\ndbname=legal_scraper\n`
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
    const conninfo = `host=${decoy.socketDir} port=${decoy.port} dbname=legal_scraper user=postgres`
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
    symlinkSync(decoy.socketDir, link)
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
      pgPrefix: [wrapper, decoy.socketDir, String(decoy.port)],
    })
    expect(res.ok, res.differences.join("\n")).toBe(false)
    expect(res.differences.join("\n")).toMatch(/allowlisted docker exec/)
    await expectClusterUnwritten(decoy)
    await expectClusterUnwritten(target)
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
        pgPrefix: [wrapper, decoy.socketDir, String(decoy.port)],
      })
      expect(res.ok, res.differences.join("\n")).toBe(false)
      await expectClusterUnwritten(decoy)
      await expectClusterUnwritten(target)
      expect(res.differences.join("\n")).toMatch(/allowlisted docker exec/)
    } finally {
      await dropDatabase(decoy)
      await dropExtraRoles(decoy)
    }
  }, 120_000)

  it("refuses when the socket file is replaced after the identity query", async () => {
    const wrapper = path.join(out, "swap-socket.sh")
    const targetSock = path.join(target.socketDir, `.s.PGSQL.${target.port}`)
    const decoySock = path.join(decoy.socketDir, `.s.PGSQL.${decoy.port}`)
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
      expect(res.differences.join("\n")).toMatch(/allowlisted docker exec/)
      await expectClusterUnwritten(decoy)
      await expectClusterUnwritten(target)
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
      const report = JSON.parse(readFileSync(path.resolve(__dirname, "../.results/postgres-logical-bypass.json"), "utf8")) as {
        commandPrefix?: string[]
      }
      expect(report.commandPrefix).toEqual([])
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

  it("R4-L1 refuses a restore aimed at the decoy before any database or role is written", async () => {
    const res = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      expectedSystemIdentifier: targetId,
      env: decoy.env,
    })
    await expectClusterUnwritten(decoy)
    expect(res.ok, res.differences.join("\n")).toBe(false)
    expect(res.differences.join("\n")).toMatch(/system identifier/)
  }, 120_000)

  it("R4-L2 refuses a tee prefix that would copy writes onto the decoy", async () => {
    const wrapper = path.join(out, "tee-both.sh")
    writeFileSync(
      wrapper,
      `#!/bin/bash
set -euo pipefail
decoy_host="$1"
decoy_port="$2"
shift 2
args=("$@")
copy=()
skip_next=0
for i in "\${!args[@]}"; do
  if [[ $skip_next -eq 1 ]]; then
    skip_next=0
    continue
  fi
  if [[ "\${args[$i]}" == "-d" ]]; then
    orig="\${args[$((i+1))]}"
    dbname="postgres"
    if [[ "$orig" =~ dbname=([^[:space:]\\']+) ]]; then
      dbname="\${BASH_REMATCH[1]}"
    fi
    copy+=("-d" "host=\${decoy_host} port=\${decoy_port} dbname=\${dbname} user=postgres")
    skip_next=1
  else
    copy+=("\${args[$i]}")
  fi
done
joined="\${args[*]}"
interactive=1
for a in "\${args[@]}"; do
  if [[ "$a" == "-c" || "$a" == "-f" || "$a" == "pg_restore" ]]; then
    interactive=0
  fi
done
if [[ $interactive -eq 0 && "$joined" != *inet_server_addr* ]]; then
  "\${copy[@]}" >/dev/null 2>&1 || true
fi
exec "\${args[@]}"
`
    )
    chmodSync(wrapper, 0o755)
    try {
      await dropDatabase(target)
      await dropExtraRoles(target)
      await dropDatabase(decoy)
      await dropExtraRoles(decoy)
      const res = await restoreLogical({
        bundleDir,
        ring,
        db: "legal_scraper",
        expectedSystemIdentifier: targetId,
        env: target.env,
        pgPrefix: [wrapper, decoy.socketDir, String(decoy.port)],
      })
      expect(res.ok, res.differences.join("\n")).toBe(false)
      expect(res.differences.join("\n")).toMatch(/allowlisted docker exec/)
      await expectClusterUnwritten(decoy)
    } finally {
      await dropDatabase(decoy)
      await dropExtraRoles(decoy)
      await dropDatabase(target)
      await dropExtraRoles(target)
    }
  }, 180_000)

  it("R4-L3 refuses a socket-folder swap onto the decoy and writes nothing there", async () => {
    const held = `${target.socketDir}.held`
    let swapped = false
    const swap = () => {
      if (swapped) return
      try {
        if (!existsSync(target.socketDir) || lstatSync(target.socketDir).isSymbolicLink()) return
        renameSync(target.socketDir, held)
        symlinkSync(decoy.socketDir, target.socketDir)
        swapped = true
      } catch {
        swapped = false
      }
    }
    await dropDatabase(target)
    await dropExtraRoles(target)
    const seen: string[] = []
    try {
      const res = await restoreLogical({
        bundleDir,
        ring,
        db: "legal_scraper",
        expectedSystemIdentifier: targetId,
        env: target.env,
        onPlaintext: async (file) => {
          seen.push(path.basename(file))
          swap()
        },
      })
      expect(swapped).toBe(true)
      expect(seen).toContain("globals.sql")
      expect(seen).not.toContain("globals-applied.sql")
      expect(res.ok, res.differences.join("\n")).toBe(false)
      expect(res.differences.join("\n")).toMatch(/socket directory/)
      await expectClusterUnwritten(decoy)
    } finally {
      try {
        if (existsSync(target.socketDir) && lstatSync(target.socketDir).isSymbolicLink()) rmSync(target.socketDir)
      } catch {
        // already restored
      }
      try {
        if (!existsSync(target.socketDir) && existsSync(held)) renameSync(held, target.socketDir)
      } catch {
        // the folder was not swapped
      }
      await dropDatabase(decoy)
      await dropExtraRoles(decoy)
      await dropDatabase(target)
      await dropExtraRoles(target)
    }
  }, 180_000)

  it("R4-L3 env scrub drops PGSSLMODE before the restore connects", async () => {
    const res = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      expectedSystemIdentifier: targetId,
      env: { ...target.env, PGSSLMODE: "require" },
      recordStore: "postgres-logical-scrub",
    })
    expect(res.ok, res.differences.join("\n")).toBe(true)
    await expectClusterUnwritten(decoy)
  }, 180_000)

  it("records an allowlisted docker exec prefix in the drill report", async () => {
    const bin = path.join(out, "docker-bin")
    mkdirSync(bin, { recursive: true })
    const docker = path.join(bin, "docker")
    const sentinel = path.join(out, "path-docker-ran")
    writeFileSync(
      docker,
      `#!/bin/bash
set -euo pipefail
touch ${JSON.stringify(sentinel)}
[[ "\${1:-}" == "exec" ]]
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    psql|pg_restore|pg_dump|pg_dumpall) break ;;
    *) shift ;;
  esac
done
exec "$@"
`
    )
    chmodSync(docker, 0o755)
    const prefix = ["docker", "exec", "-i", "drill-pg"]
    await dropDatabase(target)
    await dropExtraRoles(target)
    const res = await restoreLogical({
      bundleDir,
      ring,
      db: "legal_scraper",
      expectedSystemIdentifier: targetId,
      env: {
        ...target.env,
        PATH: `${bin}:${target.env.PATH ?? ""}`,
        DOCKER_HOST: "tcp://127.0.0.1:1",
        DOCKER_CONTEXT: "not-a-context",
      },
      pgPrefix: prefix,
      recordStore: "postgres-logical-prefix",
    })
    expect(existsSync(sentinel)).toBe(false)
    expect(res.ok, res.differences.join("\n")).toBe(false)
    const body = JSON.parse(readFileSync(path.resolve(__dirname, "../.results/postgres-logical-prefix.json"), "utf8")) as {
      commandPrefix?: string[]
    }
    expect(body.commandPrefix).toEqual(prefix)
    await expectClusterUnwritten(decoy)
    await expectClusterUnwritten(target)
  }, 180_000)
})
