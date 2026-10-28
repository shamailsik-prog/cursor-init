# FA-F42-R1-014-001-001-001 — Step-5 legal-hold polarity (L5-invert)

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-014-001-001-001** [LOW] (ME residual after #182 step-5 keyword pins)

## Problem

Step 5 was pinned only with positive keywords (`legal_holds`, `hold`, `purge|purged`). Mutant **L5-invert** flips intent—e.g. “holds may be dropped; purge held content”—while keeping those tokens, so the guard still passed.

## Correction

- **Test-only** in `ops/backup/test/runbook-f42-restore.unit.test.ts`:
  - On both runbook restore sections, step 5 also matches `/do not purge|nothing .* is purged/i` (matches backup “do not purge held matter content” and retention “nothing of a held matter is purged”).
  - Dedicated **L5-invert** example asserts inverted prose fails the polarity pin.
- **Runbook prose:** unchanged; existing wording already states the negative rule.

## Verification

```bash
npx vitest run -c ops/backup/vitest.config.ts ops/backup/test/runbook-f42-restore.unit.test.ts
```

## Release labels

| Label | Value |
| --- | --- |
| classification | PARTIAL (guard only; live restore drill NOT DEMONSTRATED) |
| scope | FA-F42-R1-014-001-001-001 only |
