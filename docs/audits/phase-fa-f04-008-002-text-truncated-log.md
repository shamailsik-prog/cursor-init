# FA-F04-008-002 — Pin structured `ocr.text_truncated` log

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-008-002** [LOW] (child of FA-F04-008 / ME REAUDIT_PR173_FA_F04_008)

## Problem (RED baseline)

`callP1Ocr` (`functions/src/p1/ocrCall.ts`, ~222–229) emits `logger.info("ocr.text_truncated", { firmId, operationId, documentId, legacyJobId })` when admission caps OCR text (ids only, no extracted text). ME mutation **M2** (disable that log) **survived** because unit and e2e tests asserted `truncated` flags, `ocr.complete` / `ocr.admit` reasons, but **no test asserted the structured log**.

## Correction

- **Test-only pin:** emulator unit tests call `callP1Ocr` with over-cap bytes, spy `logger.info`, and assert one `ocr.text_truncated` payload with exactly the four id fields (no `text`). Under-cap path asserts the log is absent.
- **Product code:** unchanged unless the pin exposed a regression (it did not on tip).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME mutant M2 (remove / no-op `ocr.text_truncated` log in `ocrCall.ts`) | Tests pass; structured log not asserted |
| RED | `f04-ocr.unit.test.ts` FA-F04-008-001 | Pins `ocr.admit` reason only |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-008-002` | `logger.info("ocr.text_truncated", { firmId, operationId, documentId, legacyJobId })` on cap; absent under cap |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- --run f04-ocr.unit.test.ts -t 'FA-F04-008-002'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (P1 structured log pinned in emulator unit test; no signed-in live probe in this slice) |
