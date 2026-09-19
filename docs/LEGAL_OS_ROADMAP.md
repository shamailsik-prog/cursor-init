# Legal OS roadmap (Phase A inventory)

Snapshot basis: current `main` as of this branch cut plus repository contents in `cursor-init`. The related `blueprint` repo was not accessible in this environment (`403`), so this inventory uses in-repo specs (`README.md`, `docs/HANDOVER_MANIFEST.md`, `docs/REPO_AUDIT_blueprint.md`).

## Coverage matrix

| Area | Status | Evidence in tree | Gap to complete legal OS |
|---|---|---|---|
| Matters / cases / parties | PARTIAL | Party/entity primitives in `services/d1-1/clients.ts`; matter primitives in `services/d1-2/matters.ts`; case-number attach flow in `services/d6-1/caseNumber.ts`; operational route `app/api/d1/matters/route.ts` uses repository abstraction with runtime persistence mode switching via `platform/persistence/runtimeRepositories.ts`; adapter layer in `platform/persistence/spineRepositories.ts` and `platform/persistence/firestoreSpineRepositories.ts`; emulator route tests in `tests/persistence.runtime-mode.test.ts`; forensic tests in `tests/gate_g1.test.ts`. | Matter writes/reads can run in Firestore mode, but surrounding lifecycle domains (follow-ups/jobs/events) still rely on in-memory operational state. |
| Courts / case-number normaliser / foundation console | DONE (Phase 0 scope) | Prefix-table normaliser in `core/case-number-normaliser.ts`; seed table `data/courts.json`; route `app/api/g0/normalise/route.ts`; UI in `app/foundation-console.tsx` (Courts tab); guard parity scripts in `ci_gates/case_number_normaliser.py` and `ci_gates/validate_case_numbers.py`. | Needs future extension only when firm closes `O-9` and additional courts/fixtures are validated. |
| Document ingest + classification + P1 masking / Committee Brain | PARTIAL | Ingest + dedupe semantics in `services/d1-6/uploadDocument.ts`; workflow transitions/reviewer actions in `services/d1-7/documentWorkflow.ts`; classification types/ranks in `platform/p1/types.ts`; outbound masking and provider policy in `platform/p1/maskOutboundPII.ts`, `platform/p1/providerPolicy.ts`; API routes `app/api/p1/committee-brain/route.ts`, `app/api/d1/documents/route.ts`, and `app/api/d1/document-workflow/route.ts`; persistence adapters in `platform/persistence/spineRepositories.ts`, `platform/persistence/firestoreSpineRepositories.ts`, and runtime switch in `platform/persistence/runtimeRepositories.ts`; runtime write-through for documents/workflow now includes OCR jobs and workflow timeline events; tests in `tests/api.committee-brain.test.ts`, `tests/p1.outbound-mask.test.ts`, `tests/api.documents.test.ts`, `tests/api.document-workflow.test.ts`, `tests/persistence.repositories.test.ts`, `tests/persistence.route-wiring.test.ts`, `tests/persistence.runtime-mode.test.ts`. | Firestore parity now covers document ingest + workflow queue/timeline, but cross-surface event/search/reporting paths and committee-brain output persistence are still not wired to durable storage. |
| Drafting / templates / filings | PARTIAL | Drafting guards for authority/temporal checks in `services/d4-2/draftingIntelligence.ts`; draft operations service in `services/d4-1/drafts.ts`; filing package/approval service in `services/d4-3/filingPackage.ts`; operational routes `app/api/d4/drafts/route.ts` and `app/api/d4/filings/route.ts`; drafts and filings routes now read/write through runtime persistence repositories in Firestore mode; route tests in `tests/api.drafts.test.ts`, `tests/api.filings.test.ts`, and runtime-mode emulator assertions in `tests/persistence.runtime-mode.test.ts`; master-writer boundaries via `platform/p6/proposeChange.ts`. | Still missing a full filing packet artifact assembler (annexures/attachments generation), production external submission channel integration, and persistence parity for draft template metadata/search analytics surfaces. |
| WhatsApp / Court Ops | PARTIAL | Command parser in `services/d2-1/whatsapp.ts`; Court Ops queue/actions in `services/d2-2/courtOps.ts`; operational route `app/api/d2/court-ops/route.ts` now syncs queue/resolution state through runtime persistence repositories (`follow_ups`, `document_workflow`, `workflow_events`); permission checks in `platform/p5/checkPermission.ts`; tests in `tests/api.court-ops.test.ts` and emulator parity checks in `tests/persistence.runtime-mode.test.ts`. | Still lacks real WhatsApp transport adapter, full production command grammar/workboard UX, and persistence parity for follow-up creation at source (case-number/intimation writers). |
| Auth, tenancy, permissions, audit | PARTIAL | Permission engine in `platform/p5/checkPermission.ts`; tenancy admin/session helpers in `platform/p5/tenancyAdmin.ts`; operational auth/tenancy route `app/api/p5/tenancy/route.ts` (session bootstrap, partner-admin user/membership reads, role updates); tenant boundaries in service checks (`services/d1-2/matters.ts`, `services/d1-1/clients.ts`); Firestore deny-by-default policy in `firestore.rules`; audit rows in `platform/spine/store.ts` and `platform/classification/declassify.ts`; tests in `tests/api.tenancy.test.ts`. | Still lacks production external auth/IdP integration, persistent identity/session store, and durable audit query/reporting surface. |
| Gates G-0 / G-1 and CI | DONE (for foundations) | Gate scripts `ci_gates/gate_g0.sh`, `ci_gates/gate_g1.py` + guard scripts; tests under `tests/`; CI workflow `.github/workflows/gate-g0.yml`. | Future layers must keep extending tests while preserving current fail-closed guard posture. |
| Deploy path | PARTIAL | Local run + gate instructions in `README.md`; standard Next scripts in `package.json`; CI automation in `.github/workflows/gate-g0.yml`. | No explicit production deployment manifests/runbooks (environment promotion, secrets management, service topology, recovery). |

## Recommended immediate slice (Phase B)

Ship a first-class **Matters/Cases operational API slice** on top of existing D1/D6 service primitives:

1. Add idempotent create/list endpoints for matters with tenancy + permission checks.
2. Add case-number recording endpoint wired to the existing normaliser path.
3. Persist an audit trail for matter lifecycle actions.
4. Cover with API tests (idempotency, pagination cursor, tenant isolation, permission denial, case-number outcomes).

Rationale: this closes a high-value PARTIAL area already in-tree, improves real product operability, and does not require firm-only secrets.

## NEXT PHASE (queued for follow-up agent)

Build **follow-up source persistence parity**:

1. Persist follow-up creation at source (`services/d6-1/caseNumber.ts`, `platform/p4/intimation.ts`) through runtime repositories so Court Ops does not depend on in-memory-only event creation.
2. Add persistence adapters for matter memberships (or equivalent durable membership source) to reduce dependence on in-memory membership maps in route permission checks.
3. Add emulator-backed route tests proving follow-up creation + Court Ops queue visibility across independent request flows.
4. Preserve existing idempotency, tenant boundaries, and classification checks while backend mode changes.
