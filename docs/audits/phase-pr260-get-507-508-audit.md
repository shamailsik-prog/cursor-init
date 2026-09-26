# Independent Phase Auditor A–F audit: PR #260 TB ack-recon PD freeze seal partner-delivery receipt freeze-override seal verification GET 507–508

> **Verdict (2026-09-26, amended): FAIL phase audit — 1 major (cross-view data mixing), 5 minors. Product: PARTIAL.**

Repository: `shamail-sikander/cursor-init`  
Origin PR: [#260](https://cursor.com/codebase/shamail-sikander/cursor-init/pull/260) (squash-landed)  
Audited landed tip: `567d2450963a90994c8bcf4d446d977e8e07fe6e`  
Squash first parent: `60287c050b3fc1f8c55413b5c8fa5e4ad7b98776` (`docs(audit): independent PR #258 phase audit GET 505-506` — docs landing before product)  
Forge PR branch tip: `677734709370239e999359b1ad6027d9d5e04fb8` (fetched; tree identical to squash `567d245`).

Evidence logs: `/opt/cursor/artifacts/pr260_verification.log`, `/opt/cursor/artifacts/pr260_collection_scoping.log`

## Executive finding

Squash `567d245` is **code-only** (5 files, +873 / −1), extends the TB ack-recon lattice with GET **507–508** on **505/506** parents (same step pattern as **495–496** after **493–494**), six lifecycle POSTs parented on **505/506** rows, governance re-exports (+8 lines), and `/ops` call sites after the **505/506** block. `parseView` remains identity-only for TB views (automated scan: one inherited `activity` default at `route.ts` L573). Lattice `it.each` covers all **24** slices **485–508** (506 entry appears after 508 in the array — see PR260-M2). Dedicated repository wiring `it()` for **507** and **508** assert `partnerDeliveryReceiptFreezeOverrideSealVerificationStatus` (not status-only HTTP). Focused vitest replay (full lattice file set, no `-t` filter): **20 files, 209 passed, 0 skipped**. `transport_stub=true` caps product at **PARTIAL**. `check_pr_phase_claims.py` replay on PR #260 body with `BASE=60287c0`, `HEAD=567d245` and `HEAD=6777347` both **PASS**. **Collection-scoping follow-up** overturns the initial persistence PASS: shared `listByFirm` + no parent-key GET filter → **PR260-MAJOR-1** (phase audit **FAIL**); same defect class on **#258** pairs **493/505** and **494/506**.

## A. Landing order and squash scope — PASS

`git rev-parse 567d245^` → `60287c050b3fc1f8c55413b5c8fa5e4ad7b98776` (matches builder claim).

| Check | Result |
|---|---|
| Docs before #260 product | **PASS** — `60287c0` is direct parent of `567d245` |
| Squash diff code-only | **PASS** — no `docs/` paths in `60287c0..567d245` |
| Changed files | `route.ts`, `operator-audit-console.tsx`, governance re-export, `persistence.route-wiring.test.ts`, `ops.pr-tb-ack-recon-pd-freeze-seal-partner-delivery-507-508-frontend-real.test.ts` |

## B. Lattice integrity — PASS

| Artifact | @ `60287c0` (pre-squash) | @ `567d245` | Δ |
|---|---:|---:|---:|
| `app/api/d2/ops-reporting/route.ts` | 37,873 | 38,508 | +635 |
| `app/ops/operator-audit-console.tsx` | 5,533 | 5,665 | +132 |

- GET **507** handler: `route.ts` **L12860–L12893** (`…OutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications.listByFirm`).
- GET **508** handler: `route.ts` **L12897–L12930** (`…PartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications.listByFirm`).
- POST block comment **L37642**; six **507/508** lifecycle actions **L37643+** (checkpoint / attest / control × custody + closure).
- `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS`: **24** entries covering **485–508** (none missing).
- Prior GET slices through **506** remain in `parseView` and dispatch; no truncation observed.

## C. `parseView` and dispatch — PASS

- `parseView` body: **L572–L883**; automated scan: **0** non-identity TB remaps; inherited `activity` remap **L573** only.
- New identity branches for **507/508** at **L866–L871** (suffix extensions after **505/506** at **L863–L873**).
- `it.each` lattice asserts `json.view === requestedView` for every slice (`tests/persistence.route-wiring.test.ts` **L6571–L6581**).
- Dedicated wiring: view **(507)** **L6798–L6810**; view **(508)** **L6812–L6824** (`partnerDeliveryReceiptFreezeOverrideSealVerificationStatus`).

## D. Persistence and collection scoping — **FAIL** (major)

Deny-write rules and binder wiring are present, but **view isolation is not**: each lattice pair below calls the **same** `repos.*.listByFirm` property and resolves to the **same** Firestore collection string. GET handlers then apply only shared filters (clearance, optional `matterId`, lifecycle **status** query param, `freshnessStatus`, permission) — **no** filter on parent ledger / lineage foreign keys. Distinct document IDs do not prevent both lineages from appearing in both views.

| Pair | GET `listByFirm` (`route.ts`) | Binder (`firestoreSpineRepositories.ts`) | Same collection string? |
|---|---|---|---|
| **493 / 505** | **L12424** / **L12934** — `…ExternalDistributionAuditLedgersOutboundRegistryAttestationLedgers` | **L4070–L4073** — spine key `…OutboundRegistryAttestationLedgers` | **Yes** — `denyByDefaultWorkflowOpsRepository.ts` **L22–L23** |
| **494 / 506** | **L12459** / **L12971** — `…PartnerHandoffAttestationsOutboundRegistryAttestationLedgers` | **L4153–L4155** | **Yes** — map **L24–L25** |
| **495 / 507** | **L12495** / **L12862** — `…OutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications` | **L4091–L4094** | **Yes** — map **L26–L27** |
| **496 / 508** | **L12530** / **L12899** — `…PartnerHandoffAttestationsOutboundRegistryAttestationLedgersPartnerDeliveryReceiptFreezeOverrideSealVerifications` | **L4157–L4160** | **Yes** — map **L28–L29** |

**GET scoping (example 493):** after `listByFirm`, filters are **L12433–L12442** (`outboundRegistryAttestationLedgerStatus` query param only when set; no `transportBoundaryReceiptReconciliation…OutboundRegistryAttestationLedgerId` or view discriminator). **495** uses the same pattern at **L12504–L12513** (`partnerDeliveryReceiptFreezeOverrideSealVerificationStatus` only). **507** at **L12871–L12880** reuses the same status field filter — not parent-key scoping.

**POST / upsert:** lifecycle rows are built from parent ledger context (e.g. **507** checkpoint **L37680–L37693** passes `outboundRegistryAttestationLedger: currentTbAckReconPdFreezeSeal505…` into the row builder and `upsert`s to the shared seal-verification repo). Rows carry parent FK fields on the document, but **GET does not filter on them**, so **495** and **507** both return the full firm-wide collection contents (subject only to optional status/freshness filters).

**Empirical check (throwaway vitest, not committed):** seeded two rows per shared in-memory `listByFirm` (older + newer lineage IDs) for each pair; GET without status filter returned **both** IDs for **493** and **505**, **494** and **506**, **495** and **507**, **496** and **508** (`total: 2` each). Log: `pr260_collection_scoping.log` (vitest pass **2026-09-26**).

**Impact:** **PR #260** (**507/508**) and **PR #258** (**505/506**, plus the same pattern for **493–496**) — cross-view data mixing; newer views are not scoped to their parent lattice step.

**Fix recommendation (product, out of scope for docs PR):** either (a) a **distinct Firestore collection per view suffix** with matching deny-binder + rules, or (b) keep shared collection but add **parent-key / view-lineage filter** in each GET after `listByFirm` plus a **regression test** that seeds two parent lineages and asserts each view returns only its rows.

## E. Tests and gates — PASS (with minors)

| Command | Result |
|---|---|
| Focused vitest (20 files, **no** `-t` filter) | **20 files, 209 passed, 0 skipped** |
| `npm run test:rules` | **22/22** on auditor retry (first run **21/22** — filing route timeout flake; see PR260-M4) |
| `npm run gate:g0` | **PASS** |
| `npm run gate:g1` | **10/10** |
| `npx vitest run tests/pr-phase-claim-gate.test.ts` | **20/20** (Vitest worker `onTaskUpdate` timeout logged; tests green) |
| `check_pr_phase_claims.py` `BASE_SHA=60287c0`, PR #260 body | **PASS** (`HEAD=567d245`, `HEAD=6777347`) |

**Test-file reconciliation vs PR #258 auditor replay (19 files / 203 passed):**

| Metric | PR #258 auditor replay | PR #260 auditor replay | Δ |
|---|---:|---:|---|
| Vitest files | 19 | 20 | +1 `tests/ops.pr-tb-ack-recon-pd-freeze-seal-partner-delivery-507-508-frontend-real.test.ts` |
| Vitest tests | 203 | 209 | +6 (2 frontend-real + 2 `it.each` slices + wiring/parseView cases) |

No focused lattice file from #258 was dropped.

## F. `frontend_real` — PASS (transport stub honest)

| Step | File:line | Path |
|---|---|---|
| View constants **507/508** | `operator-audit-console.tsx` **L5218–L5221** | (constants) |
| GET view **507** | **L5223–L5236** | `runApiCall` → `GET /api/d2/ops-reporting` |
| GET view **508** | **L5237–L5250** | `runApiCall` → `GET /api/d2/ops-reporting` |
| POST checkpoint custody (**507**) | **L5252–L5267** | `runApiCallAllowingStatuses` → `POST /api/d2/ops-reporting` |
| POST attest custody | **L5268–L5284** | same |
| POST control custody | **L5285–L5299** | same |
| POST checkpoint closure (**508**) | **L5300–L5315** | same |
| POST attest closure | **L5316–L5332** | same |
| POST control closure | **L5333–L5347** | same |

Checkpoint/attest bodies use `blocked_todo_firm:transport_stub_tb_ack_recon_pd_freeze_seal_*:ops_probe` — consistent with `transport_stub=true`.

Static ordering test: `tests/ops.pr-tb-ack-recon-pd-freeze-seal-partner-delivery-507-508-frontend-real.test.ts`.

## Findings summary

| ID | Severity | Finding |
|---|---|---|
| PR260-M1 | **minor** | `transport_stub=true` — product remains PARTIAL (accepted policy). |
| PR260-M2 | **minor** | `TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS` lists slice **506** after **508** (all 485–508 present; not strictly ascending in source array). |
| PR260-M3 | **minor** | `pr-phase-claim-gate.test.ts` logs unhandled Vitest worker timeout; all 20 tests passed. |
| PR260-M4 | **minor** | First `npm run test:rules` run timed out one runtime-mode case (**21/22**); immediate retry **22/22** green (environment flake). |
| PR260-M5 | **minor** | No new `firestore.rules` / deny-binder diff in squash — reuse of **495/496** collections (see major below). |
| PR260-MAJOR-1 | **major** | **Cross-view data mixing:** lattice pairs **493/505**, **494/506**, **495/507**, **496/508** share one `listByFirm` repo + Firestore collection per pair; GET has no parent-key scoping (empirical vitest confirms both lineages returned). Affects **#258** and **#260**. Fix: distinct collection per view or parent-key filter in GET + test. |

## Final classification

| Dimension | Verdict |
|---|---|
| **Phase audit** | **FAIL** (1 major, 5 minors) |
| **Product** | **PARTIAL** (`transport_stub=true`; COMPLETE invalid) |
| `backend_real` | **PASS** (scoped) |
| `frontend_real` | **PASS** |
| `transport_stub` | **PASS** (honest) |

## Auditor replay commands

See `/opt/cursor/artifacts/pr260_verification.log` for full command output.
