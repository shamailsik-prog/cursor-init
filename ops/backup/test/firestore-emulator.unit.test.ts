import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openBundleFile, verifyBundle } from "../lib/bundle"
import { makeKeyRing } from "../lib/envelope.mjs"
import * as exec from "../lib/exec"
import { backupFirestoreEmulator } from "../firestore/emulator"
import { pipeline } from "node:stream/promises"

vi.mock("../firestore/manifest", () => ({
  collectFirestoreManifest: vi.fn(async () => ({
    collections: {},
    firms: {},
    relationships: {},
  })),
}))

let root: string
let exportDir: string
let realRunCommand: typeof exec.runCommand

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "f33-fs-emulator-"))
  exportDir = path.join(root, "export")
  mkdirSync(exportDir, { recursive: true })
  writeFileSync(path.join(exportDir, "marker.bin"), Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  realRunCommand = exec.runCommand
  vi.spyOn(exec, "runCommand").mockImplementation(async (argv, opts) => {
    if (argv[0] === "firebase" && argv[1] === "emulators:export") {
      return { code: 0, stdout: "", stderr: "" }
    }
    if (argv[0] === "tar") {
      return realRunCommand(argv, opts)
    }
    throw new Error(`unexpected argv: ${argv.join(" ")}`)
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("backupFirestoreEmulator", () => {
  it("bundles the export directory bytes as export.tar (not only a path pointer)", async () => {
    const key = randomBytes(32)
    const bundleDir = await backupFirestoreEmulator({
      hub: "127.0.0.1:8080",
      outRoot: root,
      key,
      exportDir,
    })
    const ring = makeKeyRing(key)
    const verify = await verifyBundle(bundleDir, ring)
    expect(verify.ok, verify.problems.join("\n")).toBe(true)
    const names = verify.bundle?.files.map((f) => f.name) ?? []
    expect(names).toContain("export.tar.skb")
    expect(names).not.toContain("export-meta.skb")

    const tarPath = path.join(root, "export.tar")
    await pipeline(openBundleFile(bundleDir, "export.tar", ring), createWriteStream(tarPath))
    const extractDir = path.join(root, "out")
    mkdirSync(extractDir, { recursive: true })
    const untar = await realRunCommand(["tar", "-xf", tarPath, "-C", extractDir])
    expect(untar.code).toBe(0)
    expect(readFileSync(path.join(extractDir, "marker.bin"))).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  })
})
