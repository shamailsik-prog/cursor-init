import fs from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { adminDb } from "../src/admin"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { viaApi } from "./api"
import { registryRecorder } from "./setup/registryWriteRecorder"

/**
 * Spec P3-20, recorder self-checks not selected by the G-4 gate: (1) real stack attribution, by
 * driving a real functions/src registry writer (disputeLink) with `bumpRegistryVersion` turned into
 * a no-op, without `attributeTo`; (2) functions/src uses no SDK write path the recorder cannot see.
 */

const bump = vi.hoisted(() => ({ skip: false }))
vi.mock("../src/d1/registryVersion", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/d1/registryVersion")>()
  return {
    ...real,
    bumpRegistryVersion: (...args: Parameters<typeof real.bumpRegistryVersion>) => (bump.skip ? undefined : real.bumpRegistryVersion(...args)),
  }
})

const registerClient = viaApi<{ clientId: string; entityId: string }>("registerClient")
const disputeLink = viaApi<{ state: string; disputed: boolean }>("disputeLink")
const CNIC = "4210112345671"

describe.skipIf(!EMULATORS)("Registry-version recorder attribution (P3-20)", () => {
  it("a real functions/src writer that skips its bump is reported at its own file and line", async () => {
    const firmId = uniq("firm")
    await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
    const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
    const reg = (name: string, mobile: string) =>
      registerClient({
        token: partner.token,
        data: { firmId, name, type: "individual", primaryMobile: mobile, cnic: CNIC, classification: "internal" },
      } as never)
    const a = await reg("Muhammad Ali", "03024100001")
    const b = await reg("Mohammad Ali Khan", "03024100002")
    const [left, right] = [a.entityId, b.entityId].sort()
    const linkId = `${firmId}_${left}_${right}_cnic`

    bump.skip = true
    try {
      const out = await disputeLink({ token: partner.token, data: { firmId, linkId, note: "Same CNIC and name on both intake forms, checked." } } as never)
      expect(out.disputed).toBe(true)
    } finally {
      bump.skip = false
    }
    const found = registryRecorder.take()
    expect(found.length).toBeGreaterThan(0)
    for (const v of found) {
      expect(v).toMatchObject({ file: "functions/src/d1/entity/ops.ts", collection: "entity_links", reason: "no_bump" })
      expect(v.line).toBeGreaterThan(0)
    }
  })
})

describe("Registry-version recorder blind spots (P3-20)", () => {
  it("functions/src uses no BulkWriter or recursiveDelete (write paths the recorder does not patch)", () => {
    const src = path.resolve(__dirname, "../src")
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.[cm]?[jt]s$/.test(e.name) && /\b(bulkWriter|recursiveDelete)\s*\(/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(src, p))
      }
    }
    walk(src)
    expect(offenders).toEqual([])
  })
})
