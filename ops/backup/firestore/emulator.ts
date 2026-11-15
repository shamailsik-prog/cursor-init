import { createWriteStream, promises as fsp } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore, type Firestore } from "firebase-admin/firestore"
import { acceptRestoreChild, backupPayloadProblems, type ContentUnit } from "../drill/content"
import { firestoreEmulatorTarget, isolationProblems } from "../drill/target"
import { BundleWriter, openBundleFile, verifyBundle } from "../lib/bundle"
import type { KeyRing } from "../lib/envelope.mjs"
import { runCommand } from "../lib/exec"
import { collectFirestoreManifest } from "./manifest"
import { assertFirestoreEmulatorPortFree } from "./guards"

const FIRESTORE_DRILL_PROJECT = "f33-backup-drill"
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")

/** firebase-tools has no `emulators:import`; import data via `emulators:exec --import`. */
export function firestoreEmulatorExecArgv(innerCommand: string): string[] {
  return ["firebase", "emulators:exec", "--only", "firestore", "--project", FIRESTORE_DRILL_PROJECT, innerCommand]
}

export function firestoreEmulatorImportArgv(importDir: string, innerCommand: string): string[] {
  return [
    "firebase",
    "emulators:exec",
    "--only",
    "firestore",
    "--import",
    importDir,
    "--project",
    FIRESTORE_DRILL_PROJECT,
    innerCommand,
  ]
}

function adminDb(host: string, port: number): Firestore {
  if (!getApps().length) {
    initializeApp({ projectId: FIRESTORE_DRILL_PROJECT })
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
  const r = await runCommand(["firebase", "emulators:export", opts.exportDir, "--project", FIRESTORE_DRILL_PROJECT], {
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
}): Promise<{
  ok: boolean
  differences: string[]
  rtoMs: number
  stop: () => void
  idempotent: boolean
  content: Array<ContentUnit & { match: boolean }>
}> {
  const started = Date.now()
  const fail = (differences: string[], content: Array<ContentUnit & { match: boolean }> = []) => ({
    ok: false,
    differences,
    rtoMs: Date.now() - started,
    stop: () => {},
    idempotent: false,
    content,
  })
  const targetProblems = isolationProblems(
    firestoreEmulatorTarget({ host: opts.host, projectId: FIRESTORE_DRILL_PROJECT, importDir: opts.importDir })
  )
  if (targetProblems.length) return fail(targetProblems)
  const verify = await verifyBundle(opts.bundleDir, opts.ring)
  if (!verify.ok || !verify.manifest || !verify.bundle) return fail(verify.problems)
  const payloadProblems = backupPayloadProblems({
    store: verify.bundle.store,
    storeManifest: verify.manifest.store,
    artefacts: verify.manifest.artefacts,
  })
  if (payloadProblems.length) return fail(payloadProblems)
  await assertFirestoreEmulatorPortFree(opts.host, opts.port)
  const expected = verify.manifest.store
  await fsp.mkdir(opts.importDir, { recursive: true })
  const exportTar = path.join(opts.importDir, ".export.tar.part")
  const exportExpect = verify.manifest.artefacts.find((a) => a.name === "export.tar")
  try {
    await pipeline(
      openBundleFile(opts.bundleDir, "export.tar", opts.ring, exportExpect),
      createWriteStream(exportTar)
    )
    const extract = await runCommand(["tar", "-xf", exportTar, "-C", opts.importDir])
    if (extract.code !== 0) return fail([extract.stderr || extract.stdout])
    const manifestPath = path.join(opts.importDir, ".expected-manifest.json")
    await fsp.writeFile(manifestPath, JSON.stringify(expected), "utf8")
    const inner = `npx vite-node ops/backup/test/helpers/firestore-verify-import.ts ${JSON.stringify(manifestPath)}`
    const importRun = await runCommand(firestoreEmulatorImportArgv(opts.importDir, inner), {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NPM_CONFIG_LOGLEVEL: "error",
        FIRESTORE_DRILL_PROJECT: FIRESTORE_DRILL_PROJECT,
      },
    })
    const accepted = acceptRestoreChild({ code: importRun.code, stdout: importRun.stdout, stderr: importRun.stderr })
    if (!accepted.ok) return fail(accepted.problems, accepted.units)
    return { ok: true, differences: [], rtoMs: Date.now() - started, stop: () => {}, idempotent: false, content: accepted.units }
  } finally {
    await fsp.rm(exportTar, { force: true })
    await fsp.rm(path.join(opts.importDir, ".expected-manifest.json"), { force: true })
  }
}

export async function seedFirmDocs(db: Firestore, firmId: string): Promise<void> {
  await db.collection("firms").doc(firmId).set({ name: firmId, firmId })
}
