# Independent phase auditor A–F audit: PR #277 GET 511–512 (TB external transport ack on 509/510)

**Auditor:** independent phase auditor (docs-only deliverable)  
**Landed squash SHA:** `fc13995f48c11059b7fd56055c05fbb4f56146f1` (PR #277 on `main`)  
**Parent SHA:** `e8bbcf42711b740e4f36f7734add87db4843ec2a` (#276 Vitest pool fix)  
**Pre-squash PR tip:** `aee4c2c09186e1878ad8c68295a9c230ffd89c8f`  
**Evidence log:** `/opt/cursor/artifacts/pr277_audit.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #277 @ `fc13995` (landed)** | **FAIL** |
| **Product slice (511/512 wiring)** | Would be **PARTIAL-accepted** (`transport_stub=true`) if gates clean |
| **Lattice 485–512 isolation @ `fc13995`** | **CLEAN** (lineage vitest **10/10** incl. **509/511**, **510/512**) |

**Primary blocker:** `npm run test:rules` regressed **34/34 → 22/22** because `tests/firestore.rules.test.ts` deleted **12** TB ack-recon client-write deny tests (**501/502/505–510**) and added **no** deny tests for new **511/512** rules lines.

---

## A. Landing

- `fc13995^` = `e8bbcf4` — **PASS**
- Squash diff `e8bbcf4..fc13995`: **14 files**, product/tests/rules only — **no docs** in squash
- `git merge-base e8bbcf4 aee4c2c` = `e8bbcf4`
- `git diff aee4c2c fc13995`: only `docs/audits/lattice-focused-ops-vitest-bundle.md` (squash omitted PR-tip **23-file** ledger update)

## B. Line counts

| Artifact | @ `e8bbcf4` | @ `fc13995` |
|---|---:|---:|
| `route.ts` | 39235 | 39850 (+615) |
| `operator-audit-console.tsx` | 5796 | 5966 (+170) |

## C. `parseView` / tests

- `parseView` identity-only (no remaps); fail-closed `return undefined` only
- Identity `it()` title omits **505/506**; body + dedicated tests cover them
- **511/512** dedicated wiring tests assert repo fields + `json.view`

## D. Persistence

- Dedicated `…_view511` / `…_view512` collections; deny binders; `firestore.rules` **L232–L233** `allow write: if false`
- **Rules test gap:** emulator suite no longer asserts deny for **501–510** or **511–512**

## E. Gates @ `fc13995`

| Suite | Result |
|---|---|
| Focused lattice ops (`run_focused_lattice_ops_vitest.sh`) | **23 files, 233/233 PASS** |
| `test:rules` | **22/22** (was **34/34** @ `e8bbcf4`) — **FAIL** |
| `gate:g0` | PASS |
| `gate:g1` | 10/10 |
| `pr-phase-claim-gate.test.ts` | 20/20 |
| `check_pr_phase_claims.py` (`BASE=e8bbcf4`, `HEAD=fc13995`, PR #277 body) | PASS |

### `test:rules` per-file counts (same script, same emulator env)

| File | @ `e8bbcf4` | @ `fc13995` |
|---|---:|---:|
| `tests/firestore.rules.test.ts` | 19 | 7 |
| `tests/persistence.repositories.test.ts` | 1 | 1 |
| `tests/persistence.runtime-mode.test.ts` | 14 | 14 |
| **Total** | **34** | **22** |

**Removed test cases (restore from `e8bbcf4` + extend for 511/512):**

1. `it.each(TB_ACK_RECON_PD_FREEZE_SEAL_DEDICATED_VIEW_COLLECTIONS)` — deny write **505, 506, 507, 508, 509, 510**
2. `it.each(denyWritePaths)` in `TB ack-recon lattice dedicated collections — client write deny` — **501, 502, 505, 506, 507, 508**

## F. `frontend_real`

- GET **511/512:** `app/ops/operator-audit-console.tsx` L5486–5513 → `/api/d2/ops-reporting`
- POST checkpoint / acknowledge / control for **511–512** lattice: same file L5514+

---

## Required fix (product PR, not docs)

1. Restore deleted blocks in `tests/firestore.rules.test.ts` from `e8bbcf42711b740e4f36f7734add87db4843ec2a`.
2. Add **view511** and **view512** collection paths to both deny-write `it.each` arrays (match `firestore.rules` L232–L233).
3. Re-run `npm run test:rules` — expect **≥36/36** PASS.
4. Update `docs/audits/lattice-focused-ops-vitest-bundle.md` to **23 files** (ledger drift).

Until then: **do not seal** PR #277 as phase-audit PASS.
