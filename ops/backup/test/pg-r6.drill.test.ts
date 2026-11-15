import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeKeyRing } from "../lib/envelope.mjs"
import { PersistentPsqlSession, psqlArgv, runCommand, setPsqlQueryTimeoutForTests } from "../lib/exec"
import { backupLogical, restoreLogical } from "../postgres/logical"
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
      const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
      const res = await restoreLogical({
        bundleDir: dir,
        ring,
        db: "legal_scraper",
        env: target.env,
        expectedSystemIdentifier: target.systemIdentifier,
        recordStore: "postgres-logical-utf8",
        onPlaintext: (file) => {
          expect(readdirSync(path.dirname(file))).not.toContain("globals-applied.sql")
        },
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
})
