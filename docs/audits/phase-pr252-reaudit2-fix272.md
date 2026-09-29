# Independent re-audit pass 2 — PR #252 (GET 501–502) after fix PR #272 (PR252-REAUDIT-MAJOR-1)

**Auditor:** independent phase auditor (docs-only deliverable)  
**Audited HEAD:** `ded553a5b0a9479e5d8c0c1b4392e8d2044e90c1` (squash of PR #272; parent `0dcdf803b4780e199d207146f9d334bdae2add48`)  
**Prior failed re-audit:** `25767dfb78351ec0e1831fe496500ec6e9cd87e0` (PR #269 product fix; route-wiring mock gap)  
**Docs sweep:** `110d170bff829f25266966e15bec73671de0cdd4` (#270)  
**Interim feature (out of #252 packet):** `0dcdf80` — GET **509–510** dedicated collections  
**Evidence log:** `/opt/cursor/artifacts/pr252_reaudit2_verification.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #252 re-audit @ `ded553a`** | **PASS** (0 majors; closes PR252-REAUDIT-MAJOR-1 from `25767df`) |
| **Lattice 485–510 collection isolation** | **CLEAN** (builder isolation **8/8**; dedicated `View509`/`View510` collections) |
| **Product @ `ded553a`** | **PARTIAL-accepted-transport-stub** (`transport_stub=true`) |

---

## A. Landing chain

| Check | Result |
|---|---|
| `git rev-parse ded553a^` | `0dcdf803b4780e199d207146f9d334bdae2add48` — **match** |
| `git log --first-parent 25767df..ded553a` | `110d170` docs (#270) → `0dcdf80` feat **509–510** → `ded553a` test-only fix (#272) |
| `git diff 0dcdf80..ded553a` | **tests only** — `tests/persistence.route-wiring.test.ts` **+137** |
| Pre-squash tip `3dcebfa` | Parent **`110d170`** (docs), not `0dcdf80`; same **+137** route-wiring hunk vs its parent |
| `3dcebfa` vs `ded553a` tree | **Not identical** — pre-squash branch lacked interim **509–510** product tree |
| Fix hunk semantics | **Equivalent** to `110d170..3dcebfa` (line context differs only because **509–510** shifted route-wiring offsets) |

---

## B. Line counts and route integrity

| Artifact | @ `25767df` | @ `ded553a` |
|---|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 38,508 | 39,235 |
| `app/ops/operator-audit-console.tsx` | 5,665 | 5,796 |

### Interim `25767df..0dcdf80` (**509–510**, not #252)

- `route.ts`: **+748 / −21** (additions dominate; **21** deletions are rewires, not handler amputation).
- `operator-audit-console.tsx`: **+131** lines (509–510 `/ops` call sites).
- `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS`: **26** slices (**485–510**); `it.each` asserts `json.view ===` requested view param for all lattice GETs.
- GET handlers and `parseView` identity branches run through **510** (dedicated `View509`/`View510` repos on GET/POST).

### Fix `0dcdf80..ded553a` (#272)

- **No** product or docs changes.

---

## C. Tests (501/502 wiring + parseView)

- **`parseView`:** automated scan — **0** non-identity returns in body.
- **`it.each` lattice:** **26** GETs (**485–510**) each assert `json.view` equals the requested `view` query param.
- **New dedicated `it()` @ `ded553a`:** views **501** and **502** mock `View501`/`View502` repos (505–508 pattern) with **status + view suffix** assertions (not trivial 200-only).

---

## D. Persistence

### Same-family pairs (empirical @ `ded553a`)

| Pair | Builder test |
|---|---|
| 489/501, 490/502, 493/505, 494/506, 495/507, 496/508 | **PASS** |
| 497/509, 498/510 (interim feature) | **PASS** |

`tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts`: **8/8 PASS**.

**509/510 collections:** dedicated deny-by-default paths ending in `…_tb_ack_recon_pd_freeze_seal_view509` / `…_view510` (`denyByDefaultWorkflowOpsRepository.ts`); GET `listByFirm` and POST `upsert`/`set` use matching `View509`/`View510` repos — **distinct** from **497/498** parent TB-recon collections (isolation test seeds separate repos; no shared unscoped `listByFirm` leak).

Auditor did **not** commit a separate scratch vitest file; builder file already exercises all required pairs including **509/510**.

---

## E. Tests and gates @ `ded553a`

| Suite | Auditor result |
|---|---|
| Focused ops vitest (**21 files**, no `-t`) | **223/223 PASS** (21 files) |
| vs `@25767df` same file set | **212/215** — **3 FAIL** (501/502 mock gap) |
| New focused tests vs `25767df` | **+8** from interim **509–510** (route-wiring + isolation); **+2** dedicated 501/502 wiring `it()` from #272 |
| `npm run test:rules` | **34/34** (3 files) |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10 PASS** |
| `tests/pr-phase-claim-gate.test.ts` | **20/20 PASS** (Vitest worker `onTaskUpdate` timeout → nonzero exit; tests green) |
| `check_pr_phase_claims.py` `BASE=0dcdf80` `HEAD=ded553a` | **PASS** (PR #272 body via `origin pr view 272`) |

**Note:** Builder replay cited **217/0** focused tests; independent rerun at `ded553a` counts **223** with the canonical **21-file** lattice set (includes **509–510** route-wiring/isolation deltas landed in `0dcdf80`).

---

## F. `frontend_real` — views 501/502

`app/ops/operator-audit-console.tsx` **L4832–L4864**: GET `/api/d2/ops-reporting` for custody **501** and closure **502** with concrete status query params — **present** (unchanged by #272).

---

## Findings

### Majors

None @ `ded553a`.

### Minors

| ID | Finding |
|---|---|
| **M1** | Builder focused count **217** vs auditor **223** on same **21-file** set (interim **509–510** test expansion). |
| **M2** | `3dcebfa` tree ≠ `ded553a` tree (fix rebased onto `0dcdf80`); semantic fix hunk matches `110d170..3dcebfa`. |
| **M3** | Vitest worker timeout noise on `pr-phase-claim-gate` (20/20 pass). |
| **M4** | Interim **509–510** on `main` between #270 docs and #272 fix — not formally packeted; adds **+8** focused tests outside #252 scope. |

---

## Verdict summary

- **#252 re-audit @ `ded553a`:** **PASS** — PR252-REAUDIT-MAJOR-1 remediated; focused suite green; gates green; claim-gate replay green.
- **Lattice 485–510:** **CLEAN** isolation.
- **Product:** **PARTIAL** (`transport_stub=true`).
