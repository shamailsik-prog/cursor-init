import { createGunzip } from "node:zlib"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { openBundleFile } from "../lib/bundle"
import { makeKeyRing } from "../lib/envelope.mjs"
import * as exec from "../lib/exec"
import { baseBackup } from "../postgres/pitr"

let root: string
const rawTar = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f])

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "f33-pitr-unit-"))
  vi.spyOn(exec, "runCommand").mockImplementation(async (argv, opts) => {
    if (argv[0] === "pg_basebackup") {
      expect(opts?.binaryStdout, "pg_basebackup stdout must be captured as raw bytes").toBe(true)
      return { code: 0, stdout: "", stderr: "", stdoutBytes: rawTar }
    }
    throw new Error(`unexpected argv: ${argv.join(" ")}`)
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("baseBackup", () => {
  it("preserves non-UTF8 tar bytes through gzip in the bundle", async () => {
    const key = randomBytes(32)
    const bundleDir = await baseBackup({ outRoot: root, key })
    const ring = makeKeyRing(key)
    const chunks: Buffer[] = []
    await pipeline(openBundleFile(bundleDir, "base.tar.gz", ring), createGunzip(), async function (src) {
      for await (const c of src) chunks.push(Buffer.from(c))
    })
    expect(Buffer.concat(chunks)).toEqual(rawTar)
  })
})
