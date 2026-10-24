import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it, afterAll } from "vitest"

const WAL = path.resolve(__dirname, "../bin/pg-wal.mjs")
const dir = mkdtempSync(path.join(os.tmpdir(), "f33-wal-"))
const keyFile = path.join(dir, "key")
writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 })
const seg = path.join(dir, "000000010000000000000001")
writeFileSync(seg, Buffer.from("wal-bytes"))
const archiveDir = path.join(dir, "archive")
mkdirSync(archiveDir, { recursive: true })

function run(args: string[]): number {
  return spawnSync("node", [WAL, ...args], { encoding: "utf8" }).status ?? 1
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("pg-wal.mjs", () => {
  it("archives twice with the same bytes exits 0", () => {
    expect(run(["archive", seg, path.basename(seg), "--archive-dir", archiveDir, "--key-file", keyFile])).toBe(0)
    expect(run(["archive", seg, path.basename(seg), "--archive-dir", archiveDir, "--key-file", keyFile])).toBe(0)
  })

  it("refuses different bytes for the same WAL name", () => {
    const seg2 = path.join(dir, "seg2")
    writeFileSync(seg2, Buffer.from("other"))
    expect(run(["archive", seg2, path.basename(seg), "--archive-dir", archiveDir, "--key-file", keyFile])).toBe(1)
  })

  it("restore of a missing segment exits 1", () => {
    expect(
      run(["restore", "missing", path.join(dir, "out"), "--archive-dir", archiveDir, "--key-file", keyFile])
    ).toBe(1)
  })

  it("restore with a flipped byte exits 127", () => {
    const badDir = path.join(dir, "bad")
    mkdirSync(badDir, { recursive: true })
    const name = "badseg"
    run(["archive", seg, name, "--archive-dir", badDir, "--key-file", keyFile])
    const skb = path.join(badDir, `${name}.skb`)
    const bytes = readFileSync(skb)
    bytes[60] ^= 0x01
    writeFileSync(skb, bytes)
    expect(run(["restore", name, path.join(dir, "restored"), "--archive-dir", badDir, "--key-file", keyFile])).toBe(127)
  })
})
