import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { startCluster } from "./helpers/cluster"
import { seedAnnexA, seedRows } from "./helpers/seeds"
import { backupLogical, restoreLogical } from "../postgres/logical"
import { makeKeyRing } from "../lib/envelope.mjs"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCommand, psqlArgv } from "../lib/exec"

describe("postgres logical backup drill", () => {
  it(
    "backup and restore into a second cluster",
    async () => {
      const key = randomBytes(32)
      const ring = makeKeyRing(key)
      const out = mkdtempSync(path.join(os.tmpdir(), "f33-bundles-"))
      const source = await startCluster({ port: 55432 })
      const target = await startCluster({ port: 55433 })
      try {
        await seedAnnexA(source)
        await seedRows(source)
        const { dir } = await backupLogical({ db: "legal_scraper", outRoot: out, key, env: source.env })
        await source.runAs(psqlArgv("postgres", ["-c", "DROP DATABASE legal_scraper WITH (FORCE);"]))
        const res = await restoreLogical({
          bundleDir: dir,
          ring,
          db: "legal_scraper_restored",
          env: target.env,
          recordStore: "postgres-logical",
        })
        expect(res.ok, res.differences.join("\n")).toBe(true)
      } finally {
        await source.stop()
        await target.stop()
        rmSync(out, { recursive: true, force: true })
      }
    },
    120_000
  )
})
