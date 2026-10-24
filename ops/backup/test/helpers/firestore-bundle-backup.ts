import { mkdirSync, writeFileSync } from "node:fs"
import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { backupFirestoreEmulator } from "../../firestore/emulator"

const exportDir = process.argv[2]
const outRoot = process.argv[3]
const keyHex = process.argv[4]
const bundleMarker = process.argv[5]
if (!exportDir || !outRoot || !keyHex || !bundleMarker) {
  throw new Error("usage: firestore-bundle-backup <exportDir> <outRoot> <keyHex> <bundleMarker>")
}

async function main(): Promise<void> {
  const hub = process.env.FIRESTORE_EMULATOR_HOST
  if (!hub) throw new Error("FIRESTORE_EMULATOR_HOST required")
  if (!getApps().length) initializeApp({ projectId: "f33-backup-drill" })
  const db = getFirestore()
  await db.collection("firms").doc("f33-drill").set({ name: "f33-drill", firmId: "f33-drill" })
  mkdirSync(outRoot, { recursive: true })
  const key = Buffer.from(keyHex, "hex")
  const bundleDir = await backupFirestoreEmulator({ hub, outRoot, key, exportDir })
  writeFileSync(bundleMarker, bundleDir, "utf8")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
