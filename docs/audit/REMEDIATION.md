# Audit remediation plan (2026-10-13)

Source: `2026-10-13-forensic-audit.md` (score 3.25/10, commit e7e18e6, 48 findings: 2 CRITICAL, 35 HIGH, 11 MEDIUM) and `2026-10-13-findings.csv`.

## Rules (owner order, 2026-10-13)

1. **Fix-first freeze.** No new phases or features until every finding is closed. Work resumes on new phases only on the owner's word.
2. **Closed means proven.** A finding is closed only by a merged PR that includes an end-to-end test exercising a real user flow (not only unit or phase-local tests) that fails before the fix and passes after it.
3. **Independent re-audit.** Each remediation batch is re-scored by an independent auditor against the same 48 findings and the same method. No merge without a PASS.
4. **Target.** Independent re-audit score of **>= 7/10** before any new phase starts.
5. **One builder.** Autopilot workflows (`legal-os-continue.yml`, `legal-os-watchdog.yml`) stay disabled; each fix run is started and reviewed manually.

## Order

1. CRITICAL: **F03** (uploads discard file bytes), **F30** (compose stack exposes privileged stores with defaults)
2. Core flows: **F01, F02, F04, F05, F06**
3. All remaining HIGH findings
4. All MEDIUM findings

Progress is tracked in the GitHub issue "Audit remediation: 48 findings".
