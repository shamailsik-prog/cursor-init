import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import { describe, expect, it } from "vitest"
import { makeKeyRing } from "../lib/envelope.mjs"
import { runCommand } from "../lib/exec"
import { restoreFirestoreEmulator } from "../firestore/emulator"
import { firestoreEmulatorExecArgv } from "../firestore/emulator"
import { recordDrillResult } from "../lib/results"

const REPO = path.resolve(__dirname, "../../..")
const FIREBASE = path.join(REPO, "node_modules", ".bin", "firebase")
const FIRESTORE_PORT = 18088

describe("firestore SKB1 bundle drill", () => {
  it(
    "backup bundle and restoreFirestoreEmulator round-trip",
    async () => {
      const started = Date.now()
      const key = randomBytes(32)
      const ring = makeKeyRing(key)
      const tmp = mkdtempSync(path.join(os.tmpdir(), "f33-fs-bundle-"))
      const exportDir = path.join(tmp, "export")
      const outRoot = path.join(tmp, "bundles")
      const bundleMarker = path.join(tmp, "bundle-dir.txt")
      const importDir = path.join(tmp, "import")
      try {
        const inner = `npx vite-node ops/backup/test/helpers/firestore-bundle-backup.ts ${exportDir} ${outRoot} ${key.toString("hex")} ${bundleMarker}`
        const backup = await runCommand(
          ["bash", "-lc", `"${FIREBASE}" ${firestoreEmulatorExecArgv(inner).slice(1).map((a) => (a.includes(" ") ? `'${a.replace(/'/g, `'\"'\"'`)}'` : a)).join(" ")}`],
          { cwd: REPO, env: { ...process.env, NPM_CONFIG_LOGLEVEL: "error" } }
        )
        expect(backup.code, (backup.stderr || backup.stdout).trim()).toBe(0)
        const bundleDir = readFileSync(bundleMarker, "utf8").trim()
        const res = await restoreFirestoreEmulator({
          bundleDir,
          ring,
          host: "127.0.0.1",
          port: FIRESTORE_PORT,
          importDir,
        })
        expect(res.ok, res.differences.join("\n")).toBe(true)
        recordDrillResult({ store: "firestore-emulator-bundle", rtoMs: Date.now() - started, details: { ok: true } })
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    300_000
  )
})
