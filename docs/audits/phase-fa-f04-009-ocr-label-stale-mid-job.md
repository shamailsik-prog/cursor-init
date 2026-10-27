# FA-F04-009 — OCR publish must not keep a stale label when classification rises mid-job

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-009** (parent audit F04, `functions/src/p2/ocrJob.ts` publish path)

## Problem (RED baseline)

Before F04 PR #110 (`7ed2d874`), `ocrJob` published `ocr_texts`, the legacy upload row, and `ocr.complete` audit entries using the `aggregate` computed when bytes were loaded and P1 admitted OCR. If the document or matter classification was raised while extraction ran, published text could remain labeled at the pre-change aggregate (auditor mutants **O4** document re-read, **O6** matter re-read, **O11** audit/legacy stamp still bound to `aggregate`).

## Correction

- **`labelAtPublish`:** Inside the publish transaction, re-read the document and (when applicable) matter classification and return `aggregateClassification([admitted, doc.classification, matter.classification])`. A label **raised** mid-job is included; a label **lowered** mid-job does not drop below the admitted aggregate (text is not published under the lower label).
- **Publish fence:** `ocr_texts.classification`, `stageAudit(ocr.complete).classification`, legacy `ocrClassification`, and the post-fence `apply` patch all use `published` from `labelAtPublish`, not the pre-OCR `aggregate`.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | `d460c911` `ocrJob.ts`: `classification: aggregate` on create, audit, and legacy `done` | Mid-job label raise not reflected at publish |
| RED | Issue #30 FA-F04-009: mutants O4, O6, O11 survive without focused tests | Stale-label class unpinned |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-009 O11` (source pin) | Publish block uses `published` from `labelAtPublish`, not `aggregate` |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-009: labelAtPublish` O4 / O6 / lowered-label | Transactional re-read picks up stricter doc/matter labels; admits floor on downgrade |
| GREEN | `functions/test/f04-ocr.e2e.emu.test.ts` — `FA-F04-009 O4`, `O6`, `O11` | End-to-end worker publish uses re-checked label on text, legacy row, and audit |
| GREEN | `functions/test/f04-ocr.e2e.emu.test.ts` — `a label lowered mid-job does not publish the text under the lower label` | Downgrade mid-job does not under-label stored text |

## Focused verification

```bash
npm --prefix functions test -- --run f04-ocr.unit.test.ts -t "FA-F04-009"
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- --run f04-ocr.e2e.emu.test.ts -t 'FA-F04-009'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (worker + emulator proof; no signed-in UI/API read path showing the corrected label to an end user) |

no COMPLETE/product-done claim
