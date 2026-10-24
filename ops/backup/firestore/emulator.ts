import { createWriteStream, promises as fsp } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { BundleWriter, openBundleFile, verifyBundle } from "../lib/bundle"
import type { KeyRing } from "../lib/envelope.mjs"
import { runCommand } from "../lib/exec"
import { recordDrillResult } from "../lib/results"
import { collectFirestoreManifest, compareFirestoreManifests } from "./manifest"
import { assertFirestoreEmulatorPortFree } from "./guards"

function adminDb(host: string, port: number): Firestore {
  if (!getApps().length) {
    initializeApp({ projectId: "f33-backup-drill" })
  }
  process.env.FIRESTORE_EMULATOR_HOST = `${host}:${port}`
  return getFirestore()
}

export async function backupFirestoreEmulator(opts: {
  hub: string
  outRoot: string
  key: Buffer
  exportDir: string
}): Promise<string> {
  const r = await runCommand(["firebase", "emulators:export", opts.exportDir, "--project", "f33-backup-drill"], {
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: opts.hub },
  })
  if (r.code !== 0) throw new Error(r.stderr || r.stdout)
  const db = adminDb(opts.hub.split(":")[0], Number(opts.hub.split(":")[1]))
  const manifest = await collectFirestoreManifest(db)
  const packed = await runCommand(["tar", "-cf", "-", "-C", opts.exportDir, "."], { binaryStdout: true })
  if (packed.code !== 0) throw new Error(packed.stderr || packed.stdout)
  if (!packed.stdoutBytes?.length) throw new Error("firestore export tar is empty")
  const writer = await BundleWriter.create(opts.outRoot, "firestore-emulator", opts.key)
  await writer.addBuffer("export.tar", packed.stdoutBytes)
  return await writer.finish(manifest)
}

export async function restoreFirestoreEmulator(opts: {
  bundleDir: string
  ring: KeyRing
  host: string
  port: number
  importDir: string
}): Promise<{ ok: boolean; differences: string[]; rtoMs: number; stop: () => void }> {
  const started = Date.now()
  await assertFirestoreEmulatorPortFree(opts.host, opts.port)
  const verify = await verifyBundle(opts.bundleDir, opts.ring)
  if (!verify.ok || !verify.manifest) {
    return { ok: false, differences: verify.problems, rtoMs: Date.now() - started, stop: () => {} }
  }
  const expected = verify.manifest.store
  await fsp.mkdir(opts.importDir, { recursive: true })
  const exportTar = path.join(opts.importDir, ".export.tar.part")
  await pipeline(openBundleFile(opts.bundleDir, "export.tar", opts.ring), createWriteStream(exportTar))
  const extract = await runCommand(["tar", "-xf", exportTar, "-C", opts.importDir])
  await fsp.rm(exportTar, { force: true })
  if (extract.code !== 0) {
    return { ok: false, differences: [extract.stderr || extract.stdout], rtoMs: Date.now() - started, stop: () => {} }
  }
  await runCommand(
    ["firebase", "emulators:exec", "--only", "firestore", "--project", "f33-backup-drill", "true"],
    { env: { ...process.env, FIRESTORE_EMULATOR_HOST: `${opts.host}:${opts.port}` } }
  )
  const importRun = await runCommand(["firebase", "emulators:import", opts.importDir, "--project", "f33-backup-drill"], {
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: `${opts.host}:${opts.port}` },
  })
  if (importRun.code !== 0) {
    return { ok: false, differences: [importRun.stderr || importRun.stdout], rtoMs: Date.now() - started, stop: () => {} }
  }
  const db = adminDb(opts.host, opts.port)
  const actual = await collectFirestoreManifest(db)
  const differences = compareFirestoreManifests(expected as typeof actual, actual)
  const rtoMs = Date.now() - started
  recordDrillResult({ store: "firestore-emulator", rtoMs, details: { ok: differences.length === 0 } })
  return { ok: differences.length === 0, differences, rtoMs, stop: () => {} }
}

export async function seedFirmDocs(db: Firestore, firmId: string): Promise<void> {
  await db.collection("firms").doc(firmId).set({ name: firmId, firmId })
}
