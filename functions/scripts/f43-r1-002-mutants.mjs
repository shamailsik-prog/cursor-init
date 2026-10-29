#!/usr/bin/env node
// FA-F43-R1-002 mutation run: applies each mutant in functions/test/f43-r1-002-mutants.json to the working tree,
// runs the tests that should kill it, then restores the file. Usage, from the repository root:
//   node functions/scripts/f43-r1-002-mutants.mjs [id ...]
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const all = JSON.parse(readFileSync(path.join(root, "functions/test/f43-r1-002-mutants.json"), "utf8"))
const only = new Set(process.argv.slice(2))
const mutants = only.size > 0 ? all.filter((m) => only.has(m.id)) : all

function run(m) {
  const cwd = path.join(root, "functions")
  return spawnSync("npx", ["vitest", "run", "--no-cache", ...m.tests], { cwd, encoding: "utf8", env: process.env })
}

const seen = new Set()
for (const m of mutants) {
  const key = m.tests.join(" ")
  if (seen.has(key)) continue
  seen.add(key)
  const r = run(m)
  if (r.status !== 0) {
    console.log(`baseline FAILED: ${key}\n${(r.stdout ?? "").slice(-2000)}`)
    process.exit(2)
  }
  console.log(`baseline ok: ${key}`)
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
