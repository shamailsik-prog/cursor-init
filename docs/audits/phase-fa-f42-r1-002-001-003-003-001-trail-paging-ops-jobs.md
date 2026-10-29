# FA-F42-R1-002-001-003-003-001 — Emulator coverage for `p1_ocr_operations` and `jobs` trail paging

Repository: `shamailsik-prog/cursor-init`  
Finding: **FA-F42-R1-002-001-003-003-001** [LOW]  
Register: issue #30 (no `Fixes #30` on the PR)

## Gap

PR #213 added stable paging for `ocr_texts`, `p1_ocr_operations`, and `jobs` in prepare (`collectLegacyTrailDocumentIds`) and live purge (`matterTrailDocumentIdBatches`). The FA-F42-R1-002 suite only exercised **ocr_texts** page 2 via `retentionTestSeam.trailDocumentIdPageSize = 2` (`FA-F42-R1-002-001-003-003`). Mutants that revert ops or jobs paging still passed 13/13 until auditor probes.

## Correction

- `f42-r1-followup.e2e.emu.test.ts` — `FA-F42-R1-002-001-003-003-001` (`it.each` over `p1_ocr_operations`, `jobs`): two decoy trail rows on page one, target `documentId` on page two; assert prepare snapshot lists the id and legacy `committee_outputs` row is purged.
- Same matter-scoped query shape as production (`firmId` + `matterId`); no firm-wide sweep.

Production paging unchanged (test-only delta).

## Verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r2 \
  "npm --prefix functions test -- --run f42-r1-followup.e2e.emu.test.ts -t 'FA-F42-R1-002'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | **PARTIAL** |
