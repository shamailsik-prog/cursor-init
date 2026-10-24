#!/usr/bin/env node
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const mutants = JSON.parse(readFileSync(path.join(root, "ops/backup/mutation/mutants.json"), "utf8"))
const scratch = path.join(root, "ops/backup/.mutant-scratch")

let failed = false
for (const m of mutants) {
  rmSync(scratch, { recursive: true, force: true })
  cpSync(root, scratch, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes(".mutant-scratch") })
  const target = path.join(scratch, m.file)
  const text = readFileSync(target, "utf8")
  if (!text.includes(m.old)) {
    console.error(`mutant ${m.id}: old text not found`)
    failed = true
    continue
  }
  writeFileSync(target, text.replace(m.old, m.new))
  const r = spawnSync("npx", ["vitest", "run", "-c", "ops/backup/vitest.config.ts", ...m.tests], {
    cwd: scratch,
    encoding: "utf8",
  })
  const killed = r.status !== 0
  console.log(`${m.id}: ${killed ? "killed" : "SURVIVED"}`)
  if (!killed) failed = true
}
rmSync(scratch, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
