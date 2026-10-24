#!/usr/bin/env node
import { loadKeyRing } from "./lib/keys"
import { verifyBundle } from "./lib/bundle"
import { loadInfraConfig } from "./config"
import { firestoreCommands } from "./firestore/managed"

const USAGE = `usage: vite-node ops/backup/cli.ts <group> <subcommand> [--key-file PATH]`

async function main(): Promise<void> {
  const [, , group, sub, ...rest] = process.argv
  const keyFile = rest.includes("--key-file") ? rest[rest.indexOf("--key-file") + 1] : undefined
  const needKey = group !== "firestore" || sub !== "commands"
  if (needKey && !keyFile && !process.env.SIKANDER_BACKUP_KEY) {
    console.error("backup key required: SIKANDER_BACKUP_KEY or --key-file")
    process.exit(2)
  }
  const ring = needKey ? loadKeyRing({ keyFile }) : undefined
  if (group === "bundle" && sub === "verify") {
    const dir = rest.find((a) => !a.startsWith("--"))
    if (!dir || !ring) throw new Error("bundle verify <dir> --key-file …")
    const r = await verifyBundle(dir, ring)
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }
  if (group === "firestore" && sub === "commands") {
    const cfg = loadInfraConfig(process.cwd())
    const cmds = firestoreCommands(cfg.firestore, { project: "PROJECT", location: "LOCATION", exportBucket: "bucket" })
    console.log(JSON.stringify(cmds, null, 2))
    return
  }
  console.error(USAGE)
  process.exit(2)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
