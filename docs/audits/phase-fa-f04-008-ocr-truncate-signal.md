# FA-F04-008 — OCR text over 900 KiB must not truncate silently

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-008** (parent audit F04, `functions/src/p1/ocrEngine.ts`)

## Problem (RED baseline)

Before F04 PR #107 (`d460c91`), `DeterministicLocalOcrEngine` applied `capOcrText` at `MAX_OCR_TEXT_BYTES` (900 KiB) and returned only the prefix. No `truncated` flag, no audit reason, and no operator log — callers and operators could not tell stored OCR text was incomplete.

## Correction

- **Engine:** `measureOcrText` pairs `capOcrText` with a `truncated` boolean; `OcrExtraction.truncated` is set on every stub extraction (landed in #110 `7ed2d874`).
- **P1 admission:** `callP1Ocr` persists `truncated` on `p1_ocr_operations`, returns it on `OcrCallResult`, and logs `ocr.text_truncated` when the cap applies.
- **Publish:** `ocrJob` writes `truncated` on `ocr_texts` and stages `ocr.complete` with reason `text_truncated` (not `ok`) when the published text is a prefix.
- **Audit admit:** `ocr.admit` uses reason `text_truncated` when admission capped the extraction.

Firestore still stores a prefix (Firestore document size limit); the fix is **non-silent** storage and operator surfaces, not refusing the publish.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | `d460c91` `ocrEngine.ts`: `capOcrText` only, no `truncated` on `OcrExtraction` | Over-cap OCR returns capped text with no structured signal |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-008: measureOcrText reports truncation…` | `truncated: true` and valid UTF-8 at cap |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-008: text over the UTF-8 cap is marked truncated…` | Engine sets `truncated` on over/under cap |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-004: the local stub caps text…` | Over-cap stub extraction has `truncated: true` |
| GREEN | `functions/test/f04-ocr.e2e.emu.test.ts` — `FA-F04-008: over-cap text records truncated…` | `ocr_texts` and `p1_ocr_operations` have `truncated: true`; `ocr.complete` audit reason `text_truncated` |

## Focused verification

```bash
npm --prefix functions test -- --run f04-ocr.unit.test.ts -t "FA-F04-008"
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- --run f04-ocr.e2e.emu.test.ts -t 'FA-F04-008'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (`truncated` + audit reason on worker path; no signed-in UI/API proof that product surfaces the flag to end users) |

no COMPLETE/product-done claim
