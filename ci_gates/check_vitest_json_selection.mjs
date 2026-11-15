// Gate G-4 name check. Vitest exits 0 when -t matches nothing, so a pattern that
// selects 0 tests must fail here. EXPECTED is the newline-separated JSON fullName
// list (space-joined). LABEL is the log prefix.
import fs from "node:fs"

const jsonPath = process.argv[2]
if (!jsonPath) {
  console.error("usage: check_vitest_json_selection.mjs <vitest-json>")
  process.exit(2)
}

const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"))
const label = process.env.LABEL || "vitest selection"
const want = (process.env.EXPECTED ?? "").split("\n").filter((line) => line.length > 0).sort()
const assertions = (report.testResults ?? []).flatMap((file) => file.assertionResults ?? [])
const ran = assertions.filter((assertion) => assertion.status === "passed" || assertion.status === "failed")
const passedCount = Number(report.numPassedTests ?? 0)
const failedCount = Number(report.numFailedTests ?? 0)
const pendingCount = Number(report.numPendingTests ?? 0)
console.log(`${label}: ${passedCount} passed, ${failedCount} failed, ${pendingCount} skipped`)
if (ran.length === 0) {
  console.log("FAIL: the name pattern selected 0 tests")
  process.exit(1)
}
const passed = assertions.filter((assertion) => assertion.status === "passed").map((assertion) => assertion.fullName).sort()
const exact = passed.length === want.length && passed.every((name, index) => name === want[index])
if (!exact) {
  console.log(`passed tests are not exactly the ${want.length} named tests:`, JSON.stringify(passed))
}
process.exit(passedCount === want.length && failedCount === 0 && exact ? 0 : 1)
