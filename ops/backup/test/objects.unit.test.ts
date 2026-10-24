import { describe, expect, it, vi } from "vitest"
import { pickIntactVersion } from "../objects/restore"
import { validateR2LockRules } from "../objects/protection"
import type { ObjectVersionInfo } from "../objects/s3"

describe("pickIntactVersion", () => {
  it("skips delete markers and picks newest intact version", async () => {
    const versions: ObjectVersionInfo[] = [
      { key: "k", versionId: "v1" },
      { key: "k", versionId: "v2", isDeleteMarker: true },
      { key: "k", versionId: "v3" },
    ]
    const bodies: Record<string, Buffer> = { v1: Buffer.from("bad"), v3: Buffer.from("good") }
    const id = await pickIntactVersion(
      versions,
      async (v) => bodies[v.versionId!],
      async (b) => b.toString() === "good"
    )
    expect(id).toBe("v3")
  })

  it("returns undefined when none intact", async () => {
    const versions: ObjectVersionInfo[] = [{ key: "k", versionId: "v1" }]
    const id = await pickIntactVersion(versions, async () => Buffer.from("x"), async () => false)
    expect(id).toBeUndefined()
  })
})

describe("validateR2LockRules", () => {
  it("requires id, enabled, prefix and min age", () => {
    const problems = validateR2LockRules({ rules: [{ enabled: true, condition: { maxAgeSeconds: 1 } }] }, 100)
    expect(problems.some((p) => p.includes("id"))).toBe(true)
    expect(problems.some((p) => p.includes("maxAgeSeconds"))).toBe(true)
    expect(problems.some((p) => p.includes("prefix"))).toBe(true)
  })
})
