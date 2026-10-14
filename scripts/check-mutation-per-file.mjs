#!/usr/bin/env node
// Per-file mutation-score floor for a StrykerJS run. Stryker's own thresholds.break is one
// number for the whole run; a file with a weak score can hide behind a strong one. This reads
// the run's JSON report and fails when any file listed in the config's `perFileBreak` export
// scores below its floor (or is missing from the report).
//
// Usage: node scripts/check-mutation-per-file.mjs <stryker config file>
// Score = (killed + timeout) / (killed + timeout + survived + no coverage), as Stryker computes it.
import { readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const configFile = process.argv[2]
if (!configFile) {
  console.error("usage: check-mutation-per-file.mjs <stryker config file>")
  process.exit(2)
}

const configModule = await import(pathToFileURL(path.resolve(configFile)).href)
const floors = configModule.perFileBreak
const reportFile = configModule.default?.jsonReporter?.fileName
if (!floors || typeof floors !== "object" || !reportFile) {
  console.error(`${configFile} must export perFileBreak and set jsonReporter.fileName`)
  process.exit(2)
}

const report = JSON.parse(readFileSync(path.resolve(reportFile), "utf8"))
const files = report.files ?? {}
const DETECTED = new Set(["Killed", "Timeout"])
const UNDETECTED = new Set(["Survived", "NoCoverage"])

let failed = false
for (const [file, floor] of Object.entries(floors)) {
  const entry = files[file] ?? files[path.resolve(file)]
  if (!entry) {
    console.error(`FAIL ${file}: not in ${reportFile}`)
    failed = true
    continue
  }
  let detected = 0
  let undetected = 0
  for (const mutant of entry.mutants ?? []) {
    if (DETECTED.has(mutant.status)) detected += 1
    else if (UNDETECTED.has(mutant.status)) undetected += 1
  }
  const valid = detected + undetected
  const score = valid === 0 ? 100 : (detected / valid) * 100
  const verdict = score >= floor ? "PASS" : "FAIL"
  if (verdict === "FAIL") failed = true
  console.log(
    `${verdict} ${file}: ${score.toFixed(2)}% (killed+timeout ${detected}, survived+no-coverage ${undetected}) floor ${floor}%`
  )
}
process.exit(failed ? 1 : 0)
