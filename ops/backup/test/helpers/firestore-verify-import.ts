import { readFileSync } from "node:fs"
import { getApps, initializeApp } from "firebase-admin/app"
import { getFirestore } from "firebase-admin/firestore"
import { collectFirestoreManifest, compareFirestoreManifests } from "../../firestore/manifest"

const manifestPath = process.argv[2]
if (!manifestPath) throw new Error("usage: firestore-verify-import <manifestPath>")

async function main(): Promise<void> {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("FIRESTORE_EMULATOR_HOST required")
  const projectId = process.env.FIRESTORE_DRILL_PROJECT?.trim() || "demo-sikander"
  if (!getApps().length) initializeApp({ projectId })
  const db = getFirestore()
  const before = JSON.parse(readFileSync(manifestPath, "utf8"))
  const after = await collectFirestoreManifest(db)
  const diffs = compareFirestoreManifests(before, after)
  if (diffs.length) throw new Error(diffs.join("\n"))
  console.log("firestore drill ok")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
