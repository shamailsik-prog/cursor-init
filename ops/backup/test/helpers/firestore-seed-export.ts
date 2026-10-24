import { writeFileSync } from "node:fs"
import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { runCommand } from "../../lib/exec"
import { collectFirestoreManifest } from "../../firestore/manifest"

const exportDir = process.argv[2]
const manifestPath = process.argv[3]
if (!exportDir || !manifestPath) throw new Error("usage: firestore-seed-export <exportDir> <manifestPath>")

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("FIRESTORE_EMULATOR_HOST required")
  if (!getApps().length) initializeApp({ projectId: "demo-sikander" })
  const db = getFirestore()
  for (const firmId of ["firm-alpha", "firm-bravo"]) {
    await db.collection("firms").doc(firmId).set({ name: firmId, firmId })
    await db.collection("clients").doc(`${firmId}-client`).set({ firmId, canonicalName: `${firmId} client` })
    await db.collection("matters").doc(`${firmId}-matter`).set({ firmId, clientId: `${firmId}-client`, title: "F33" })
  }
  const manifest = await collectFirestoreManifest(db)
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8")
  const exp = await runCommand(["npx", "firebase", "emulators:export", exportDir, "--project", "demo-sikander"])
  if (exp.code !== 0) throw new Error((exp.stderr || exp.stdout).trim() || "export failed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
