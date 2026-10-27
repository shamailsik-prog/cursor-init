# FA-F04-008-001 — Pin `ocr.admit` reason `text_truncated`

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-008-001** [LOW] (child of FA-F04-008 / ME REAUDIT_PR173_FA_F04_008)

## Problem (RED baseline)

`callP1Ocr` (`functions/src/p1/ocrCall.ts`) sets `admitReason` to `text_truncated` when admission caps OCR text and appends audit action `ocr.admit` with that reason (fire-and-forget `appendAudit` targeting `ocr_texts/<id>`). ME mutation **M1** (force admit reason always `"ok"`) **survived** because unit and e2e tests asserted `truncated` flags and `ocr.complete` reason `text_truncated`, but **no test asserted `ocr.admit` reason**.

## Correction

- **Test-only pin:** emulator unit test calls `callP1Ocr` with over-cap bytes and asserts an `audit_log` row with `action === "ocr.admit"`, `decision === "allow"`, `reason === "text_truncated"`.
- **Product code:** unchanged unless the pin exposed a regression (it did not on tip).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME mutant M1 on `admitReason` in `ocrCall.ts` | Tests pass; `ocr.admit` reason not asserted |
| RED | `f04-ocr.e2e.emu.test.ts` FA-F04-008 | Asserts `ocr.complete` reason `text_truncated` only |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-008-001` | `ocr.admit` / `allow` / `text_truncated` on admission target |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- --run f04-ocr.unit.test.ts -t 'FA-F04-008-001'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (P1 admit audit reason pinned in emulator unit test; no signed-in live probe in this slice) |
