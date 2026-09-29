# Independent phase auditor A–F audit: PR #271 TB ack-recon PD freeze seal GET 509–510

**Auditor:** independent phase auditor (docs-only deliverable)  
**Feature squash SHA:** `0dcdf803b4780e199d207146f9d334bdae2add48` (PR #271; parent `110d170bff829f25266966e15bec73671de0cdd4` #270 docs)  
**Pre-squash tip:** `3e2f24272741a292541b1c876bc2f008935b4b33` (parent `4a0048c`; **25767df not an ancestor**)  
**Integration tip (sealed):** `aafe257f51ac5055197b9f3b954cf2446dfaee17` (#275 M1 bundle + `json.view`; parent `93e96a2` #273 docs)  
**Evidence log:** `/opt/cursor/artifacts/pr252_reaudit2_verification.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #271 @ integration tip `aafe257`** | **SEALED PASS** (M1 + M2 remediated) |
| **Lattice 485–510 isolation** | **CLEAN** (8/8) |
| **Product** | **PARTIAL-accepted-transport-stub** (`transport_stub=true`) |

Pre-seal @ `ded553a` (2026-09-29): **PARTIAL** — M1 missing 509–510 file in **21-file** ledger; M2 PR #271 placeholder body. Seal section below.

---

## A. Landing chain

| Check | Result |
|---|---|
| `0dcdf80^` = `110d170` | **PASS** |
| Squash contains `docs/` | **No** — 13 product/test paths only |
| `25767df` ancestor of `0dcdf80` | **Yes** |
| `25767df` ancestor of `3e2f242` | **No** |
| `3e2f242` vs `0dcdf80` tree | **Different** |

---

## B. Line counts and `route.ts` integrity

| Artifact | @ `110d170` | @ `0dcdf80` |
|---|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 38,508 | 39,235 (**+727**) |
| `app/ops/operator-audit-console.tsx` | 5,665 | 5,796 (**+131**) |

- `route.ts` squash **+748 / −21** — deletions are repo rewires to `View509`/`View510`, not removed GET handlers.
- GET order **507 → 508 → 509 → 510**; POST/governance/lifecycle **509–510** present.

---

## C. `parseView` and tests

- **`parseView`:** identity-only through **510**.
- **`it.each`:** **26** lattice GETs assert `json.view`.
- **Dedicated wiring @ `aafe257`:** **509/510** assert status fields **and** `json.view === requestedView` (501/502 pattern).

---

## D. Persistence

- Dedicated **`…_view509` / `…_view510`** deny binders + **+2** `firestore.rules` lines.
- GET/POST/`store.set` aligned on `View509`/`View510`.
- **497/509**, **498/510** isolation **PASS**; full builder file **8/8 PASS**.

---

## E. Tests and gates @ `aafe257`

| Suite | Result |
|---|---|
| `bash ci_gates/run_focused_lattice_ops_vitest.sh` | **22 files, 225/225 PASS** (no `-t`) |
| `npm run test:rules` | **34/34** |
| `gate:g0` | **PASS** |
| `gate:g1` | **10/10** |
| `tests/pr-phase-claim-gate.test.ts` | **20/20** (worker timeout noise) |
| `check_pr_phase_claims.py` PR #271 `BASE=110d170` `HEAD=0dcdf80` | **PASS** (amended PR #271 body) |

---

## F. `frontend_real`

| View | Lines | Path |
|---|---|---|
| **509** GET | `operator-audit-console.tsx` **L5354–L5367** | `/api/d2/ops-reporting` |
| **510** GET | **L5368–L5381** | same |
| POST block | **L5382+** | `/api/d2/ops-reporting` |

PR #271 body line refs (**L5357**, **L5371** for `path`/`view` inside blocks) match tree @ `aafe257`.

---

## Seal verification (`#271 SEAL @ aafe257`)

### Chain

| Check | Result |
|---|---|
| `aafe257^` = `93e96a2` | **PASS** |
| `93e96a2^` = `ded553a` | **PASS** |
| `ded553a..aafe257` product paths | **None** (`app/`, `platform/`, `firestore.rules` unchanged) |
| `#275` squash `93e96a2..aafe257` | CI runner + ledger + route-wiring **+6** lines only (**minor:** mixed with #273 docs in `ded553a..aafe257` range, not in #275 squash alone) |

### M1 remediation (#275)

- `ci_gates/run_focused_lattice_ops_vitest.sh`: **22** files; includes **509–510 frontend-real** + **lineage-isolation**; `exec npx vitest run` with **no** `-t` filter.

### M2 remediation

- PR #271 body amended with flags, `/ops` table, API evidence; claim-gate replay **PASS** on product squash span.

### PR #275 claim-gate replay

- `check_pr_phase_claims.py` `BASE=93e96a2` `HEAD=aafe257`: **FAIL** (test-only PR declares `frontend_real=true` but diff has no `/ops` paths — expected; **not** a #271 seal blocker).

---

## Findings (historical + seal)

| ID | Status | Finding |
|---|---|---|
| **M1** | **Remediated @ `aafe257`** | 21-file ledger omitted #271 frontend-real → **22-file** runner |
| **M2** | **Remediated** | PR #271 placeholder body → amended body; replay **PASS** |
| **m1** | Open (historical) | `3e2f242` off `main` lineage |
| **m2** | **Closed @ `aafe257`** | Dedicated **509/510** wiring now asserts `json.view` |
| **m3** | Informational | PR #275 claim-gate replay fails (test-only delta) |

---

## Verdict summary

- **#271 SEALED PASS** @ `aafe257`.
- **Product:** **PARTIAL** (`transport_stub=true`).
