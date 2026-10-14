# Audit remediation plan (updated 2026-10-14)

Sources: `2026-10-13-forensic-audit.md` (3.25/10, 48 findings) and `2026-10-14-forensic-audit-v2.md` (independent re-audit of main@0f72cd8: **2.3/10 FAIL, 0/48 closed** — 45 open, 2 partial F03/F30, 1 not reproduced F39). Probe: `probes/probe_fa_data_001.mjs`.

## Rules (owner order)

1. **Fix-first freeze.** No new phases or features until every finding is closed. Work resumes on new phases only on the owner's word.
2. **Closed means proven.** A fix needs a merged PR with an end-to-end test of a real user flow that fails before and passes after.
3. **Ticked only after independent re-audit PASS.** A merged fix is recorded as `fix merged #NN, awaiting re-audit` and stays unticked until an independent re-audit of that finding passes.
4. **Target.** Independent re-audit score **>= 7/10** before any new phase starts.
5. **One builder.** Autopilot workflows (`legal-os-continue.yml`, `legal-os-watchdog.yml`) stay disabled; each fix run is started and reviewed manually.

## Order (v2)

1. **F30** (CRITICAL)
2. **FA-CI-001** (G-0 full-tree scan) + **FA-CI-002** (real Postgres DDL tests in CI) + **FA-DATA-001** (real SECURITY DEFINER `declassify()`, trigger bypass fixed)
3. **F03** to closure: R2 adapter + integrity tests (**FA-D16-001/002**)
4. **F05 / F06**
5. **F01 / F09 / F10 / F12**
6. All remaining HIGH, then MEDIUM, then LOW findings (F-series and FA-series)

## New findings from v2 (HIGH 9 · MEDIUM 7 · LOW 4)

| ID | Severity | Summary |
|---|---|---|
| FA-CI-001 | HIGH | G-0 scan omits app/, functions/, lib/, components/, corpus_service (runtime-proven) |
| FA-CI-002 | HIGH | G-1 trigger test runs in-memory; no test applies the Postgres DDL |
| FA-DATA-001 | HIGH | `SET app.declassify_reason` bypasses downgrade trigger; declassify() missing (runtime-proven) |
| FA-DATA-002 | MEDIUM | Downgrade trigger on `judgment` only |
| FA-DATA-003 | MEDIUM | Unfiltered provenance/embeddings granted to corpus_reader |
| FA-DATA-004 | LOW | `002_platform.sql:13` O-8 TODO |
| FA-D16-001 | HIGH | F03 residual: document vault is local fs, not R2 |
| FA-D16-002 | HIGH | F03 integrity check and key validation untested |
| FA-D16-003 | LOW | Round-trip hash failure leaves written object behind |
| FA-D3C-001 | HIGH | Playwright in app repo (corpus_service) |
| FA-D3C-002 | HIGH | Direct OpenAI calls outside P1 gateway |
| FA-D2WA-001 | HIGH | WhatsApp returns constant `research: []` |
| FA-D2WA-002 | MEDIUM | Only 3 of 8 WhatsApp commands |
| FA-D5-001 | HIGH | Research "search" is query-less, unranked, unbounded |
| FA-D5-002 | LOW | services/d5-1/research.ts:28-30 |
| FA-D2CO-001 | MEDIUM | services/d2-2/courtOps.ts:101-108 |
| FA-D2CO-002 | LOW | services/d2-2/courtOps.ts:66 |
| FA-P5-001 | MEDIUM | MFA attempt-cap invariant load-dependent |
| FA-OPS-001 | MEDIUM | Autopilot ran despite REMEDIATION.md rule 5 |
| FA-OPS-002 | MEDIUM | F03 ticked / PR #33 merged against process |

Progress is tracked in issue #30 "Audit remediation: 48 findings".
