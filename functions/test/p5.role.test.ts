import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { ROLES, type Role } from "../src/p5/auth"

// `Role` is mirrored locally (importing store.ts drags its unrelated type errors
// into the functions typecheck). This test fails if the two unions drift.
describe("Role mirror", () => {
  it("matches `export type Role` in platform/spine/store.ts", () => {
    const src = readFileSync(path.resolve(__dirname, "../../platform/spine/store.ts"), "utf8")
    const m = /export type Role\s*=([\s\S]*?)(?:\n\s*\n|\nexport )/.exec(src)
    expect(m, "export type Role not found in store.ts").not.toBeNull()
    const upstream = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
    expect(upstream.length).toBeGreaterThan(0)
    expect([...ROLES].sort()).toEqual([...upstream].sort())
  })

  it("ROLES and the Role type agree at compile time", () => {
    // Both directions: every ROLES entry is a Role, and every Role is in ROLES.
    type Listed = (typeof ROLES)[number]
    const forward: Role = "" as Listed
    const backward: Listed = "" as Role
    expect([forward, backward]).toBeDefined()
  })
})
