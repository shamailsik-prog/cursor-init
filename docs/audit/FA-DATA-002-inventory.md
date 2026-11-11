# FA-DATA-002 classification inventory

Finding: Q02 FA-DATA-002. Ranks are `public=0`, `internal=1`, `confidential=2`, `privileged=3`, `privileged-restricted=4` (`classification_rank` / Firestore `rank()`).

A downgrade is a write that stores a lower rank than the row already holds. Creating a new row at the caller's requested label is not a downgrade of a stored label.

## Postgres

| Object | Column | Writers | Downgrade before 007 | Downgrade after 007 |
| --- | --- | --- | --- | --- |
| `classification_rank` | `label`, `rank` | Seeded by `postgres/ddl/001_corpus_contract.sql` (`INSERT ... ON CONFLICT DO NOTHING`). No app-role DML. | No. Lookup table. | No. |
| `judgment` | `classification` | `judgment_monotonic` (`enforce_monotonic_classification`, 001) on UPDATE. `declassify()` is the only downgrade path and writes `judgment_declassify_grant` for the current xid, then deletes it. `corpus_writer`: SELECT, INSERT, UPDATE (003). `app_writer` is not created by DDL; the DDL integration test grants it SELECT, INSERT, UPDATE. | Only through `declassify()`, and only when the grant matches. `SET app.declassify_reason` does not bypass (FA-DATA-001). | Unchanged. 007 does not edit the trigger or `declassify()`. |
| `corpus_embeddings` | `classification_rank` | No standing INSERT/UPDATE/DELETE for `corpus_reader`, `corpus_writer`, `corpus_declassify`, `corpus_authority_reader`, `corpus_research_reader`, or `app_writer`. `005_research_reader.sql` revokes `corpus_reader`. `v_research_embedding` exposes a judgment vector only when `classification_rank = 0` and the judgment is research-visible. | A session that can write the table can INSERT rank 0 or UPDATE 3→0. `005` would then expose that vector. | `corpus_embeddings_monotonic` → `enforce_embedding_classification()` (007), BEFORE INSERT OR UPDATE, SECURITY INVOKER, `search_path = pg_catalog, public`. Unknown rank raises. An UPDATE that lowers the rank raises `Classification downgrade rejected: call declassify() with a partner reason` unless `entity_type = 'judgment'` and `judgment_declassify_grant` matches `(entity_id, txid_current(), rank of to_classification)`. A role that cannot SELECT the grant table fails closed. A judgment embedding must also be `>=` the source judgment's current rank (missing judgment or unknown source label raises). Statute embeddings have the monotonic guard and no judgment floor. |
| `judgment_declassify_grant` | `to_classification` | Inserted and deleted inside `declassify()`. `REVOKE ALL` from PUBLIC and from the app roles (001, and 007 does not grant it). | Not a stored document label. App roles cannot write it. | Unchanged. 007 reuses this table. No new table. |
| `judgment_classification_declassify_audit` | `from_classification`, `to_classification` | INSERT only from `declassify()`. App roles have no INSERT. | Audit history, append-only. | Unchanged. |

DELETE: no app role has DELETE on `judgment` or `corpus_embeddings`. The table owner does, by ownership. A DELETE then INSERT of a judgment at a lower label is not available to an app role, so 007 does not add a REVOKE. Embeddings have no FK to `judgment`; deleting a judgment does not rewrite `classification_rank`.

`declassify()` signature, grants, and `judgment_classification_declassify_audit` are unchanged. Embeddings do not follow a judgment declassify: they stay at the higher rank (fail closed). 005 already hides a vector whose rank is above 0.

`corpus_contract_relations()` stays 37 and `corpus_contract_routines()` stays 14. `enforce_embedding_classification()` is not added to either inventory function. EXECUTE is revoked from PUBLIC and from every app role. The trigger still fires for a role that holds table DML.

`corpus_service` pytest and `corpus_service/tests/e2e/lib.sh` apply a fixed Annex A list (`001`, `003`, `004`, `005`, `006`) and compare every public function with a hardcoded list of 14 routines. They do not apply 007, so the new function is invisible to `test_f19_contract_routines` and the e2e count. Adding 007 to that list without extending the hardcoded routines would fail those asserts. Those tests were not weakened.

## Firestore client SDK

Collections whose update can change a stored `classification`:

| Collection | Update rule | Downgrade |
| --- | --- | --- |
| `matter_members` | `firestore.rules` matter_members `allow update`. FA-F13-016 already stops a stored label being removed. | Before: a partner member could lower the label. After: a label the update leaves on the row requires `clearedNew()`, including a label added to a legacy row. A stored label also requires `monotonic()`. A legacy note update names no label, so `clearedNew()` is not evaluated. |
| `matters` | `allow update` already has `cleared`, `clearedNew()`, and `monotonic()`. Lifecycle fields are locked. | No. |
| `documents` | `allow update` already has `monotonic()`, `cleared`, and `clearedNew()`. | No. |
| `evidence_items` | `allow update` already has `monotonic()`, `cleared`, and `clearedNew()`. | No. |
| `propositions` | `hasOnly(['supersededBy', 'type', 'supports', 'confidence'])`. | The label is not writable. |
| `change_proposals` | `hasOnly(['status', 'decidedBy', 'decidedAt', 'reason'])`. | The label is not writable. |
| `notifications` | `hasOnly(['read', 'readAt'])`. | The label is not writable. |
| `users` | `hasOnly(['displayName'])`. `clearanceLevel` is not client-writable. | No classification field is writable. |

Creates are new rows. `documents` and `document_versions` creates also have `clientSourcedFloor()` (privileged minimum) and `atOrAboveMatter()`. `evidence_items` and `custody_events` creates require `clearedNew()`.

Every other collection in `firestore.rules` that stores a classification (including `clients`, `entities`, `entity_links`, `entity_aliases`, `merge_events`, `conflict_checks`, `conflict_events`, `matter_parties`, `matter_events`, `drafts`, `draft_versions`, `jobs`, `ocr_texts`, `committee_outputs`, and the `workflow_ops_*` / tenancy mirrors) has `allow write: if false` or `allow create, update, delete: if false`. The client SDK cannot lower those labels.

## Admin SDK writers exercised by this finding

`pair.label` / the auto-confirm read is `maxLabel` over the link rows, both entities, and their clients. An unknown label counts as the highest rank. Writing `pair.label` onto a row cannot store a rank below that row.

| Writer | Line | What it writes | Can it lower a stored label? |
| --- | --- | --- | --- |
| `functions/src/d1/entity/ops.ts` `confirmMerge` | 154 create, 157 update, 162 create | `classification: pair.label` on the merge event, every link row, and `entity.confirmed` | No. Test: stored `privileged-restricted` plus a `public` sibling stays `privileged-restricted`. |
| `functions/src/d1/entity/ops.ts` `disputeLink` | 188 update | `classification: pair.label` | No. Same shape of test. |
| `functions/src/d1/entity/ops.ts` `rejectLink` | 207 update | `classification: pair.label` | No. Same shape of test. |
| `functions/src/d1/entity/autoConfirmJob.ts` `stageMaterialisation` | 190 create, 193 update, 198 create | `classification: pair.label`. The job spec's own classification is not copied onto the link. | No. Test: link stored at `privileged-restricted`, entities at `public`, job spec `public`; the link stays `privileged-restricted`. |
| `functions/src/d1/entity/unmerge.ts` | 64 job spec, 83 update | `classification: pair.label` on the saga jobs and every link row | No. Test runs after confirm and the links stay `privileged-restricted`. |
| `functions/src/d1/matter/ops.ts` `openMatter` | 318 `boundClass = maxLabel(check, request)`, 319 `partyClass = maxLabel(boundClass, client)`, 333 matter create, 345 member create, 360 party create, 374 check update, 381 `conflict_events` create, 388 `matter.created` | The check update uses `boundClass`. Parties use `partyClass`. The matter, its new members, and `matter.created` are creates at the requested label. | The stored check cannot fall. Test: check raised to `privileged-restricted`, request `public`, client `public`; the check and every party stay `privileged-restricted`. New matter and member rows are created at `public`. |
| `functions/src/d1/matter/ops.ts` `advanceStage` / `closeMatter` | 585, 637 | New `matter_events` copy `matter.classification`. The matter update does not touch `classification`. Party updates set `matterStatus` only. | No stored label is lowered. |
| `functions/src/d1/client/ops.ts` `registerClient` | 198 | `linkClassification` keeps the higher of the stored link and the new client. | No. |

`functions/src/d1/entity/unmergeJobs.ts` reopens rows by state. It does not assign `classification` on the link.

## Admin SDK path not edited

`platform/persistence/firestoreSpineRepositories.ts` `members.upsert` (around the `isCanonicalMatterMemberRow` return) leaves a canonical stored member unchanged. A non-canonical stored member is `set` to `matter.classification`, which can be lower than a partial label already on that row. That file is outside this finding's writer list. The client-SDK `matter_members` update rule now rejects a lowered label; this Admin SDK path bypasses rules.

`services/d1-7/documentWorkflow.ts` has an in-memory `declassify` decision for a document object. Document workflow is outside this finding. `documents` client updates already have `monotonic()`.

## Guards, before → after

| Surface | Before | After |
| --- | --- | --- |
| `judgment.classification` | `judgment_monotonic` + `declassify()` | Same |
| `corpus_embeddings.classification_rank` | None. Rank 0 is visible through `v_research_embedding`. | Monotonic trigger, judgment floor, unknown rank rejected |
| `matter_members` client update | Removal of a stored label denied. Lowering allowed. | Removal still denied. A label left on the row requires `clearedNew()`. A stored label requires `monotonic()`. A legacy note update, which names no label, stays allowed. |
| Listed d1 Admin SDK writers | `pair.label` / `maxLabel` already includes the stored row | Unchanged. Tests now prove a stored `privileged-restricted` row is not stored lower. |
