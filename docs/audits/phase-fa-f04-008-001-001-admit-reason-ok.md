# FA-F04-008-001-001 — Pin `ocr.admit` reason `ok` (under-cap)

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F04-008-001-001** [LOW] (child of FA-F04-008-001 / ME REAUDIT_PR178_FA_F04_008_001)

## Problem (RED baseline)

`callP1Ocr` (`functions/src/p1/ocrCall.ts`) sets `admitReason` to `ok` when admission does not cap OCR text and appends audit action `ocr.admit` with that reason. Sibling pin **FA-F04-008-001** asserted `reason === "text_truncated"` on over-cap input. ME mutation **M1e** (force admit reason always `"text_truncated"`, even for under-cap text) **survived** because no test asserted `ocr.admit` reason `ok` on a short-text admission path.

## Correction

- **Test-only pin:** emulator unit test calls `callP1Ocr` with under-cap bytes (`TEXT`) and asserts an `audit_log` row with `action === "ocr.admit"`, `decision === "allow"`, `reason === "ok"`, and no `ocr.admit` row with `reason === "text_truncated"` on the same target.
- **Product code:** unchanged unless the pin exposed a regression (it did not on tip).

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | ME mutant M1e on `admitReason` in `ocrCall.ts` | Tests pass; under-cap `ocr.admit` reason not asserted |
| RED | `f04-ocr.unit.test.ts` FA-F04-008-001 only | Over-cap twin pins `text_truncated` only |
| GREEN | `functions/test/f04-ocr.unit.test.ts` — `FA-F04-008-001-001` | `ocr.admit` / `allow` / `ok` on admission target |

## Focused verification

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- --run f04-ocr.unit.test.ts -t 'FA-F04-008-001-001'"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (P1 admit audit reason `ok` pinned in emulator unit test; no signed-in live probe in this slice) |
