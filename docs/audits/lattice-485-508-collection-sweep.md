# TB ack-recon lattice views 485–508 — collection sweep audit

**Commit:** `d7b97414c441beb3b5f392ee14ec2a222fc156f3`  
**Auditor:** independent (docs-only PR)  
**Context:** PR260-MAJOR-1; fix #266 gave views 505–508 dedicated Firestore collections. This sweep asks whether any other lattice slice still shares a collection without a parent/lineage filter on GET.

**Evidence log:** `/opt/cursor/artifacts/lattice_485_508_collection_sweep.log`

## Verdict: **MAJOR**

| Severity | Views | Issue |
|----------|-------|--------|
| Fixed at this commit | 493/505, 494/506, 495/507, 496/508 | Dedicated `…_tb_ack_recon_pd_freeze_seal_view505`–`508` collections; committed regression tests pass |
| **Open (same class as pre-266)** | **489/501**, **490/502** | Shared deny-by-default collection; GET `listByFirm` + optional status/matter/freshness only — **cross-lineage row leak confirmed** (throwaway vitest, not committed) |

## Shared collection groups (GET)

| Collection suffix (abbrev.) | Views | Parent / lineage FK on GET? | Leak test (no status filters) |
|-----------------------------|-------|-----------------------------|-------------------------------|
| `…_external_transport_receipt_acknowledgment_reconciliations` (waiver) | 489, 501 | No | **LEAKS** — both GETs return both seeded rows (`total: 2`) |
| `…_external_transport_receipt_acknowledgment_reconciliations` (variance) | 490, 502 | No | **LEAKS** — both GETs return both seeded rows (`total: 2`) |

No other pairs in 485–508 share the same Firestore collection name (each other slice is 1:1 GET↔POST collection).

## Recommended fixes (489/501 and 490/502)

Mirror fix #266:

1. Add dedicated collections + `createDenyByDefaultWorkflowOpsRepository` entries for the **501** and **502** lineage (or split **489** and **490** — pick the higher slice as the new store).
2. Wire GET handlers at `route.ts` **L12709–L12745** (501) and **L12747–L12783** (502) vs **L12281–L12314** (489) and **L12316–L12349** (490) to the new repos.
3. Point POST recompute upserts at **L7028–L7032** to the matching repos.
4. Add `firestore.rules` `match` lines and a two-lineage vitest (same pattern as `tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts`).

## Full slice table

Binder: **inline** = `platform/persistence/firestoreSpineRepositories.ts` inline `listByFirm(db, "…")`; **deny** = `createDenyByDefaultWorkflowOpsRepository` (+ map in `denyByDefaultWorkflowOpsRepository.ts`).

GET filters (all slices): clearance rank, optional `matterId`, optional `freshnessStatus`, `research` permission, plus optional slice-specific **status** query param (no lineage / parent FK).

| Slice | GET `route.ts` | POST `route.ts` | Binder | Collection (GET = POST unless noted) |
|------|----------------|-----------------|--------|--------------------------------------|
| 485 | L11776 `listByFirm` | L6974 `upsert` | inline L3800–L3804 | `…_partner_delivery_receipt_freeze_override_seal_verifications_transport_boundary_receipt_reconciliations` |
| 486 | L11814 | L6977 | inline L3950–L3953 | `…_partner_delivery_receipt_freeze_override_seal_verification_transport_boundary_receipt_reconciliations` (variance) |
| 487 | L11852 | L6980 | inline L3830–L3831 | `…_seal_verifications_transport_boundary_receipt_reconciliations_external_transport_receipt_acknowledgments` |
| 488 | L11890 | L6983 | inline L3859–L3863 | variance ack collection (487’s variance twin) |
| 489 | L12283 | L6992 | deny L3881–L3884 | `…_acknowledgments_external_transport_receipt_acknowledgment_reconciliations` — **shared with 501** |
| 490 | L12318 | L6995 | deny L3885–L3888 | variance `…_external_transport_receipt_acknowledgment_reconciliations` — **shared with 502** |
| 491 | L12353 | L6998 | deny | `…_acknowledgment_reconciliation_external_distribution_audit_ledgers` |
| 492 | L12388 | L7001 | deny | `…_acknowledgment_reconciliation_partner_handoff_attestations` |
| 493 | L12424 | L7004 | deny | `…_external_distribution_audit_ledgers_outbound_registry_attestation_ledgers` |
| 494 | L12459 | L7007 | deny | variance `…_partner_handoff_attestations_outbound_registry_attestation_ledgers` |
| 495 | L12495 | L7010 | deny | `…_outbound_registry_attestation_ledgers_partner_delivery_receipt_freeze_override_seal_verifications` |
| 496 | L12530 | L7013 | deny | variance PD freeze seal verifications collection |
| 497 | L12565 | L7016 | deny | waiver TB recon on PD freeze seal path |
| 498 | L12600 | L7019 | deny | variance TB recon on PD freeze seal path |
| 499 | L12638 | L7022 | deny | waiver ack on PD freeze seal path |
| 500 | L12676 | L7025 | deny | variance ack on PD freeze seal path |
| 501 | L12714 | L7028 | deny | **same collection as 489** |
| 502 | L12752 | L7031 | deny | **same collection as 490** |
| 503 | L12790 | L7034 | inline L4105–L4114 | `…_acknowledgment_reconciliation_external_distribution_audit_ledgers` (503-specific long path) |
| 504 | L12828 | L7037 | inline (partner handoff attestations repo) | 504-specific inline collection |
| 505 | L12934 | L7040 | deny View505 | `…_tb_ack_recon_pd_freeze_seal_view505` |
| 506 | L12971 | L7043 | deny View506 | `…_tb_ack_recon_pd_freeze_seal_view506` |
| 507 | L12862 | store L7291–L7293; lifecycle `upsert` L37693+ | deny View507 | `…_tb_ack_recon_pd_freeze_seal_view507` |
| 508 | L12899 | store L7295–L7297; lifecycle `upsert` L37892+ | deny View508 | `…_tb_ack_recon_pd_freeze_seal_view508` |

### Read / write collection mismatches

None found for slices **485–506** (GET repo === POST repo; same Firestore path via deny binder or inline spine).

**507 / 508:** Recompute batch does not call `repos.*View507/508.upsert` in the L6974–L7045 block; rows are written via `store.set` (L7291–L7297) and workflow lifecycle `upsert` (L37693+, L37892+). GET reads the View507/508 repos — **same collection** when those upserts run; not a collection name mismatch.

## Governance (binder + rules)

| Slice | Deny-by-default map | `firestore.rules` |
|-------|---------------------|-------------------|
| 485–488, 503–504 | Inline spine only (by design) | Present (e.g. rules L204, L206, L237, L4108 collection) |
| 489–502, 505–508 | Yes | Present (e.g. shared waiver/variance ack-recon L206–L208; View505–508 L219–L227) |

Automated sweep flagged “missing rules” for some long paths (494, 496, 499, 500, 506, 508) due to substring length limits; manual `grep` on `firestore.rules` confirms matching `match /…/{id}` blocks.

## Tests run

| Test | Result |
|------|--------|
| `tests/ops.pr-tb-ack-recon-lattice-dedicated-collection-lineage-isolation.test.ts` | **PASS** (493–508 pairs isolated) |
| Throwaway vitest 489/501 + 490/502 (deleted, not committed) | **PASS** — demonstrates leak (`total: 2` on both GETs per pair) |

## References

- Prior finding: `docs/audits/phase-pr260-get-507-508-audit.md`
- Wiring URLs: `tests/persistence.route-wiring.test.ts` (`TB_ACK_RECON_LATTICE_GET_VIEW_IDENTITY_REQUESTS`)
