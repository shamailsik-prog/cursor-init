# Independent re-audit — PR #252 (GET 501–502) after fix PR #269 (LATTICE-MAJOR-2) + lattice 485–508 sweep

**Auditor:** independent phase auditor (docs-only deliverable)  
**Fix landed SHA:** `25767dfb78351ec0e1831fe496500ec6e9cd87e0` (squash of PR #269)  
**Docs sweep SHA:** `39aecaff25dbacc008e9f66264bf13b691f576a7` (#268)  
**Evidence log:** `/opt/cursor/artifacts/pr252_reaudit_lattice_verification.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **Lattice 485–508 collection isolation** | **CLEAN** (no cross-view leaks; dedicated collections for all same-family pairs) |
| **PR #252 re-audit @ `25767df`** | **FAIL phase audit — 1 major** (focused `persistence.route-wiring` mock gap for `View501`/`View502`; runtime isolation green) |
| **Product @ `25767df`** | **PARTIAL-accepted-transport-stub** (`transport_stub=true`) |

---

## A. Landing order

| Check | Result |
|---|---|
| `git rev-parse 25767df^` | `39aecaff25dbacc008e9f66264bf13b691f576a7` — **match** builder claim |
| `git rev-parse 39aecaf^` | `ca950774f3d2b9f13d37b2bbca071e0958148874` (#267 re-audit docs) — **not** `d7b9741` directly |
| Ancestor `d7b9741` (#266) | **Yes** — `d7b9741` is ancestor of `25767df` via `ca95077` → `39aecaf` |
| `39aecaf..25767df` contains `docs/` | **No** — code-only (9 paths) |
| Pre-land tip `7833d39` | **Not fetchable** in auditor clone |
| Squash chain | `25767df` → `39aecaf` (#268 docs) → `ca95077` (#267) → `d7b9741` (#266) |

---

## B. Line counts and lattice

| Artifact | @ `d7b9741` | @ `25767df` |
|---|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 38,508 | 38,508 |
| `app/ops/operator-audit-console.tsx` | 5,665 | 5,665 |

### `route.ts` diff `d7b9741..25767df` (26 insertions / 26 deletions — repository rewiring only)

All hunks repoint **501/502** from the shared **489/490** deny-by-default reconciliation repos to dedicated `…TbAckReconPdFreezeSealView501` / `View502` repos. No handler blocks removed.

| Hunk group | Lines (approx.) | Change |
|---|---|---|
| `ensureWorkflowOpsAlertGovernanceRows` `existing*` reads | ~6412–6427 | `store`/`repos.get` → `View501` / `View502` |
| Governance batch `upsert` | ~7028–7031 | POST recompute writes → `View501` / `View502` |
| Governance batch `store.set` | ~7264–7273 | In-memory mirror → `View501` / `View502` |
| GET `listByFirm` | ~12711–12752 | **501** / **502** handlers → dedicated repos |
| POST lifecycle `current*` reads | ~14759–14802 | reconcile parents → `View501` / `View502` |
| POST reconcile/upsert/set (×3 waiver + ×3 variance) | ~36700–37059 | lifecycle writes → `View501` / `View502` |

**Lattice:** `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS` covers **24** slices **485–508** (`it.each` asserts `json.view`; order in array lists **506** after **508** — inherited PR260-M2). GET handlers remain through **508**; POST lattice unchanged.

---

## C. View parser and tests

- **`parseView`:** automated scan — **no** non-identity returns in `parseView` body (no `startsWith` remap).
- **`it.each`:** 24 lattice GETs assert `json.view` equals requested query param.
- **501/502 wiring:** dedicated `it()` with status-field assertions for **505–508** and **503/504**; **501/502** rely on lattice `it.each` + `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-501-502-frontend-real.test.ts` (meaningful action/view strings) — same incremental pattern as original #252 audit (minor, not new regression).

---

## D. Persistence (485–508)

### Same-family pairs (empirical)

| Pair | @ `d7b9741` | @ `25767df` |
|---|---|---|
| 489/501 | shared collection — leak class | **isolated** (builder + auditor scratch **6/6**) |
| 490/502 | shared collection — leak class | **isolated** |
| 493/505 | fixed @ #266 | **isolated** |
| 494/506 | fixed @ #266 | **isolated** |
| 495/507 | fixed @ #266 | **isolated** |
| 496/508 | fixed @ #266 | **isolated** |

**Builder test** `tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts`: **6/6 PASS** @ `25767df`.

**Regression detector @ `d7b9741`:** with HEAD 6-test file and **only** product files rewound, **489/501** and **490/502** fail (`repos.*View501/502` undefined); **493–508** pairs still pass — proves new cases target the prior leak class.

**Auditor scratch vitest** (all six pairs, deleted uncommitted): **6/6 PASS** @ `25767df`.

### 24-view collection table (GET repo = POST writer collection)

Binder: **deny** = `WORKFLOW_OPS_DENY_BY_DEFAULT_FIRESTORE_COLLECTION_BY_SPINE_KEY`; **inline** = `firestoreSpineRepositories.ts` `listByFirm(db, "…")`.

| View | Collection tail (unique per view) | Binder |
|---:|---|---|
| 485 | `…_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations` | inline |
| 486 | `…_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations` (variance) | inline |
| 487 | `…_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments` | inline |
| 488 | variance twin of 487 ack path | inline |
| 489 | `…_acknowledgments_external_transport_receipt_acknowledgment_reconciliations` (waiver) | deny |
| 490 | `…_external_transport_receipt_acknowledgment_reconciliations` (variance) | deny |
| 491 | `…_acknowledgment_reconciliation_external_distribution_audit_ledgers` | deny |
| 492 | `…_acknowledgment_reconciliation_partner_handoff_attestations` | deny |
| 493 | `…_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers` | deny |
| 494 | `…_partner_handoff_attestations_outbound_registry_attestation_ledgers` | deny |
| 495 | `…_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications` | deny |
| 496 | variance PD freeze seal verifications collection | deny |
| 497 | waiver TB recon on PD freeze seal path | deny |
| 498 | variance TB recon on PD freeze seal path | deny |
| 499 | waiver ack on PD freeze seal path | deny |
| 500 | variance ack on PD freeze seal path | deny |
| 501 | `…_tb_ack_recon_pd_freeze_seal_view501` | deny (`denyByDefaultWorkflowOpsRepository.ts:43–44`) |
| 502 | `…_tb_ack_recon_pd_freeze_seal_view502` | deny (`:45–46`) |
| 503 | long inline external-distribution audit ledger path | inline |
| 504 | partner-handoff attestations inline path | inline |
| 505 | `…_tb_ack_recon_pd_freeze_seal_view505` | deny |
| 506 | `…_tb_ack_recon_pd_freeze_seal_view506` | deny |
| 507 | `…_tb_ack_recon_pd_freeze_seal_view507` | deny |
| 508 | `…_tb_ack_recon_pd_freeze_seal_view508` | deny |

**489/490 vs 501/502:** collections are **distinct** after #269; GET/POST for **501/502** use `View501`/`View502` repos end-to-end (`route.ts` GET ~L12714/L12752; POST upsert/set in governance + lifecycle blocks).

**507/508:** `store.set` ~L7291–7297 and lifecycle `upsert` ~L37693+ / ~L37892+ write the same `View507`/`View508` collections GET reads (unchanged by #269).

**Rules:** new `match` lines for `view501` / `view502` (`firestore.rules` ~L207–L208); `tests/firestore.rules.test.ts` `it.each` exercises deny-write on **501, 502, 505–508** (6 paths).

---

## E. Tests and gates @ `25767df`

| Suite | Result |
|---|---|
| Focused ops vitest (21 files, no `-t`) | **212/215 PASS** — **3 FAIL** in `persistence.route-wiring.test.ts` (slices **501**, **502**, and parseView block hitting **501/502**): `repos.*View501/502` undefined in mocked `getRuntimeRepositories` |
| vs `d7b9741` focused ops | **213/213** → **215** tests (+2 isolation cases); file count **21** unchanged |
| `npm run test:rules` | **28/28 PASS** (was **22/22** @ `d7b9741`: **+6** `it.each` deny-write cases for dedicated collections in `firestore.rules.test.ts`) |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10 PASS** |
| `tests/pr-phase-claim-gate.test.ts` | **20/20 PASS** (Vitest worker `onTaskUpdate` timeout noise) |
| `check_pr_phase_claims.py` `BASE=39aecaf` `HEAD=25767df` | **PASS** (PR #269 body via `origin pr view 269`) |

### Majors

| ID | Finding |
|---|---|
| **M1** | `tests/persistence.route-wiring.test.ts` mock `getRuntimeRepositories` not updated for `…TbAckReconPdFreezeSealView501` / `View502` after route rewiring — **3** focused-suite failures (STANDARD: test regression). |

### Minors

| ID | Finding |
|---|---|
| m1 | `39aecaf^` is #267 (`ca95077`), not `d7b9741` — one docs commit between #266 and #268. |
| m2 | Pre-land branch tip `7833d39` not available to diff. |
| m3 | No dedicated repo-wiring `it()` with status fields for **501/502** (inherits #252 pattern). |
| m4 | Inherited #205 `persistence.repositories` ReferenceError (known; rules still **28/28**). |
| m5 | Vitest worker timeout noise during pr-phase-claim-gate. |

---

## F. `frontend_real` — GET 501–502

| View | File:line | Path |
|---|---|---|
| **501** GET | `app/ops/operator-audit-console.tsx` **4837–4850** | `GET /api/d2/ops-reporting` |
| **502** GET | `app/ops/operator-audit-console.tsx` **4851–4864** | `GET /api/d2/ops-reporting` |

Static ordering: `tests/ops.pr-tb-ack-recon-pd-freeze-seal-external-transport-ack-recon-501-502-frontend-real.test.ts`.

---

## References

- Original #252 audit: `docs/audits/phase-pr252-get-501-502-audit.md`
- Pre-fix lattice sweep (MAJOR on 489/501, 490/502): `docs/audits/lattice-485-508-collection-sweep.md` @ `39aecaf`
- #266 fix audit: `docs/audits/phase-pr258-pr260-reaudit-fix266.md`
