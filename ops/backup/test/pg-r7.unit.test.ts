import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PersistentPsqlSession, runCommand } from "../lib/exec"

describe("R7 byte streams", () => {
  it("session stdout decodes a UTF-8 character split across chunks", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f33-r7-psql-"))
    const bin = path.join(dir, "psql")
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const { Buffer } = require("node:buffer")
process.stdin.on("data", (buf) => {
  const text = buf.toString("utf8")
  const marker = text.match(/\\\\echo (\\S+)/)
  process.stdout.write(Buffer.from([0xda]))
  setTimeout(() => {
    process.stdout.write(Buffer.from([0xa9, 0x0a]))
    if (marker) process.stdout.write(marker[1] + "\\n")
  }, 40)
})
`
    )
    chmodSync(bin, 0o755)
    const session = await PersistentPsqlSession.open([], { PATH: `${dir}:${process.env.PATH}`, NODE_ENV: "test" }, "postgres")
    try {
      const text = await session.query("SELECT 1")
      expect(text).toContain("ک")
      expect(text).not.toContain("\uFFFD")
    } finally {
      session.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runCommand stderr decodes a UTF-8 character split across chunks", async () => {
    const result = await runCommand([
      "node",
      "-e",
      "process.stderr.write(Buffer.from([0xda])); setTimeout(() => { process.stderr.write(Buffer.from([0xa9])); process.exit(0) }, 40)",
    ])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("ک")
  })
})
