import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { acceptRestoreChild } from "../drill/content"
import { runCommand } from "../lib/exec"
import { recordDrillResult } from "../lib/results"

const REPO = path.resolve(__dirname, "../../..")
const FIREBASE = path.join(REPO, "node_modules", ".bin", "firebase")

describe("firestore emulator drill", () => {
  it(
    "export and import reproduces the manifest",
    async () => {
      const started = Date.now()
      const tmp = mkdtempSync(path.join(os.tmpdir(), "f33-fs-drill-"))
      const exportDir = path.join(tmp, "export")
      const manifestPath = path.join(tmp, "manifest.json")
      try {
        const seedCmd =
          `"${FIREBASE}" emulators:exec --only firestore --project demo-sikander ` +
          `"npx vite-node ops/backup/test/helpers/firestore-seed-export.ts ${exportDir} ${manifestPath}"`
        const seed = await runCommand(["bash", "-lc", seedCmd], {
          cwd: REPO,
          env: { ...process.env, NPM_CONFIG_LOGLEVEL: "error" },
        })
        expect(seed.code, (seed.stderr || seed.stdout).trim()).toBe(0)
        const verifyCmd =
          `"${FIREBASE}" emulators:exec --only firestore --import "${exportDir}" --project demo-sikander ` +
          `"npx vite-node ops/backup/test/helpers/firestore-verify-import.ts ${manifestPath}"`
        const verify = await runCommand(["bash", "-lc", verifyCmd], {
          cwd: REPO,
          env: { ...process.env, NPM_CONFIG_LOGLEVEL: "error" },
        })
        const accepted = acceptRestoreChild({ code: verify.code, stdout: verify.stdout, stderr: verify.stderr })
        expect(accepted.ok, accepted.problems.join("\n")).toBe(true)
        expect(accepted.units.length).toBeGreaterThan(0)
        expect(accepted.units.every((unit) => unit.match && /^[0-9a-f]{64}$/.test(unit.digest))).toBe(true)
        recordDrillResult({
          store: "firestore-emulator",
          rtoMs: Date.now() - started,
          target: { kind: "emulator", engine: "firestore", isolated: true },
          details: { ok: true, contentUnits: accepted.units },
        })
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    300_000
  )
})
