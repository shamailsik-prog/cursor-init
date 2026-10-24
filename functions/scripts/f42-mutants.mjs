#!/usr/bin/env node
// Audit F42 mutation run: applies each mutant in functions/test/f42-mutants.json to the working tree, one at a time,
// runs the tests that should kill it, then restores the file. A mutant whose `old` text is not found exactly once
// fails the run. Needs the Auth and Firestore emulators in the environment (FIRESTORE_EMULATOR_HOST,
// FIREBASE_AUTH_EMULATOR_HOST) for the e2e suites. Usage, from the repository root:
//   node functions/scripts/f42-mutants.mjs [id ...]
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const all = JSON.parse(readFileSync(path.join(root, "functions/test/f42-mutants.json"), "utf8"))
const only = new Set(process.argv.slice(2))
const mutants = only.size > 0 ? all.filter((m) => only.has(m.id)) : all

function run(m) {
  if (m.runner === "python") return spawnSync("python3", m.tests, { cwd: root, encoding: "utf8" })
  const cwd = m.runner === "root" ? root : path.join(root, "functions")
  return spawnSync("npx", ["vitest", "run", "--no-cache", ...m.tests], { cwd, encoding: "utf8", env: process.env })
}

const results = []
let bad = false
for (const m of mutants) {
  const target = path.join(root, m.file)
  const original = readFileSync(target, "utf8")
  const count = original.split(m.old).length - 1
  if (count !== 1) {
    console.log(`${m.id}: old text found ${count} times (expected 1)`)
    results.push({ id: m.id, result: "invalid" })
    bad = true
    continue
  }
  try {
    writeFileSync(target, original.replace(m.old, m.new))
    const r = run(m)
    const killed = r.status !== 0
    console.log(`${m.id}: ${killed ? "killed" : "SURVIVED"}`)
    results.push({ id: m.id, result: killed ? "killed" : "survived" })
    if (!killed) bad = true
  } finally {
    writeFileSync(target, original)
  }
}
console.log(JSON.stringify({ total: results.length, killed: results.filter((r) => r.result === "killed").length, results }))
process.exit(bad ? 1 : 0)
