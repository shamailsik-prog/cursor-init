#!/usr/bin/env node
// Per-file mutation-score floor for a StrykerJS run. Stryker's own thresholds.break is one
// number for the whole run; a file with a weak score can hide behind a strong one. This reads
// the run's JSON report and fails when any file listed in the config's `perFileBreak` export
// scores below its floor.
//
// It cannot pass vacuously (re-audit R1-D3): it fails when the config declares no floors (exit 2),
// when the report is missing, when a floored file is missing from the report, and when a floored
// file has no valid mutant at all. Mutants disabled with `// Stryker disable` (status Ignored)
// count as not killed, so silencing a mutant cannot raise a score.
//
// Usage: node scripts/check-mutation-per-file.mjs <stryker config file>
// Score = (killed + timeout) / (killed + timeout + survived + no coverage + ignored).
// CompileError and RuntimeError mutants are invalid and not counted.
import { existsSync, readFileSync } from "node:fs"
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
if (!floors || typeof floors !== "object" || Object.keys(floors).length === 0 || !reportFile) {
  console.error(`${configFile} must export a non-empty perFileBreak and set jsonReporter.fileName`)
  process.exit(2)
}

const reportPath = path.resolve(reportFile)
if (!existsSync(reportPath)) {
  console.error(`FAIL: no mutation report at ${reportPath}`)
  process.exit(1)
}
const report = JSON.parse(readFileSync(reportPath, "utf8"))
const files = report.files ?? {}
const DETECTED = new Set(["Killed", "Timeout"])
const UNDETECTED = new Set(["Survived", "NoCoverage", "Ignored"])

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
  let ignored = 0
  for (const mutant of entry.mutants ?? []) {
    if (DETECTED.has(mutant.status)) detected += 1
    else if (UNDETECTED.has(mutant.status)) undetected += 1
    if (mutant.status === "Ignored") ignored += 1
  }
  const valid = detected + undetected
  if (valid === 0) {
    console.error(`FAIL ${file}: no valid mutants in the report (a floor over nothing proves nothing)`)
    failed = true
    continue
  }
  const score = (detected / valid) * 100
  const verdict = score >= floor ? "PASS" : "FAIL"
  if (verdict === "FAIL") failed = true
  console.log(
    `${verdict} ${file}: ${score.toFixed(2)}% (killed+timeout ${detected}, survived+no-coverage+ignored ${undetected}, ignored ${ignored}) floor ${floor}%`
  )
}
process.exit(failed ? 1 : 0)
