import { randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeKeyRing } from "../lib/envelope.mjs"
import { PersistentPsqlSession, psqlArgv, setDockerClientPathForTests, setPsqlQueryTimeoutForTests, setStdoutFaultForTests } from "../lib/exec"
import { resultsDir } from "../lib/results"
import { backupLogical, restoreLogical, setRestorePlaintextHookForTests, withIdentityGuards, identityGuardSql } from "../postgres/logical"
import { DRILL_CLUSTER_TIMEZONE, startCluster, type PgCluster } from "./helpers/cluster"
import { seedAnnexA, seedRows } from "./helpers/seeds"

const crashes: string[] = []
const onCrash = (err: Error) => {
  const code = (err as NodeJS.ErrnoException).code
  crashes.push(`${code ?? ""} ${err.message}`)
}
process.on("uncaughtException", onCrash)

function plainScratch(): string[] {
  const root = "/tmp/sikander-backup-drill"
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (name === "database.dump" || name === "globals.sql" || name === "globals-applied.sql") found.push(full)
      try {
        if (readdirSync(full)) walk(full)
      } catch {
        // a file, not a directory
      }
    }
  }
  walk(root)
  return found.filter((file) => file.includes(`${path.sep}f33-pg-plain-`))
}

async function insertText(cluster: PgCluster, table: string, body: string): Promise<void> {
  const file = path.join(cluster.dir, `${table}.sql`)
  writeFileSync(file, `CREATE TABLE public.${table} (id int PRIMARY KEY, body text);\nINSERT INTO public.${table} VALUES (1, '${body}');\n`)
  const loaded = await cluster.runAs(psqlArgv("legal_scraper", ["-f", file, "-v", "ON_ERROR_STOP=1"]))
  rmSync(file, { force: true })
  if (loaded.code !== 0) throw new Error(loaded.stderr || loaded.stdout)
}

describe("R6 restore regressions", () => {
  afterAll(() => {
    process.off("uncaughtException", onCrash)
    setPsqlQueryTimeoutForTests(120_000)
  })

  it("stdin EPIPE closes the session and the next query rejects immediately", async () => {
    const cluster = await startCluster({ port: 55460, timezone: DRILL_CLUSTER_TIMEZONE })
    const session = await PersistentPsqlSession.open([], cluster.env, "postgres")
    try {
      const pad = "-- pad\n".repeat(80_000)
      await expect(session.runScript(`SELECT 1/0;\n${pad}`)).rejects.toThrow()
      await expect(session.query("SELECT 1")).rejects.toThrow(/psql session closed/)
      expect(crashes.filter((line) => line.includes("EPIPE"))).toEqual([])
    } finally {
      session.close()
      await cluster.stop()
      expect(existsSync(cluster.dir)).toBe(false)
    }
  }, 120_000)

  it("a query timeout rejects and does not leave the waiter hanging", async () => {
    const cluster = await startCluster({ port: 55461, timezone: DRILL_CLUSTER_TIMEZONE })
    setPsqlQueryTimeoutForTests(200)
    const session = await PersistentPsqlSession.open([], cluster.env, "postgres")
    try {
      await expect(session.query("SELECT pg_sleep(30)")).rejects.toThrow(/psql query timed out/)
    } finally {
      setPsqlQueryTimeoutForTests(120_000)
      session.close()
      await cluster.stop()
      expect(existsSync(cluster.dir)).toBe(false)
    }
  }, 120_000)

  it("restores about 3 MB of Urdu text with equal digests and no replacement characters", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const out = mkdtempSync(path.join(os.tmpdir(), "f33-r6-utf8-"))
    const source = await startCluster({ port: 55462, timezone: DRILL_CLUSTER_TIMEZONE })
    const target = await startCluster({ port: 55463, timezone: DRILL_CLUSTER_TIMEZONE })
    try {
      await seedAnnexA(source)
      await seedRows(source)
      const body = "ک\u200c".repeat(600_000)
      await insertText(source, "urdu_blob", body)
      const scratchBefore = new Set(plainScratch())
      setRestorePlaintextHookForTests((file) => {
        expect(readdirSync(path.dirname(file))).not.toContain("globals-applied.sql")
      })
      const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
      const res = await restoreLogical({
        bundleDir: dir,
        ring,
        db: "legal_scraper",
        env: target.env,
        expectedSystemIdentifier: target.systemIdentifier,
        recordStore: "postgres-logical-utf8",
      })
      expect(res.ok, res.differences.join("\n")).toBe(true)
      expect(res.content.every((unit) => unit.match)).toBe(true)
      const urdu = res.content.find((unit) => unit.name === "public.urdu_blob")
      expect(urdu?.match).toBe(true)
      const count = await target.runAs(
        psqlArgv("legal_scraper", [
          "-t",
          "-A",
          "-c",
          "SELECT count(*) FROM public.urdu_blob WHERE body LIKE '%' || chr(65533) || '%';",
        ])
      )
      expect(count.code).toBe(0)
      expect(count.stdout.trim()).toBe("0")
      const size = await target.runAs(
        psqlArgv("legal_scraper", ["-t", "-A", "-c", "SELECT length(body) FROM public.urdu_blob;"])
      )
      expect(size.stdout.trim()).toBe(String(body.length))
      expect(plainScratch().filter((file) => !scratchBefore.has(file))).toEqual([])
    } finally {
      setRestorePlaintextHookForTests(null)
      await source.stop()
      await target.stop()
      expect(existsSync(source.dir)).toBe(false)
      expect(existsSync(target.dir)).toBe(false)
      rmSync(out, { recursive: true, force: true })
    }
  }, 180_000)

  it("an early restore error removes decrypted scratch and does not raise EPIPE", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const out = mkdtempSync(path.join(os.tmpdir(), "f33-r6-epipe-"))
    const source = await startCluster({ port: 55464, timezone: DRILL_CLUSTER_TIMEZONE })
    const target = await startCluster({ port: 55465, timezone: DRILL_CLUSTER_TIMEZONE })
    try {
      await seedAnnexA(source)
      await seedRows(source)
      await insertText(source, "bulk_pad", "x".repeat(2_000_000))
      const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
      const planted = await target.runAs(
        psqlArgv("template1", ["-c", "CREATE TABLE public.court (id int);", "-v", "ON_ERROR_STOP=1"])
      )
      expect(planted.code, planted.stderr).toBe(0)
      const before = crashes.length
      const scratchBefore = new Set(plainScratch())
      const res = await restoreLogical({
        bundleDir: dir,
        ring,
        db: "legal_scraper",
        env: target.env,
        expectedSystemIdentifier: target.systemIdentifier,
      })
      expect(res.ok, res.differences.join("\n")).toBe(false)
      expect(res.differences.join("\n")).toMatch(/court|already exists/)
      expect(crashes.slice(before).filter((line) => line.includes("EPIPE"))).toEqual([])
      expect(plainScratch().filter((file) => !scratchBefore.has(file))).toEqual([])
    } finally {
      await source.stop()
      await target.stop()
      expect(existsSync(source.dir)).toBe(false)
      expect(existsSync(target.dir)).toBe(false)
      rmSync(out, { recursive: true, force: true })
    }
  }, 180_000)

  it("a progressing query stays open and a stalled query is killed", async () => {
    const cluster = await startCluster({ port: 55470, timezone: DRILL_CLUSTER_TIMEZONE })
    setPsqlQueryTimeoutForTests(400)
    const session = await PersistentPsqlSession.open([], cluster.env, "postgres")
    try {
      const steps = Array.from({ length: 6 }, () => "SELECT pg_sleep(0.2); SELECT 1;").join("\n")
      await session.runScript(steps)
      await expect(session.query("SELECT pg_sleep(30)")).rejects.toThrow(/psql query timed out/)
      await expect(session.query("SELECT 1")).rejects.toThrow(/psql session closed/)
    } finally {
      setPsqlQueryTimeoutForTests(120_000)
      session.close()
      await cluster.stop()
    }
  }, 120_000)

  it("refuses meta-commands and does not write them on the decoy", async () => {
    const target = await startCluster({ port: 55472, timezone: DRILL_CLUSTER_TIMEZONE })
    const decoy = await startCluster({ port: 55473, timezone: DRILL_CLUSTER_TIMEZONE })
    const guard = identityGuardSql({
      expectedSystemIdentifier: target.systemIdentifier,
      host: target.socketDir,
      port: String(target.port),
    })
    const refused = [
      "SELECT 1\\connect B\n",
      "\\x\\c B\n",
      "/* x */\\connect B\n",
      "\\echo a\\\\\\c B\n",
      "\\ir /tmp/sikander-backup-drill/inc.sql\n",
      "\\set v 'x'\n:v\n",
      "SELECT 1;\\connect B\n",
    ]
    try {
      for (const sql of refused) {
        expect(() => withIdentityGuards(sql, guard), sql).toThrow(/not allowlisted|variable interpolation/)
      }
      const decoyConn = `"host=${decoy.socketDir} port=${decoy.port} dbname=postgres user=postgres"`
      const dollar = `CREATE FUNCTION zzf() RETURNS int LANGUAGE sql AS $q$\nCOPY zz FROM stdin;\nSELECT 1 $q$;\n\\connect ${decoyConn}\nCREATE TABLE public.zz_14 (id int);\n`
      const session = await PersistentPsqlSession.open([], target.env, "postgres")
      try {
        await expect(session.runScript(withIdentityGuards(dollar, guard))).rejects.toThrow(/does not match/)
      } finally {
        session.close()
      }
      const table = await decoy.runAs(
        psqlArgv("postgres", ["-t", "-A", "-c", "SELECT to_regclass('public.zz_14') IS NULL;"])
      )
      expect(table.stdout.trim()).toBe("t")
      const dbs = await decoy.runAs(
        psqlArgv("postgres", ["-t", "-A", "-c", "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres';"])
      )
      expect(dbs.stdout.trim()).toBe("")
    } finally {
      await target.stop()
      await decoy.stop()
    }
  }, 180_000)

  it("does not restore the dump when the globals script fails", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const out = mkdtempSync(path.join(os.tmpdir(), "f33-r7-globals-"))
    const source = await startCluster({ port: 55474, timezone: DRILL_CLUSTER_TIMEZONE })
    const target = await startCluster({ port: 55475, timezone: DRILL_CLUSTER_TIMEZONE })
    setRestorePlaintextHookForTests((file) => {
      if (file.endsWith(`${path.sep}globals.sql`)) appendFileSync(file, "\nSELECT 1/0;\n")
    })
    try {
      await seedAnnexA(source)
      await seedRows(source)
      const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
      const res = await restoreLogical({
        bundleDir: dir,
        ring,
        db: "legal_scraper",
        env: target.env,
        expectedSystemIdentifier: target.systemIdentifier,
      })
      expect(res.ok).toBe(false)
      const court = await target.runAs(
        psqlArgv("legal_scraper", ["-t", "-A", "-c", "SELECT to_regclass('public.court') IS NULL;"])
      )
      expect(court.stdout.trim()).toBe("t")
    } finally {
      setRestorePlaintextHookForTests(null)
      await source.stop()
      await target.stop()
      rmSync(out, { recursive: true, force: true })
    }
  }, 180_000)

  it("refuses a target that already has a backup role and does not create the database", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const out = mkdtempSync(path.join(os.tmpdir(), "f33-r7-role-"))
    const source = await startCluster({ port: 55476, timezone: DRILL_CLUSTER_TIMEZONE })
    const target = await startCluster({ port: 55477, timezone: DRILL_CLUSTER_TIMEZONE })
    try {
      await seedAnnexA(source)
      await seedRows(source)
      const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
      const role = await target.runAs(psqlArgv("postgres", ["-c", "CREATE ROLE corpus_reader NOINHERIT LOGIN;"]))
      expect(role.code, role.stderr).toBe(0)
      const res = await restoreLogical({
        bundleDir: dir,
        ring,
        db: "legal_scraper",
        env: target.env,
        expectedSystemIdentifier: target.systemIdentifier,
      })
      expect(res.ok).toBe(false)
      expect(res.differences.join("\n")).toMatch(/corpus_reader/)
      const dbs = await target.runAs(
        psqlArgv("postgres", ["-t", "-A", "-c", "SELECT count(*) FROM pg_database WHERE datname = 'legal_scraper';"])
      )
      expect(dbs.stdout.trim()).toBe("0")
    } finally {
      await source.stop()
      await target.stop()
      rmSync(out, { recursive: true, force: true })
    }
  }, 180_000)

  it("records the docker prefix after a successful restore", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const out = mkdtempSync(path.join(os.tmpdir(), "f33-r7-docker-"))
    const wrap = mkdtempSync(path.join(os.tmpdir(), "f33-r7-dockerbin-"))
    const source = await startCluster({ port: 55478, timezone: DRILL_CLUSTER_TIMEZONE })
    const target = await startCluster({ port: 55479, timezone: DRILL_CLUSTER_TIMEZONE })
    const prefix = ["docker", "exec", "-i", "pg"]
    writeFileSync(
      path.join(wrap, "docker"),
      "#!/bin/bash\nset -a\n. /tmp/sikander-backup-drill/m18-target.env\nset +a\nshift 3\nexec \"$@\"\n"
    )
    chmodSync(path.join(wrap, "docker"), 0o755)
    writeFileSync(
      "/tmp/sikander-backup-drill/m18-target.env",
      `PATH=${target.env.PATH}\nPGHOST=${target.env.PGHOST}\nPGPORT=${target.env.PGPORT}\nPGUSER=${target.env.PGUSER}\n`
    )
    setDockerClientPathForTests(wrap)
    try {
      await seedAnnexA(source)
      await seedRows(source)
      const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
      const res = await restoreLogical({
        bundleDir: dir,
        ring,
        db: "legal_scraper",
        env: target.env,
        expectedSystemIdentifier: target.systemIdentifier,
        pgPrefix: prefix,
        recordStore: "postgres-logical-docker-ok",
      })
      expect(res.ok, res.differences.join("\n")).toBe(true)
      const report = JSON.parse(readFileSync(path.join(resultsDir(), "postgres-logical-docker-ok.json"), "utf8")) as {
        commandPrefix: string[]
      }
      expect(report.commandPrefix).toEqual(prefix)
    } finally {
      setDockerClientPathForTests(null)
      await source.stop()
      await target.stop()
      rmSync(out, { recursive: true, force: true })
      rmSync(wrap, { recursive: true, force: true })
    }
  }, 180_000)

  it("refuses a socket swap found after the dump is decrypted", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const out = mkdtempSync(path.join(os.tmpdir(), "f33-r7-drift-dump-"))
    const source = await startCluster({ port: 55482, timezone: DRILL_CLUSTER_TIMEZONE })
    const target = await startCluster({ port: 55483, timezone: DRILL_CLUSTER_TIMEZONE })
    const decoy = await startCluster({ port: 55484, timezone: DRILL_CLUSTER_TIMEZONE })
    const held = `${target.socketDir}.held`
    let swapped = false
    setRestorePlaintextHookForTests((file) => {
      if (!file.endsWith(`${path.sep}database.dump`) || swapped) return
      if (existsSync(target.socketDir) && !lstatSync(target.socketDir).isSymbolicLink()) {
        renameSync(target.socketDir, held)
        symlinkSync(decoy.socketDir, target.socketDir)
        swapped = true
      }
    })
    setStdoutFaultForTests(() => {
      if (!swapped || !existsSync(target.socketDir) || !lstatSync(target.socketDir).isSymbolicLink()) return
      rmSync(target.socketDir)
      if (existsSync(held)) renameSync(held, target.socketDir)
    })
    try {
      await seedAnnexA(source)
      await seedRows(source)
      const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
      const res = await restoreLogical({
        bundleDir: dir,
        ring,
        db: "legal_scraper",
        env: target.env,
        expectedSystemIdentifier: target.systemIdentifier,
      })
      expect(res.ok, res.differences.join("\n")).toBe(false)
      expect(res.differences.join("\n")).toMatch(/socket directory/)
      expect(existsSync(held) || lstatSync(target.socketDir).isSymbolicLink()).toBe(true)
      const dbs = await decoy.runAs(
        psqlArgv("postgres", ["-t", "-A", "-c", "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres';"])
      )
      expect(dbs.stdout.trim()).toBe("")
    } finally {
      setStdoutFaultForTests(null)
      setRestorePlaintextHookForTests(null)
      try {
        if (existsSync(target.socketDir) && lstatSync(target.socketDir).isSymbolicLink()) rmSync(target.socketDir)
      } catch { /* already restored */ }
      try {
        if (!existsSync(target.socketDir) && existsSync(held)) renameSync(held, target.socketDir)
      } catch { /* the folder was not swapped */ }
      await source.stop()
      await target.stop()
      await decoy.stop()
      rmSync(out, { recursive: true, force: true })
    }
  }, 180_000)

  it("refuses a socket swap found after the restore statements", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const out = mkdtempSync(path.join(os.tmpdir(), "f33-r7-drift-write-"))
    const source = await startCluster({ port: 55485, timezone: DRILL_CLUSTER_TIMEZONE })
    const target = await startCluster({ port: 55486, timezone: DRILL_CLUSTER_TIMEZONE })
    const decoy = await startCluster({ port: 55487, timezone: DRILL_CLUSTER_TIMEZONE })
    const held = `${target.socketDir}.held`
    let armed = false
    let swapped = false
    setRestorePlaintextHookForTests((file) => {
      if (file.endsWith(`${path.sep}database.dump`)) armed = true
    })
    setStdoutFaultForTests((chunk) => {
      if (!armed || swapped) return
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      if (!text.includes("\\restrict") && !text.includes("COPY ")) return
      if (!existsSync(target.socketDir) || lstatSync(target.socketDir).isSymbolicLink()) return
      renameSync(target.socketDir, held)
      symlinkSync(decoy.socketDir, target.socketDir)
      swapped = true
    })
    try {
      await seedAnnexA(source)
      await seedRows(source)
      const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
      const res = await restoreLogical({
        bundleDir: dir,
        ring,
        db: "legal_scraper",
        env: target.env,
        expectedSystemIdentifier: target.systemIdentifier,
      })
      expect(swapped).toBe(true)
      expect(res.ok, res.differences.join("\n")).toBe(false)
      expect(res.differences.join("\n")).toMatch(/socket directory/)
    } finally {
      setStdoutFaultForTests(null)
      setRestorePlaintextHookForTests(null)
      try {
        if (existsSync(target.socketDir) && lstatSync(target.socketDir).isSymbolicLink()) rmSync(target.socketDir)
      } catch { /* already restored */ }
      try {
        if (!existsSync(target.socketDir) && existsSync(held)) renameSync(held, target.socketDir)
      } catch { /* the folder was not swapped */ }
      await source.stop()
      await target.stop()
      await decoy.stop()
      rmSync(out, { recursive: true, force: true })
    }
  }, 180_000)

  it("a stdout handler throw removes plaintext and stops the clusters", async () => {
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    const out = mkdtempSync(path.join(os.tmpdir(), "f33-r7-fault-"))
    const source = await startCluster({ port: 55480, timezone: DRILL_CLUSTER_TIMEZONE })
    const target = await startCluster({ port: 55481, timezone: DRILL_CLUSTER_TIMEZONE })
    try {
      await seedAnnexA(source)
      await seedRows(source)
      const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
      const scratchBefore = new Set(plainScratch())
      setRestorePlaintextHookForTests((file) => {
        if (file.endsWith(`${path.sep}database.dump`)) {
          setStdoutFaultForTests(() => {
            throw new Error("handler fault")
          })
        }
      })
      const res = await restoreLogical({
        bundleDir: dir,
        ring,
        db: "legal_scraper",
        env: target.env,
        expectedSystemIdentifier: target.systemIdentifier,
      })
      expect(res.ok).toBe(false)
      expect(res.differences.join("\n")).toMatch(/handler fault/)
      expect(plainScratch().filter((file) => !scratchBefore.has(file))).toEqual([])
      expect(existsSync(source.dir)).toBe(false)
      expect(existsSync(target.dir)).toBe(false)
    } finally {
      setStdoutFaultForTests(null)
      setRestorePlaintextHookForTests(null)
      await source.stop()
      await target.stop()
      rmSync(out, { recursive: true, force: true })
    }
  }, 180_000)
})
