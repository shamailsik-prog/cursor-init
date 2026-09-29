# Independent re-audit — PR #258 / PR #260 after fix PR #266 (PR260-MAJOR-1)

**Auditor:** independent phase auditor (docs-only deliverable)  
**Fix landed SHA:** `d7b97414c441beb3b5f392ee14ec2a222fc156f3` (squash of PR #266)  
**Evidence log:** `/opt/cursor/artifacts/pr258_260_reaudit_verification.log`  
**Date:** 2026-09-29

## Executive verdict

| PR | Phase audit @ `d7b9741` | Product @ `d7b9741` |
|---|---|---|
| **#258** (GET 505–506) | **PASS** (PR260-MAJOR-1 remediated) | **PARTIAL-accepted-transport-stub** |
| **#260** (GET 507–508) | **PASS** (PR260-MAJOR-1 remediated) | **PARTIAL-accepted-transport-stub** |

`transport_stub=true` remains; no COMPLETE claim.

---

## A. Landing order

| Check | Result |
|---|---|
| `git rev-parse d7b9741^` | `e9e0acc30422e86575810494e574a7fa5ea6c6df` (#265 chore) — **match** |
| `git rev-parse e9e0acc^` | `0a23a7ddfa922355c1e2cfeb70ce69919ec1cda8` (#261 FAIL ledger docs) — **match** |
| `git diff --stat e9e0acc d7b9741` | Code-only (9 files); **no `docs/`** in squash delta |
| `git diff 39c457b d7b9741` | **empty** (0 bytes); squash tip matches pre-land branch tip after fetch |

### Chore #265 (`e9e0acc^..e9e0acc`)

Touches only:

- `.claude/hooks/check-gstack.sh`, `.claude/settings.json`, `CLAUDE.md`
- `tests/persistence.runtime-mode.test.ts` — single change: extends one `describe` timeout to `45_000` ms (`tests/persistence.runtime-mode.test.ts:6629`)

**No** Legal OS product source, **no** `firestore.rules`, **no** ops route/console changes, **no** test assertion changes. The timeout increase only raises the ceiling for an existing long-running runtime-mode block; it cannot mask failures (assertions unchanged).

---

## B. Line counts and lattice

| Commit | `route.ts` lines | `operator-audit-console.tsx` lines |
|---|---|---|
| `567d245` (#260 pre-fix) | 38,508 | 5,665 |
| `d7b9741` (#266 fix) | 38,508 | 5,665 |

`route.ts` line count unchanged (builder claim **38,508** confirmed).

### `route.ts` diff `567d245..d7b9741` (21 hunks)

All hunks are **repository rewiring** only (no handler removal):

1. `ensureWorkflowOpsAlertGovernanceRows` — `existing*` / `upsert` / `store.set` for **505–508** switch from shared **493–496** repos to `…TbAckReconPdFreezeSealView505` … `View508`.
2. GET handlers — `listByFirm` for views **505–508** point at dedicated repos (`route.ts` ~L12862–L12971).
3. POST paths — read/write/upsert for **505–508** aligned to the same dedicated repos (~L14807–L38015).

**Lattice:** `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS` in `tests/persistence.route-wiring.test.ts:6601–6722` includes slices **485–508** (24 GETs). **505/506** and **507/508** each have **6/6** POST actions in `/ops` (frontend-real tests). No truncation vs `567d245`.

---

## C. View parser and tests

- **`parseView`:** identity-only for lattice views **485–508** (`if (value === "…") return value` pattern; no `startsWith` remap in `parseView`).
- **`it.each`:** `tests/persistence.route-wiring.test.ts:6724–6733` asserts `json.view` equals requested query param for all lattice GET slices.
- **Dedicated wiring tests (meaningful fields):**
  - **505/506:** `tests/persistence.route-wiring.test.ts:6979–7013` (`outboundRegistryAttestationLedgerStatus`)
  - **507/508:** `tests/persistence.route-wiring.test.ts:6951–6977` (`partnerDeliveryReceiptFreezeOverrideSealVerificationStatus`)

---

## D. Persistence (PR260-MAJOR-1)

### Resolved Firestore collection names (runtime spine key → collection)

| View | GET `listByFirm` repo (spine key suffix) | Firestore collection tail (deny-by-default map) |
|---|---|---|
| **493** | `…OutboundRegistryAttestationLedgers` | `…_outbound_registry_attestation_ledgers` (`denyByDefaultWorkflowOpsRepository.ts:22–23`) |
| **494** | `…PartnerHandoffAttestationsOutboundRegistryAttestationLedgers` | `…_partner_handoff_attestations_outbound_registry_attestation_ledgers` (`:24–25`) |
| **495** | `…OutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications` | `…_partner_delivery_receipt_freeze_override_seal_verifications` (`:26–27`) |
| **496** | `…PartnerDeliveryReceiptFreezeOverrideSealVerifications` (variance track) | `…_partner_delivery_receipt_freeze_override_seal_verifications` (`:28–29`) |
| **505** | `…TbAckReconPdFreezeSealView505` | `…_tb_ack_recon_pd_freeze_seal_view505` (`:45–46`) |
| **506** | `…TbAckReconPdFreezeSealView506` | `…_tb_ack_recon_pd_freeze_seal_view506` (`:47–48`) |
| **507** | `…TbAckReconPdFreezeSealView507` | `…_tb_ack_recon_pd_freeze_seal_view507` (`:49–50`) |
| **508** | `…TbAckReconPdFreezeSealView508` | `…_tb_ack_recon_pd_freeze_seal_view508` (`:51–52`) |

GET/POST trace: `route.ts` handler → `repos.<spineKey>` → `createDenyByDefaultWorkflowOpsRepositoryBinder` → `WORKFLOW_OPS_DENY_BY_DEFAULT_FIRESTORE_COLLECTION_BY_SPINE_KEY` (`denyByDefaultWorkflowOpsRepository.ts:55–64`, wired in `firestoreSpineRepositories.ts` / `spineRepositories.ts`).

**505–508 collections are distinct from 493–496 and from each other** (suffix `view505`…`view508`).

### Rules and binder

- Four new deny-write `match` lines in `firestore.rules` (~L219–L227) for `view505`–`view508`.
- Four new binder entries (`denyByDefaultWorkflowOpsRepository.ts:45–52`).

### POST vs GET collection alignment

POST `upsert`/`set` for **505–508** uses the **same** dedicated repos as GET `listByFirm` (no write-to-old / read-from-new mismatch).

### Other lattice pairs (485–508)

No additional **parent/child view pairs** in **485–504** were found sharing one collection with unscoped `listByFirm` at `d7b9741`; earlier slices use distinct repos per wiring tests. The **493/505, 494/506, 495/507, 496/508** issue was the scoped regression.

### Empirical tests

| Test | @ `d7b9741` | @ `567d245` |
|---|---|---|
| Builder `tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts` | **4/4 PASS** | N/A (repos absent — would not compile) |
| Auditor scratch vitest (deleted; not committed) | **4/4 PASS** | — |
| Leak repro (seed shared `OutboundRegistryAttestationLedgers`; GET 493 + 505) | — | **PASS** (both GETs return both rows — proves pre-fix leak) |

Builder test **would have failed** at `567d245` on isolation assertions; leak repro **passes** at `567d245` demonstrating cross-lineage visibility.

---

## E. Tests and gates @ `d7b9741`

| Suite | Result |
|---|---|
| Focused ops vitest (21 files, no `-t`) | **213/213 PASS** |
| Added file vs #260 (20 files) | `tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts` |
| `npm run test:rules` | **22/22 PASS** |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10 PASS** |
| `tests/pr-phase-claim-gate.test.ts` | **20/20 PASS** (Vitest worker timeout noise; tests green) |
| `check_pr_phase_claims.py` `BASE=e9e0acc` `HEAD=d7b9741` | **PASS** (PR #266 body via `origin pr view 266`) |

### Majors

None at `d7b9741`.

### Minors

| ID | Finding | Evidence |
|---|---|---|
| M1 | `test:rules` / `persistence.repositories` do not include dedicated assertions for the four new `view505`–`view508` collection paths (rely on generic deny-write patterns + G-0 collection coverage). | `tests/firestore.rules.test.ts` — no `tb_ack_recon_pd_freeze_seal_view` string matches |
| M2 | Vitest worker `onTaskUpdate` timeout noise during `pr-phase-claim-gate` (20/20 still pass). | Log section E |
| M3 | Inherited #205 `persistence.repositories` ReferenceError minor (documented in ledger; non-blocking for this fix). | `docs/LEGAL_OS_PHASE_VERIFICATION.md` (#205 re-audit notes) |

---

## F. `frontend_real` — `/ops` → `/api/d2/ops-reporting` (505–508)

| View | File | Lines |
|---|---|---|
| **505** GET | `app/ops/operator-audit-console.tsx` | L5091–L5108 (`runApiCall`, `path: "/api/d2/ops-reporting"`) |
| **506** GET | `app/ops/operator-audit-console.tsx` | L5093–L5122 |
| **507** GET | `app/ops/operator-audit-console.tsx` | L5218–L5235 |
| **508** GET | `app/ops/operator-audit-console.tsx` | L5220–L5247 |

---

## Verdict summary

- **#258 / #260 phase audits:** **PASS** at `d7b9741` after PR #266 dedicated collections.
- **Product:** **PARTIAL-accepted-transport-stub** for both (unchanged transport stub policy).
