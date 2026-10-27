# FA-F42-R1-013 — F42 retention e2e CI cost (`retentionTestSeam.limits`)

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F42-R1-013** (F42 R1 follow-up, LOW)

## Problem (RED baseline)

After PR **#128** (`5840d3d0`), the F42 matter-deletion emulator suite added about **six minutes** to the Cloud Functions CI job (Functions test step **22m49s** on `798cf56` → **28m56s** at `301e65d`, ~+27%). Two gaps made the cost hard to reason about:

1. **Synthetic row counts:** Three “large store” e2e cases seeded **~8,801** or **~10,001** rows to exercise multi-chunk continuation, late-budget retry, and multi-part external trace recording at **production** saga sizes (chunk 200, chunk-step budget 45, 5,000 trace ids per part).
2. **Workflow comment:** `.github/workflows/gate-g0.yml` claimed the F42 retention e2e added “about **100 s**” locally, which understated the measured CI impact.

Production retention thresholds must stay unchanged; only test harness sizing and CI documentation should move.

## Correction

Implemented on main in **#133** (`d3b87dbb`, `fix(F42): close retention/deletion R1+R2 findings`). Spec **R32** records the seam and measurements. This ledger formalises acceptance on top of `e01bf95212cb865fac92ff00b89f78725d405caf` (main after **#169**).

**Chosen approach:** read saga sizing through `retentionTestSeam.limits` outside production (`NODE_ENV !== "production"`); pin production values in a unit test; shrink only the three large-store e2e cases to ~**100-row** equivalents; correct the workflow comment to state measured CI wall time and the row-count rationale.

| Seam field | Production (unchanged) | Large-store e2e override | Rows exercised (same ratios as before) |
| --- | ---: | ---: | ---: |
| `chunk` | 200 | 10 | — |
| `chunkStepBudget` | 45 | 5 | 50 (budget spill); 100 (budget + 5 chunks, crash at budget − 3) |
| `traceIdsPerPart` | 5,000 | 40 | 81 (`2 × 40 + 1`, three external parts) |

- **`functions/src/retention/config.ts` — `retentionTestSeam.limits`:** Optional `Partial<RetentionLimits>`; documented FA-F42-R1-013 / spec R32.
- **`functions/src/retention/saga.ts` — `limits()`:** Merges `PRODUCTION_LIMITS` with the seam when not in production; purge chunks, step budget, and trace part splitting all call `limits()`.
- **`functions/test/f42-retention-deletion.e2e.emu.test.ts`:** `SMALL = { chunk: 10, chunkStepBudget: 5 }` for continuation and late-budget cases; `traceIdsPerPart: 40` for the many-traces case (was 9,000 / 10,000 / 10,001 rows at production sizes).
- **`functions/test/f42-retention.units.test.ts`:** Pins production `{ chunk: 200, chunkStepBudget: 45, traceIdsPerPart: 5_000, maxTraceParts: 24 }` and proves the seam is ignored when `NODE_ENV` is `production`.
- **`.github/workflows/gate-g0.yml`:** Functions job comment documents **~6 minutes** added to the test step, per-case full-saga cost (~20–30 s on a loaded host), and **~100-row** seeding (FA-F42-R1-013).

**Rejected alternative:** Lowering production `CHUNK` / `CHUNK_STEP_BUDGET` / `TRACE_IDS_PER_PART` in `saga.ts` — would weaken real purge and external-request bounds.

**Residual (honest):** Spec R32 / commit `f77f9c2c` measured that cutting row counts did **not** materially shorten the three cases on a loaded host (~31–38 s before and after); the dominant cost is running the **whole deletion saga over every inventoried store**. Further CI savings are **FU-10** (test-scoped inventory or fewer full-saga runs), not built here. Classification stays **PARTIAL** unless a future CI run shows a material drop in the Functions test step wall time.

## RED / GREEN acceptance

| Step | Evidence | Expected |
| --- | --- | --- |
| RED | Issue #30 FA-F42-R1-013 | 8k+/10k+ row seeds; workflow “~100 s” comment |
| RED | `301e65d` `.github/workflows/gate-g0.yml` | “The F42 retention e2e adds about 100 s locally.” |
| GREEN | Spec R32 (`docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`) | Seam, row targets, corrected CI comment narrative |
| GREEN | `functions/test/f42-retention.units.test.ts` — `FA-F42-R1-013` | Production sizes pinned; seam merged only outside production |
| GREEN | `functions/test/f42-retention-deletion.e2e.emu.test.ts` | Three cases use `SMALL` / `PER_PART = 40` → 50, 100, 81 rows |
| GREEN | `.github/workflows/gate-g0.yml` (Functions job) | States ~6 min step delta and ~100-row seeding |

### Guards that must stay green

| Guard | If removed |
| --- | --- |
| `limits()` ignores `retentionTestSeam.limits` in production | Unit test `FA-F42-R1-013` fails on `NODE_ENV=production` |
| Large-store cases drop `retentionTestSeam.limits` | Tests revert to multi-thousand-row seeds or wrong chunk math |
| `traceIdParts` uses `limits().traceIdsPerPart` | 81-trace case would not form three parts at seam size 40 |

No further product code is required for this acceptance slice; behaviour is already on main from **#133**.

## Focused verification

Unit (production pin + seam):

```bash
npm --prefix functions test -- test/f42-retention.units.test.ts -t 'FA-F42-R1-013'
```

With Auth + Firestore emulators (three large-store cases):

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander-f42r1013 \
  "npm --prefix functions test -- test/f42-retention-deletion.e2e.emu.test.ts -t 'Codex P2|chunk budget|more exported traces'"
```

Optional full deletion e2e file:

```bash
npx firebase emulators:exec --only auth,firestore --project demo-sikander \
  "npm --prefix functions test -- test/f42-retention-deletion.e2e.emu.test.ts"
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true (test seam + CI comment acceptance; production thresholds unchanged) |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (R1-013 acceptance; row shrink does not by itself claim material Functions-step CI reduction — see FU-10) |

No COMPLETE / product-done claim. This ledger proves the seam, ~100-row large-store proofs, and corrected workflow commentary on main after **#133**.
