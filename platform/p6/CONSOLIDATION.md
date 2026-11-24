# P6 consolidation (L16.3)

Spec: `docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt`.

- L16.3 purpose, one owner for learning, review, client, and the master write: L5561–L5566.
- Build steps (five learning modes, one advisor pass, one client channel, capabilities kept as modes): L5573–L5583.
- Single master write path: L5588. Governance note that the consolidation closes the self-mutating master: L5637–L5641.
- Erratum E-9: L17.5 is the owner; L4.6, L14.1 and L14.2 propose and do not write: L6825–L6833.
- L17.5 Master-Knowledge Service: L7051–L7086.
- Layer 18: CI fails a master write outside P6: L7859–L7864. G-3: L8488–L8489.
- Ownership row: L8661 (`L16.3` applied as D7-1 Advisor, D2-1 client channel, P6 learning).

F41 boundary: `docs/audit/2026-10-13-forensic-audit.md` L839–L853. Quarantine manifest: `platform/boundaries/legacyGovernanceQuarantine.json`. This change does not add files under the quarantined trees and the new modules do not import them. Deleting frozen chains is not this change.

## Decisions

- `platform/p6/masterWrite.ts` `writeMaster` (L234) is the only master write. It is not re-exported from `platform/p6/index.ts`. `executeMasterTableWrite` (L275) holds the `master_versions` and `master_knowledge` statements and is not exported. `scanP6MasterWriters` (L386) fails any other file under `platform/p6` that writes a `master_*` table, calls `.commitVersion(`, `.persistVersion(`, `sessionForWrite(`, `writeMaster(` outside the store and `proposeChange`, or `sealMasterSession(` outside the store. It reads `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.py` and `.sql`, the same suffixes as `ci_gates/check_master_writes.py`.
- `change_proposals` inserts and updates stay in `platform/p6/masterStore.ts`. A proposal is not a master version. The repo-wide guard still refuses those statements outside P6.
- Public `commitVersion` on the store (masterStore.ts L618 and L899) and on the session (L1042) calls `writeMaster`. The memory persist is `saveVersion` (L632), reached only through a session sealed inside `runExclusive`. `pgRaw` (L1077) stays inside the store. `sessionForWrite` is not exported. The ledger and the audit are staged on that transaction and published only after COMMIT. `writeMaster` loads the stored proposal (or the stored rollback target) and refuses a snapshot that is not that stored change.
- `applyChange` (proposeChange.ts L209, delegate L259) and `rollbackMaster` (L284, delegate L300) pass the public session into `writeMaster`. They do not receive the raw persist or the Postgres client.
- The write stays on when `SIKANDER_FLAG_P6_CONSOLIDATION` is unset. A flag-off second writer would fail the source scan. The flag gates the new learning, review and client entry points only (`platform/p6/consolidationFlag.ts` L8). Unset means off.
- Actor binding uses `normalizeActorKey` from the store, the same fold as approval. A substantive apply requires the stored partner decision, `authorId` equal to the stored `decidedBy`, and the approver's folded key different from the proposer's. A cosmetic apply requires the system author `p6`. A rollback requires a stored version in the same firm.
- The audit log and the once-only apply ledger are in-process. They are not a new table and not a new collection. They are published only after the transaction commits, and discarded if it rolls back. Durable once-only remains the store compare-and-swap and the one-proposal version constraint.
- `platform/p6/learners.ts` stays the G-3 posture gate (`learnersMayRun` L15, `assertLearnersStopped` L20). It is not a learning mode and it does not write. `platform/p6/learning/**` is reserved for L4.6 and is not created.
- Callers outside `platform/p6` are not edited. Shims for the eleven spec names live in this tree. Wiring them to the live routes is W2-WIRE.

## Learning — one path

Canonical module: `platform/p6/learningPath.ts` `runLearningPath` L48.

| Spec component | Old entry in this tree | Callers | Canonical |
| --- | --- | --- | --- |
| Style Learner (15) | none | none | `learnStyle` L76 |
| Firm-Data Learning (L3.2) | none | none | `learnFirmData` L80 |
| Continuous Learning (L4.6) | `learnersMayRun` L15 and `assertLearnersStopped` L20 in `learners.ts` (posture only) | `platform/p6/index.ts`; `tests/p6.g3.test.ts` | `learnContinuous` L84. Does not replace the posture gate. |
| User Memory (L14.1) | none | none | `learnUserMemory` L88. Proposes nothing and writes nothing. |
| Master Auto-Update (L14.2) | none | none | `learnMasterAutoUpdate` L92 |

Searched and left outside this consolidation (not master learning; outside the file lock):

| Entry | Callers | Why it is not a mode shim |
| --- | --- | --- |
| `functions/src/p1/config.ts` `learnedOverheadOf` L65 | `functions/src/p1/embedding.ts` L183; `functions/src/p1/gateway.ts` L563 and L1122 | P1 reservation overhead |
| `functions/src/p1/costTable.ts` `learnedOverheadCap` L115 | `functions/src/p1/gateway.ts` L1498; `functions/test/p1.units.test.ts` | Cost-table clamp |
| `functions/src/p1/costTable.ts` `reservationOverheadTokens` L126 | `functions/src/p1/embedding.ts` L183; `functions/src/p1/evalSet.ts` L207; `functions/src/p1/gateway.ts` | Reservation math |

## Review — one path

Canonical module: `platform/p6/reviewPath.ts` `runReviewPath` L30. One advisor pass. No model call. No master write.

| Spec component | Old entry in this tree | Canonical |
| --- | --- | --- |
| Suggestions Panel (L5.2) | none | `suggestForDraft` L36 |
| Draft Reviewer (L11.1) | none | `reviewDraft` L40 |
| Argument Strategist (L11.2) | none | `strategiseArgument` L44 |

Related checklist code, outside the lock, not shimmable here:

| Entry | Callers |
| --- | --- |
| `functions/src/d4/doctypes.ts` `reviewChecklistOf` L132 | `functions/src/d4/gateOps.ts` L221; `functions/src/d4/doctypeOps.ts` L92; `functions/test/d4.doctypes.test.ts`; `functions/test/d4.drafts.emu.test.ts` L1436 |
| `functions/src/d4/drafts.ts` `reviewChecklistView` L123 | `functions/src/d4/drafts.ts` L588 |
| `functions/src/d4/gateOps.ts` `parseReviewChecklist` L187 | `functions/src/d4/gateOps.ts` L853 |

## Client — one path

Canonical module: `platform/p6/clientPath.ts` `runClientPath` L31. `sent` is false. This module does not transmit.

| Spec component | Old entry | Callers | Canonical |
| --- | --- | --- | --- |
| Client Reporting (43) | `app/api/d1/reporting/route.ts` `GET` L258, `POST` L426 | HTTP route | `reportToClient` L44 |
| WhatsApp Self-Service (L8.1) | `services/d2-1/whatsapp.ts` `handleWhatsApp` L63; `services/d2-1/webhook.ts` `handleWhatsAppWebhook` L227 | `app/api/d2/court-ops/route.ts` L251; `app/api/d2/whatsapp/route.ts`; tests under `tests/d2-1.eight-command.test.ts`, `tests/gate_g1.test.ts`, `tests/spine.hardening.test.ts`, `tests/fa-d5-003.research-source.test.ts` | `whatsAppSelfService` L48 |
| Client Update | none | none | `pushClientUpdate` L52 |

Adjacent, not one of the three channels: `services/d1-1/clients.ts` `createClient` L11 and `conflictCheck` L63. Callers include `app/api/d1/clients/route.ts` L146, `tests/gate_g1.test.ts` and `tests/spine.hardening.test.ts`.

## Master write

| Entry | Line | Callers | Canonical |
| --- | --- | --- | --- |
| `proposeChange` | proposeChange.ts L143 | `tests/p6.g3.test.ts`, `tests/p6.master.pg.test.ts`, `tests/spine.hardening.test.ts` L349 | Stays a proposal. It does not write the master. |
| `approveProposal` | proposeChange.ts L163 | same P6 tests | Records the partner decision the writer requires. |
| `applyChange` | proposeChange.ts L209 | `tests/p6.g3.test.ts`, `tests/p6.master.pg.test.ts` | `writeMaster` L259 |
| `rollbackMaster` | proposeChange.ts L284 | same | `writeMaster` L300 |
| `commitVersion` | masterStore.ts L618, L899, L1042 | Public store and session | `writeMaster` via `guardedWrite` |
| `writeMaster` | masterWrite.ts L234 | `applyChange`, `rollbackMaster`, public `commitVersion` | Canonical. Not on `platform/p6/index.ts`. |
| `executeMasterTableWrite` | masterWrite.ts L275 | `writeMaster` only | Canonical SQL, not exported |

## W2-WIRE

Do not treat this list as wired.

- `app/api/d1/reporting/route.ts` `GET` / `POST` → `reportToClient`
- `services/d2-1/whatsapp.ts` `handleWhatsApp` and `services/d2-1/webhook.ts` `handleWhatsAppWebhook` → `whatsAppSelfService`
- `functions/src/d4/doctypes.ts` `reviewChecklistOf`, `functions/src/d4/drafts.ts` `reviewChecklistView`, `functions/src/d4/gateOps.ts` `parseReviewChecklist` → `runReviewPath` when an advisory pass is actually required
- Future L4.6 code under `platform/p6/learning/**` → `learnContinuous` / `proposeChange`, never a direct master write
- P1 overhead functions stay in P1

## Out of scope

- `platform/p6/learning/**` (L4.6)
- Route wiring, including `functions/src/index.ts`, `functions/src/http/router.ts`, `app/api/**`
- UI
- Live database, Postgres DDL, new Firestore collections
- Deleting or editing quarantined legacy governance files
