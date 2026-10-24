import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { makeKeyRing } from "../lib/envelope.mjs"
import { restoreLogical } from "../postgres/logical"

describe("restoreLogical temp plaintext cleanup", () => {
  it("removes .globals.plain.part and .dump.part after a failed restore", async () => {
    const bundleDir = mkdtempSync(path.join(os.tmpdir(), "f33-restore-cleanup-"))
    const key = randomBytes(32)
    const ring = makeKeyRing(key)
    try {
      const res = await restoreLogical({ bundleDir, ring, db: "legal_scraper" })
      expect(res.ok).toBe(false)
      expect(existsSync(path.join(bundleDir, ".globals.plain.part"))).toBe(false)
      expect(existsSync(path.join(bundleDir, ".dump.part"))).toBe(false)
    } finally {
      rmSync(bundleDir, { recursive: true, force: true })
    }
  })
})
