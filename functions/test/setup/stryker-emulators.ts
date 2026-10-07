/**
 * StrykerJS only (functions/vitest.stryker.config.ts). `npm run mutation`
 * starts STRYKER_EMULATOR_SETS independent emulator sets
 * (scripts/with-emulators.sh) and runs one Stryker test-runner process per
 * set. Each process claims a set of its own here, so two mutants never run
 * against the same emulator: the suites share singleton docs
 * (platform/bootstrap, platform/gates) and would otherwise see each other's
 * writes, turning a surviving mutant into a false kill.
 *
 * A claim is a directory `<lock dir>/set-<k>` holding the claimant's pid. It
 * is sticky for the process (every test file re-runs this setup) and is taken
 * over when its pid is gone (Stryker replaces a worker after a timeout).
 */
import fs from "node:fs"
import path from "node:path"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pause = new Int32Array(new SharedArrayBuffer(4))

function claim(lockDir: string, sets: number): number {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (attempt > 0) Atomics.wait(pause, 0, 0, 100) // a replaced worker may still be exiting
    for (let k = 0; k < sets; k++) {
      const dir = path.join(lockDir, `set-${k}`)
      const owner = path.join(dir, "pid")
      try {
        fs.mkdirSync(dir)
        fs.writeFileSync(owner, String(process.pid))
        return k
      } catch {
        let pid = NaN
        try {
          pid = Number(fs.readFileSync(owner, "utf8"))
        } catch {
          continue // being written by its claimant right now
        }
        if (pid === process.pid) return k
        if (Number.isInteger(pid) && !alive(pid)) fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  }
  throw new Error(`stryker-emulators: no free emulator set of ${sets} in ${lockDir}`)
}

const sets = Number(process.env.STRYKER_EMULATOR_SETS ?? "0")
const lockDir = process.env.STRYKER_EMULATOR_LOCKS
if (sets > 0 && lockDir) {
  const k = claim(lockDir, sets)
  const firestore = process.env[`EMU_${k}_FIRESTORE`]
  const auth = process.env[`EMU_${k}_AUTH`]
  if (!firestore || !auth) throw new Error(`stryker-emulators: emulator set ${k} has no hosts`)
  process.env.FIRESTORE_EMULATOR_HOST = firestore
  process.env.FIREBASE_AUTH_EMULATOR_HOST = auth
}
