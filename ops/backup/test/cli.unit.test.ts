import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

describe("cli", () => {
  it("refuses subcommands without a key", () => {
    const r = spawnSync("npx", ["vite-node", "-c", "ops/backup/vitest.config.ts", "ops/backup/cli.ts", "bundle", "verify", "/tmp"], {
      cwd: path.resolve(__dirname, "../../.."),
      encoding: "utf8",
      env: { ...process.env, SIKANDER_BACKUP_KEY: "" },
    })
    expect(r.status).toBe(2)
  })

  it("runs bundle verify through vite-node", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "f33-cli-"))
    const key = randomBytes(32).toString("hex")
    const keyFile = path.join(root, "key")
    writeFileSync(keyFile, key, { mode: 0o600 })
    const r = spawnSync(
      "npx",
      [
        "vite-node",
        "-c",
        "ops/backup/vitest.config.ts",
        "ops/backup/cli.ts",
        "bundle",
        "verify",
        root,
        "--key-file",
        keyFile,
      ],
      { cwd: path.resolve(__dirname, "../../.."), encoding: "utf8" }
    )
    expect(r.status).not.toBe(0)
    rmSync(root, { recursive: true, force: true })
  })
})
