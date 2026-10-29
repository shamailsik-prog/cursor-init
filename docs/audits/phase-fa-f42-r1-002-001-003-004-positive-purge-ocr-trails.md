# FA-F42-R1-002-001-003-004 — First-page positive purge via `ocr_texts` and `p1_ocr_operations`

Repository: `shamailsik-prog/cursor-init`  
Finding: **FA-F42-R1-002-001-003-004** [LOW]  
Register: issue #30 (no `Fixes #30` on the PR)

## Gap

ME re-audit of PR #210 noted jobs trail positive purge (`FA-F42-R1-002-001-003`) but no complementary **first-page** emulator cases for matter-scoped `ocr_texts` or `p1_ocr_operations`. Page-2 coverage already exists under **003-003** / **003-003-001**; mutants that break ordinary trail discovery or purge for those collections could still pass the suite.

## Correction

- `f42-r1-followup.e2e.emu.test.ts` — **FA-F42-R1-002-001-003-004** (`it.each` over `ocr_texts`, `p1_ocr_operations`): absent-`matterId` legacy `committee_outputs` row, single matter-scoped trail row naming the same `documentId` (default page size); assert prepare `legacyTrailDocumentIds` snapshot contains the id and the legacy row is purged after saga completion.
- Same matter-scoped query shape as production (`firmId` + `matterId`); no firm-wide sweep.

Test-only delta.

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
