# F42: confidential data retention and deletion across copies (design)

Date: 2026-10-24. Branch: `claude/remediate-f42`. Finding: `docs/audit/2026-10-13-forensic-audit.md`, "### F42" (HIGH,
P0). Dependencies named by the audit: firm retention decisions, F03 (document vault), F19 (corpus contract). Related:
F33 (backups, merged), F34 (decision records, merged in #121 and merged into this branch), F43 (durable alerts, in flight on
`claude/remediate-f43`).

## 1. The finding, restated against the current code

The repository holds matter-derived data in many representations and has no protocol that removes or retains all of
them together:

- **Records.** Firestore `matters`, `matter_members`, `documents`, `document_versions`, `ocr_texts`, the D4 drafts
  (`drafts`, `draft_versions`, `draft_gate_results`, `draft_gate_overrides`), the P1 records (`committee_outputs` with
  the masked prompt and the AI text, `ai_usage_logs`, `p1_ocr_operations` with OCR text), `jobs`, and about 180 legacy
  Next collections (`workflow_ops_*`, `filing_*`) whose rows carry `matterId` and free-text reasons.
- **Indexes.** `matter_client_search_index` and the reporting rows (`matter_report_*`). The Next reporting route
  republishes a search row for every matter `syncFirmMatters` lists and seeds reporting rows for each, so a purged index
  row comes back while the matter row exists.
- **Objects.** The F03 vault writes encrypted objects at `<scheme><firmId>/documents/<docId>/v<n>`. F33 put them under
  a seven-year COMPLIANCE object lock (`infra/backup/document-vault.json`: 2555 days), so no deletion is possible before
  the lock expires.
- **Traces.** P1 exports a trace per call to a self-hosted Opik (`functions/src/p1/opik.ts`), with the masked prompt
  and response at ranks 0 to 3. The trace id is on the usage row (`ai_usage_logs.trace.id`).
- **Backups.** F33: Firestore PITR (7 days), daily scheduled backups (14 weeks), weekly export bucket (35 days);
  Postgres base backups (14 days). A deleted row lives on in these until they expire.
- **Vectors.** The only vectors are the public law corpus (`judgment.embedding`, `corpus_embeddings`). No matter
  document is embedded anywhere in the tree.

On main there is no deletion path at all (no route deletes a matter; `closeMatter` sets a status), no tombstone, no
acknowledgement, no legal hold, no inventory, and two exposure paths that survive revocation: the reporting search
lists every matter of the firm to any cleared staff member regardless of membership, and the `matter_client_search_index`
rows outlive the matter.

## 2. Scope ruling (from the brief, applied)

The retention periods and the legal-hold policy are the firm's legal decisions. This change builds the mechanism and
ships the policy as versioned configuration whose every value is **PROPOSED, owner ratification required**:

- every retention class defaults to `retain`, and matter content classes default to **legal hold on**;
- every number proposed (periods, windows, deadlines) is marked PROPOSED in `infra/retention/policy.json` and here;
- no statute, rule or regulation is cited as the source of any period. Where the architecture spec mentions a period
  (six years at open item O-8; seven years in Module 9), it is recorded as the spec's proposal, and its legal basis is
  **[REQUIRES VERIFICATION]**.

In repo and demonstrated here: the inventory and its gate, the policy file, the deletion protocol (request, approval,
tombstone, saga, acknowledgements, legal hold, unacknowledged alert), read refusal in both API stacks, revocation from
search, and the retention job, all under the Firestore and Auth emulators.

NOT DEMONSTRATED live: the deployed functions and schedules, the R2 lifecycle that deletes vault objects after their
lock, the Opik deletion call, backup expiry in a real project, the delivery of F43's pages, and Firestore TTL timing.

## 3. Rulings

Each ruling states the decision and the reason. Stress tests follow in section 9.

**R1. The matter is the unit of deletion.** A deletion request names one matter. Client-record erasure is out of
scope: a client row can serve several matters and feeds conflict screening (R8). Reason: the finding's failure
scenario is a deleted or revoked matter; the client registry needs its own decision (follow-up FU-1).

**R2. Policy as versioned configuration.** `infra/retention/policy.json` carries `policyVersion`, `status: "PROPOSED"`,
`ratifiedBy: null`, the deletion rules (approval window, acknowledgement deadline) and one entry per retention class:
`onMatterDeletion` (`retain` | `purge` | `anonymise` | `expiry` | `external` | `lock`), `legalHold` (bool),
`periodDays` (null = no periodic deletion), `periodicAction`, `basis` (always `[REQUIRES VERIFICATION]` or a plain
engineering reason) and `proposed` (the values offered for ratification, inert). Defaults: every class `retain`, legal
hold on for `matter_record`, `matter_content`, `derived_index`, `ai_record`, `job_record`, `legacy_matter_ops` and
`vault_object`. Reason: the brief; a config file is reviewed and versioned like code, and the default cannot destroy
anything.

**R3. The inventory is code, and a CI gate.** `infra/retention/inventory.json` lists every store (Firestore
collection, object prefix, Postgres table, external processor, backup set). Each store names a `profile` that carries
the classification, retention class, who may delete and how deletion is acknowledged, plus a `key` saying how a
matter's rows are found (`docId`, `field` with the field name, `none`, `ttl`, `objects`, `traceExport`, `backup`).
`ci_gates/check_data_inventory.py` (G-0 step 22) fails when:

- a collection in a `firestore.rules` match block, or named by a Firestore collection literal in TypeScript
  (`.collection("x")`, `collection(db, "x")`, `doc(db, "x", ...)`, a helper call `(db, "x"`, `COLLECTION = "x"`), is
  not inventoried;
- an object key segment of the form `${firmId}/<segment>/` in TypeScript is not an inventoried object prefix;
- a Postgres relation (`CREATE TABLE` or `CREATE [OR REPLACE] [MATERIALIZED] VIEW` in `postgres/ddl/*.sql`, the
  name read whole when schema-qualified; `__tablename__` in `corpus_service`, `create_table` in its migrations) is not
  inventoried. Views are recorded like their base tables (`"relation": "view"`): the corpus contract's `v_*`
  views, the authority read views (004) and FA-D5-003's research views (005, `v_research_judgment`,
  `v_research_embedding`) are all profile `public_corpus`: public law corpus, no client or matter data, out of the
  scope of matter deletion (`not_applicable`);
- an entry is malformed, names an unknown profile or retention class, duplicates a store, or is stale (in no source),
  unless it is `pending` on a named finding.

`p1_decisions` (F34) was first registered as `pending: "F34"` (the gate accepted it absent, and notes it once present).
F34 has landed (#121, merged into this branch): the record is one server-only row per P1 attempt,
`p1_decisions/{usageLogId}`, keyed by `traceId`, `firmId` and `matterId`, holding hashes and verdicts and no text. It
is now inventoried for real: class `ai_record` (as the usage rows it mirrors), key field `matterId`, anonymised on
deletion by nulling `matterId` (the record stays for spend and reproducibility, without the matter), aged by
`settledAt`. Reason: the brief and the coordinator's ruling (the saga must purge or anonymise a deleted matter's
decision records and acknowledge them); a rules match block and a code literal are the two ways a collection enters
this tree, and both are cheap to scan exactly.

**R7a. Opik copies come from every row that records an export.** F34's trace record carries `matterId`, and F34's
reconciler re-exports a trace whose call-time export failed, recording the result on the decision record only. So
the Opik store (`external:opik`) names two sources: usage rows whose `trace.status` is `exported`, and decision
records whose `export.state` is `exported` or `pending` (a pending one may still be exported, before or after the
saga anonymises it; `failed` and `disabled` never reach Opik). The prepare job reads both before any purge job
anonymises them. F34's export state machine is left untouched (its lane): a reconciler run that claimed a record
before the anonymisation may export a trace that still names the matter; its id is already in the request.

**R4. Who may delete: two partners.** The retention actions (`retention.request_deletion`,
`retention.approve_deletion`, `retention.read`, `retention.hold.place`, `retention.hold.release`) are firm
administration in the shared P5 table: partner only, firm level. They do not require matter membership, so a hold or
a status read still works after the approval revokes every membership; instead each operation requires the partner's
clearance to reach the matter's label (an unreadable label is refused). A request is made by one partner; the approval
must come from a different partner (`second_partner_required`) within the approval window (PROPOSED 72 h,
`approval_expired`). One open request per matter (`deletion_request_open`). Reason: the brief's "P5-authorised firm
admin plus a second partner approval"; firm administration is partner-only in this codebase; two-person control is
the standard safeguard against an irreversible act.

**R4a. A lapsed request ends as `expired` (Codex P2 on PR #128).** A request still `pending_approval` past its window
is over: the call that finds it records the end, so it never holds the matter's one open request. An approval attempt
by a second partner moves it to `expired` and answers 200 `{ status: "expired", refusal: { code: "approval_expired" } }`
(recorded like a hold refusal: a deny audit row in the same transaction). A new request for the matter expires a lapsed
one in its own transaction (`expiry.supersededBy` names the new request) with an audit row
`retention.request_expired` (deny, `approval_expired`, target the old request), then opens; an `in_progress` request,
or a pending one within its window, still refuses it. The record is `expiry: { code, at, by, supersededBy }`, shaped
like `refusal`. The new request needs a second partner as before. Reason: before this, approval refused the lapsed
request yet left it pending, and the guard then refused every replacement, so the matter could never be deleted.
Ruling: **no cancel route**. The window already bounds a request, the second partner is the control on an unwanted
one (they decline to approve), and a legal hold refuses the approval; a cancel would add a third partner-only route
for no case these do not cover. Recorded as FU-6 should the firm want early withdrawal.

**R5. The tombstone and the revocation commit together.** The approval transaction re-checks the request, the policy
and the matter hold, then writes `matter_tombstones/{matterId}`, deletes every `matter_members` row of the matter
(Functions caps a matter at 20 members; the transaction refuses more than 400 with `matter_members_over_limit`),
moves the request to `in_progress` with its plan (the expected store keys), and enqueues the saga's first job. The
tombstone holds ids, the label, counts and SHA-256 hashes only. Reason: the tombstone gives both API stacks an
immediate, explicit refusal; removing memberships in the same commit also closes every membership-gated path the
tombstone check does not reach (Firestore rules for client-SDK reads, in-transaction membership re-checks of writes
already in flight).

**R6. Reads refuse a tombstoned matter at once, in both stacks.**

- Shared table (`platform/p5/permissionDecision.ts`): `DecisionMatter` gains `deleted`; a named matter of the
  caller's firm that is deleted is refused `matter-deleted`, after the cross-firm check (so existence never leaks
  across firms) and before membership.
- Functions (`functions/src/p5/permission.ts`): `evaluate` reads `matter_tombstones/{matterId}` with the matter. This
  covers every Functions operation that names a matter and the F02 authority gate that runs before each Next domain
  route in production (`enforceMatterAndClassification`). A tombstone without its matter row (purged) still refuses
  `matter-deleted`. `listMatters` drops tombstoned matters from its page.
- Next (`platform/persistence`): the Firestore repository's firm-scoped `getById` and every firm-scoped list page drop
  a row whose matter (the row id for `matters`, else `matterId`, else `linkedMatterId`) is tombstoned for the firm.
  This covers the Next core in and out of the authority frame (lists, document, draft and report reads, the matter
  sync that the caches use). Committee Brain needs no change of its own: its route reconciles the matter cache
  through the repository first (`syncFirmMatters`), so `committeeScope.loadMatter` finds neither a repository row nor
  a cached copy of a tombstoned matter, and in production the F02 authority gate refuses it before the route runs.
- P2 (`functions/src/p2/worker.ts`): a job naming a tombstoned matter is refused before its handler runs, with the new
  permanent engine code `matter_deleted`, so OCR, P1 and other matter jobs cannot write after the tombstone.

Reason: the brief ("every later read through either API stack refuses the deleted matter at once"); these are the
choke points every read already passes, so no route needs its own check.

**R7. The saga.** Two P2 saga job types, both firm-level (`matterId: null`, so the purge of `jobs` never removes them
and the worker check in R6 never refuses them):

- `retention.matter.prepare`: writes the acknowledgements that need no Firestore purge (retained, not applicable,
  expiry, external, lock), records the Opik deletion request (every trace id of exported or pending traces, R7a, in
  bounded parts, R7b), then enqueues `retention.store.purge` jobs for the stores whose action is `purge` or
  `anonymise`, at most 12 stores per job.
- `retention.store.purge`: for each of its stores, deletes (or anonymises) the matter's rows in fenced chunks of up
  to 200, then, in one fenced step, re-queries the store (rows written since are purged first) and writes the store's
  acknowledgement. A job that would pass 45 recorded steps hands over (R7c).

Every effect is a `runFenced` step, so a crash resumes after its last committed step and a replay writes nothing
twice. A store's key is its id with every character outside `[A-Za-z0-9]` as `_`; an id longer than 80 characters
(some legacy collection names run to 1,500, past Firestore's field-name limit) keeps 48 characters plus `_h` and 24 hex
characters of its SHA-256 (the gate computes the same key and fails on a collision). Each acknowledgement is
`deletion_acks/{requestId}_{storeKey}` plus an entry in the request's `acked` map, in one transaction; the transaction that records the last expected store finishes the request (`status: "completed"`,
`completedAt`) and stamps the tombstone. A store acknowledged twice keeps its first acknowledgement. Reason: the
brief's "fenced P2 saga", modelled on the un-merge saga (`functions/src/d1/entity/unmergeJobs.ts`).

**R7b. The Opik request is never cut short (Codex P2 on PR #128).** The request is a summary
`deletion_external_requests/{requestId}_opik` (count, part count, SHA-256 of every id, `pending_operator`) and parts
`{requestId}_opik_p{n}`, each at most 5,000 ids and 256 KiB, all written in the one fenced step that acknowledges the
store (at most 24 parts, about 6 MiB, within one commit). The step precedes the enqueue step, so every id is
recorded before any purge job exists to anonymise a row. One step rather than one per part, so a retry never re-splits
ids an earlier attempt recorded (the id set can shift between attempts as F34 settles pending exports). Past 24 parts
(120,000 ids) the prepare job fails permanently with `external_ids_over_limit` before any purge: nothing is
anonymised and the request's alert (R10) fires. Reason: the request once kept the first 10,000 ids and acknowledged
the store, and the purge then nulled `matterId` on the rows that held the rest, so those ids were lost.

**R7c. A purge job hands over without dropping a store (Codex P2 on PR #128).** At the budget the job acknowledges,
in a step of its own (`ack-{part}-p{i}`), the purge and anonymise stores it finished, then enqueues a continuation for
the rest and the vault lock (whose count grows with every document the rest purges; a lock store is never
acknowledged early). Continuations are numbered (`g0`, `g0c1`, `g0c2`; the old `c` suffix stopped growing at 20
characters, after which a continuation would dedupe to an earlier job). The budget counts the steps the job recorded
in every attempt (P2 keeps them all, at most 50): a job retried after a crash late in its budget hands over at once
instead of failing permanently with `fenced_step_limit`. Reason: a job that passed its budget after finishing a store
passed only the rest to its continuation, so the finished store was never acknowledged and the request stayed
`in_progress` for good; the retry budget was found while fixing it (same symptom, same function).

**R8. Store treatments.**

| Store kind | Treatment | Acknowledgement |
| --- | --- | --- |
| Firestore, matter-keyed, action `purge` | rows deleted | `purged`, count, SHA-256 of sorted ids |
| Firestore, matter-keyed, action `anonymise` | the store's `anonymise` fields set (for P1 spend rows and F34 decision records: `matterId` to null) | `anonymised`, count, hash |
| Firestore, action `retain` | nothing | `retained` with the class |
| Firestore or Postgres with no matter key | nothing | `not_applicable` |
| Operational TTL stores | expire under their TTL | `expiry`, window end |
| F03 vault objects | a `vault_object_tombstones` row per object written in the same transaction that deletes its document row; deletion after the lock by an R2 lifecycle rule that honours legal holds (NOT DEMONSTRATED) | `lock_pending`, object count, latest lock end |
| Opik traces | a `deletion_external_requests` row with the trace ids from usage rows and decision records (R7a), for the operator to send (NOT DEMONSTRATED) | `external_requested` (or `not_applicable` when none was exported) |
| F33 backups | expire under the backup retention | `expiry`, window end = approval + the longest configured backup retention (Firestore 14 weeks) |
| Public corpus (Postgres, vectors) | out of scope: public law, no client data | `not_applicable` |

The matter row itself is **anonymised, not purged**, when its class says so (the proposed value): its `title` is
cleared and its `caseNumber` nulled, its id, firm, client, label and status stay, and the write bumps the firm's
registry version. Reason: the conflict screen reads matter rows by client and by opposing party
(`functions/src/d1/conflict/candidates.ts`), so a purged row would blind future screens; the tombstone keeps every API
read of it refused. An anonymised row of a field-keyed store must null its key field (config validation and the
gate), so it leaves the matter's query and the saga never finds it again.

The conflict register (`clients`, `entities`, `entity_*`, `merge_events`, `matter_parties`, `conflict_*`,
`autoconfirm_deferrals`) and the audit trail (`audit_log`, `audit_outbox`, `audit_dead_letter`, `events`, the
retention collections themselves) are class `conflict_register` and `audit_trail`, `retain` by default and in the
test policy. Reason for the conflict register: a firm must keep knowing whom it acted for and against to screen future
conflicts; deleting the parties of a deleted matter would make the next screen blind. That is an ethics and policy
point for the owner to ratify; no rule is cited (**[REQUIRES VERIFICATION]** for any professional-conduct basis).
Reason for the audit trail: the brief ("the audit trail of the deletion itself must survive").

**R9. Legal hold.** Two sources: the policy (`legalHold: true` on a class whose stores the plan would purge,
anonymise or lock) and the matter (`legal_holds/{matterId}`, `active: true`, placed by any partner with a reason code,
released by a partner other than the one who placed it). Checked at request, at approval and inside every fenced purge
step. A refusal at request or approval returns 200 with `status: "refused"` and `refusal.code`
(`legal_hold_policy` | `legal_hold_matter`) and is recorded on the request and in the audit log; a hold placed while
the saga runs halts it (the purge step throws the permanent `legal_hold_active`, the request records `halted`) and
the request stays unacknowledged, which the watch reports. Reason: the brief; a hold must stop destruction wherever it
is found.

**R10. Unacknowledged stores raise an alert.** `retentionDeletionWatch` (every 15 minutes) finds `in_progress`
requests past their acknowledgement deadline (approval + PROPOSED 24 h) that have not been alerted (`alertedAt` is
null from the approval, filtered in the query, so a page of old alerted requests, such as ones a hold halted for good,
cannot hide a new one). For each one, in one transaction, it re-reads the request, raises F43's durable alert
`retention.deletion_unacknowledged` (`prepareAlert` / `stageAlert`: an `ops_alerts` row, acknowledged and escalated
operator, then partner, then firm admin, each level paged once) and stamps `alertedAt`, so the alert commits if and
only if the stamp does. The alert's subject is the request (`deletionRequest:<id>`, ref `deletion_requests/<id>`) and
its detail is counts only (`expected`, `acked`, `missing`): no matter id, so the alert record stays out of
matter-deletion scope. Severity `high` (30 minutes to acknowledge before it escalates).

The brief allowed a narrow seam because F43 had not landed; the first build logged
`retention.deletion_unacknowledged` at ERROR under a log-based policy. F43 landed on main (#120) and was merged into
this branch, so the alert moved to F43's durable seam (coordinator ruling): the F42 log line and its alert policy are
retired, and delivery runs through F43's pages and its registered `ops_alert.notified` policy. The one change in F43's
own files is the condition name added to `ALERT_CONDITIONS` (`functions/src/alerts/model.ts`).

**R11. Retention execution.** `retention.apply` is a scheduled P2 job (`retentionApplyTick`, daily 01:00 PKT, the
architecture's `autoPurgeExpired` slot), one run per firm per day. For each class with `periodDays` and a deleting
`periodicAction`, and each store of that class with an `ageField`, it deletes (or anonymises) rows older than the
period in fenced chunks, skipping any row whose matter is under a policy or matter hold, and writes a
`retention_runs/{firmId}_{day}` summary (counts per store, no content). With the default policy (no periods) it
deletes nothing; a test policy proves the deletion. Reason: the brief.

**R12. Revocation removes the matter from search.** The reporting route shows a matter-keyed row (search rows of type
`matter`, relevance and export rows) only to a member of that matter, as `firestore.rules` and the Functions stack
already require (R-2: membership is the access source, no role exempt). A revoked user therefore loses the matter from
search at the next read; client rows are unchanged. There is no matter-content vector store to filter (section 1).
Reason: the brief; the old behaviour showed every matter of the firm to any cleared staff member.

**R13. Rules.** `matter_tombstones`, `deletion_requests`, `deletion_acks`, `legal_holds`,
`deletion_external_requests`, `vault_object_tombstones` and `retention_runs` are server-only
(`allow read, write: if false`); the routes serve them. Reason: only Cloud Functions write them, and the G-2 rules
sweep covers server-only blocks.

**R14. What the deletion trail keeps.** Requests, acknowledgements, tombstones, external requests, vault tombstones,
run summaries and audit rows hold ids, labels, codes, counts, timestamps and SHA-256 hashes. Never a title, body,
name, prompt or text. A test asserts that no field of them contains the matter's title or the draft's body.

**R15. Next memory mode has no tombstones.** Memory persistence is refused in production (F01) and has no Firestore to
hold a tombstone; the mechanism is Firestore-mode only.

## 4. Data shapes

- `deletion_requests/{requestId}`: `firmId`, `matterId`, `classification`, `status` (`pending_approval` | `refused` |
  `expired` | `in_progress` | `completed`), `requestedBy`, `requestedAt`, `reasonCode`, `approvedBy`, `approvedAt`,
  `refusal` (`{ code, at, by }` or null), `expiry` (`{ code, at, by, supersededBy }`, once expired, R4a), `halted`
  (`{ code, at }` or null), `policyVersion`, `inventoryVersion`, `expected`
  (store keys), `acked` (store key → outcome), `ackDeadlineAt`, `alertedAt`, `completedAt`.
- `matter_tombstones/{matterId}`: `firmId`, `matterId`, `requestId`, `classification`, `tombstonedAt`, `requestedBy`,
  `approvedBy`, `membersRevoked`, `policyVersion`, `purgeCompletedAt`.
- `deletion_acks/{requestId}_{storeKey}`: `firmId`, `requestId`, `matterId`, `storeId`, `outcome`, `count`,
  `idsSha256`, `detail` (codes and numbers only), `jobId`, `at`.
- `legal_holds/{matterId}`: `firmId`, `matterId`, `active`, `reasonCode`, `placedBy`, `placedAt`, `releasedBy`,
  `releasedAt`.
- `deletion_external_requests/{requestId}_opik`: `firmId`, `requestId`, `matterId`, `processor`, `count`, `parts`,
  `idsSha256`, `status: "pending_operator"`, `at`; and `{requestId}_opik_p{n}`: `firmId`, `requestId`, `matterId`,
  `processor`, `part`, `of`, `traceIds` (at most 5,000), `at` (R7b).
- `vault_object_tombstones/{sha256(storagePath)}`: `firmId`, `requestId`, `documentId`, `storagePath`,
  `lockUntil`, `at`.
- `retention_runs/{firmId}_{period}`: `firmId`, `period`, `policyVersion`, `deleted` (store key → count), `skippedHeld`.

## 5. Routes (Functions `api`, `/api/platform/retention/*`)

| Route | Method | Action | Result |
| --- | --- | --- | --- |
| `requestMatterDeletion` `{ matterId, reasonCode }` | POST | `retention.request_deletion` | `{ requestId, status, refusal? }` |
| `approveMatterDeletion` `{ requestId }` | POST | `retention.approve_deletion` | `{ requestId, status, refusal?, jobId? }` |
| `getDeletionRequest` `?requestId=` | GET | `retention.read` | the request with its acknowledgements |
| `placeLegalHold` `{ matterId, reasonCode }` | POST | `retention.hold.place` | the hold |
| `releaseLegalHold` `{ matterId }` | POST | `retention.hold.release` | the hold |

`reasonCode` is one of the policy's closed lists (`deletion.reasonCodes`, `legalHold.reasonCodes`; R25), never free
text, so no content enters the trail. (The first build accepted any `^[a-z][a-z0-9_]{2,63}$` code, which let a name in
as snake case: FA-F42-R1-005.)

## 6. Deploy

- `retentionApplyTick` (schedule `0 1 * * *`, Asia/Karachi) and `retentionDeletionWatch` (every 15 minutes) in
  `functions/src/index.ts` and `infra/deploy-manifest.json`; the G-2 suite lists both as non-tenant exports.
- No alert policy of its own: the unacknowledged-deletion alert is an F43 durable alert (R10), delivered through F43's
  pages and policies. Terraform regenerated by `infra/render_terraform.py`.
- Indexes: `deletion_requests (status, alertedAt, ackDeadlineAt)` for the watch; `(firmId, <ageField>)` for each store with an
  `ageField`.

## 7. Tests (RED on main, GREEN on the branch)

- `functions/test/f42-retention-deletion.e2e.emu.test.ts` (Auth + Firestore emulators, the real HTTP router, the
  real P2 worker through the in-process dispatcher): the saga purges every inventoried matter store and records every
  acknowledgement; reads refuse at once through the Functions routes and the F02 authority gate; the default policy
  refuses (legal hold) and deletes nothing; a matter hold blocks and records the refusal; a hold placed mid-saga halts
  it; a crash mid-saga resumes idempotently; the same partner cannot approve; a non-partner cannot request; the trail
  holds no content; the tombstone alone (memberships intact) refuses reads, lists and the matter's queued P2 job; a
  row that lands after its store's purge is purged before the acknowledgement; F34 decision records of the matter are
  anonymised and acknowledged, and the Opik request lists their exported and pending traces (not the abandoned one).
  Codex P2 follow-up: a request whose window lapsed no longer blocks a new one, which still needs a second partner, and
  an approval attempt on it records the expiry (R4a); a purge job that passes its budget after finishing a store
  acknowledges it and its continuation finishes the rest (one document, 9,000 versions); a job retried after a crash
  late in its budget hands over instead of passing the step limit (10,000 versions, R7c); 10,001 exported traces are
  all recorded in bounded parts before any usage row is anonymised (R7b).
- `functions/test/f42-retention-apply.e2e.emu.test.ts`: the default policy deletes nothing; a test policy deletes
  old rows and keeps held ones; the watch raises one F43 durable alert per late request (one page, no matter id, no
  second raise); a request that falls overdue behind a full page of
  already-alerted ones is still alerted; an old F34 decision record is anonymised by its `settledAt`, a young one kept.
- `tests/f42-tombstone-next.e2e.firestore.test.ts`: the Next routes through the production authority path refuse or
  omit the tombstoned matter; a revoked member no longer finds the matter in search; the repositories return null.
- `ci_gates/test_check_data_inventory.py`: an uninventoried collection, object prefix or table fails; a stale entry
  fails; a pending entry passes absent and present; malformed entries fail; the real tree passes.
- `functions/test/f42-retention.units.test.ts`: the policy, inventory, store-key (shared with the Python gate) and
  acknowledgement logic; continuation part naming and the trace id parts.
- Mutation: `functions/test/f42-mutants.json` (39 mutants over the tombstone check, acknowledgement completeness, legal
  hold, authorisation, the inventory gate, the purge hand-over, the Opik parts and request expiry), run by
  `functions/scripts/f42-mutants.mjs` after a passing baseline.
- Neighbour lists updated for the new routes and exports: the F09 effect-marker guard registers
  `functions/src/retention/ops.ts`, whose four `once` POST routes pass its static check with no write outside their
  transactions; the G-0 end-to-end tree carries the files that name the inventoried stores and the new runbook.

## 8. Consumer impact

- New 403 `matter_deleted` from every matter-level route for a tombstoned matter; tombstoned matters vanish from
  lists.
- The reporting route no longer shows a non-member the matter rows of the firm (R-2 alignment). A partner who relied
  on seeing every matter there must be a member.
- New engine error `matter_deleted` on P2 jobs of a tombstoned matter (dead letter).
- Next Firestore reads in Admin mode cost one extra document read per `getById` of a matter-keyed row, and one per
  distinct matter on a list page that has matter-keyed rows (parallel reads through the modular `getDoc` helper).

## 9. Stress test

**Steelman of the opposing view (do not delete anything until the firm rules).** The architecture says "nothing is
deleted" in several places, the vault is locked for seven years, and a deletion mechanism invites misuse. Answer: the
default policy deletes nothing and refuses every deletion by legal hold; the mechanism exists so that when the firm
does decide, the deletion is complete, provable and two-person controlled, instead of an operator's ad hoc script that
misses copies. Revocation and read refusal are needed regardless.

**Devil's advocate against this design.**

- *The tombstone check adds a read to every permission check.* True: one document read per matter-level decision
  (read in parallel with the matter in Functions). Accepted for correctness; measured cost is NOT DEMONSTRATED.
- *A write already past its permission check can land after its store is acknowledged.* The approval's membership
  revocation stops writers that re-check membership in their transaction (D4, the Next repositories); the purge's
  final re-query catches anything that lands before the acknowledgement. A write that lands after the acknowledgement
  is a residual (RES-2).
- *The legacy collections (about 180) make the saga long.* They are queried once each, 12 per job; an empty store costs
  one query and one acknowledgement.
- *Client-SDK reads that do not depend on membership* (a client's own matter row, the accounts role's intimation
  register, a user's own notifications, the routing queue, a partner's registry rows, a legacy committee output with
  no matter) refuse the tombstoned matter at once in `firestore.rules` (R23, correcting RES-1: the matter row is
  anonymised, never purged, so that read did not end with the saga). The search index is membership-gated
  (`memberReader`), so the approval's revocation ends it.
- *Retaining the conflict register keeps party names of a deleted matter.* Deliberate (R8), and flagged for
  ratification.

**Bias check.** Untested premises: that Opik exposes a deletion endpoint (not verified, NOT DEMONSTRATED); that an R2
lifecycle rule can honour per-object holds (NOT DEMONSTRATED); that Firestore TTL deletes within about a day of expiry
(documentation, **[REQUIRES VERIFICATION]**).

## 10. Residuals and follow-ups

- RES-1 (corrected by R23, FA-F42-R1-003): the claim that these reads "end when the saga purges them" was wrong for
  the client's own matter row, which is anonymised and kept. Every client-SDK read path that does not depend on
  membership now carries a tombstone clause and refuses at once; the membership-gated ones end at the approval's
  revocation. Nothing of RES-1 remains open.
- RES-2 (corrected by R27, FA-F42-R1-007): a usage row or decision record of a P1 call in flight at the approval is
  no longer lost. Written before its store is acknowledged, the purge finds it, and the anonymise chunk records any
  trace id not yet in the Opik request in a new part in the same transaction. Written after (the call settles or the
  reconciler settles it after the request finished), the P1 write seam (`stage`) reads the tombstone, writes the row
  without the matter and records its trace in the request. A committee output published after the tombstone is
  refused at its write (`matter_deleted`). What remains: a write by a P2 job already running at the approval that lands
  after its store's acknowledgement (the worker refuses the job's next run, not a step already in flight), and Next
  or D1 writers that do not re-check membership in their own transaction. Both are bounded by the job budget or the
  request; neither is demonstrated here.
- RES-3: vault objects stay until their COMPLIANCE lock ends (up to 2555 days); the lifecycle executor is not built.
- RES-4: the Opik deletion is a recorded request, not a call.
- RES-5: deleted rows live on in backups until the backup retention window ends.
- FU-1: client-record erasure. FU-2: ratification of `infra/retention/policy.json`. FU-3 (route the alert through
  F43) is done (R10). FU-4: the R2 lifecycle executor for `vault_object_tombstones`. FU-5: the Opik
  deletion call once its API is verified. FU-6: a partner-only cancel of a pending request, if the firm wants early
  withdrawal (ruled unnecessary, R4a).
- FU-7 (R26): the platform operator's countersignature for a firm with no independent second partner (not built).
- FU-8 (R31): periodic retention aged from the matter's closure, for the matter classes (not built; until then the
  config refuses any deleting period on a matter class).

## 11. R1 follow-up: the independent re-audit at 301e65d (FAIL 5/10)

Branch `claude/remediate-f42-fu`, from main 5840d3d (the squash of #128). Findings FA-F42-R1-001 to R1-015 (issue #30).
What held and must not regress: the tombstone choke points in both stacks, the saga fence, crash-resume, the
continuation, the expiry races, G-2. Every period and every legal basis stays PROPOSED; no statute or rule is cited
as authority; anything legal is **[REQUIRES VERIFICATION]**.

**R21. A stored answer is not replayed for a deleted matter (R1-001).** An idempotent replay used to return the stored
`{status, body}` before any authority or tombstone check, so a same-key retry of a `createDraft` (Functions) or a
compose (Next) answered after the approval returned the deleted matter's draft, title included. Now each operation
records the matters it touched, and a replay of any stored answer (2xx or a stored refusal) reads their tombstones
first and refuses `403 matter_deleted`, exactly as a fresh call does; nothing about the record is changed (it expires
under its TTL).

- *Which matters.* (a) Every matter a permission check of the request named: Functions `evaluate`
  (`functions/src/p5/permission.ts`) and Next `checkPermission` (`platform/p5/checkPermission.ts`) note the matter id in
  the request's recording scope (`platform/retention/operationMatters.ts`, an AsyncLocalStorage chain, so a Next core
  served inside the Functions F02 frame records into both the inner and the outer operation). (b) Every string
  `matterId` / `linkedMatterId` in the stored body (depth 8, 50 ids), which covers an operation that creates its
  matter (`openMatter`, whose check names no matter yet) and records stored before this change. Both lists are stored
  on the record as `matterIds` (at most 50; more is `matterIdsTruncated: true`, and such a record never replays: 409
  `idempotency_replay_unavailable`, fail closed).
- *Audit.* The Functions router audits a refused replay (`matter_deleted`, `idempotency_replay_unavailable`) as a deny
  row, as it audits every other idempotency refusal; the row names the action, actor and firm, never the matter's
  content. A Next route in production runs inside the F02 frame, whose Functions claim refuses (and audits) first. The
  Next core's own durable store, reached only without the frame (local insecure-dev), audits none of its idempotency
  refusals, and this one follows that rule.
- *Where.* Functions `withIdempotency` (every Functions route, the nine F02 POST routes included) and the Next durable
  store (`DurableIdempotencyStore.begin`, every Next route that calls `beginIdempotentRequest`). The Next memory mode
  has no tombstones (R15).
- *Routes that store replays of matter-scoped operations.* Functions: `createDraft`, `saveDraftVersion`,
  `restoreDraftVersion`, `overrideGate`, `approveDraft`, `gateDraft`, `openMatter`, `advanceStage`, `closeMatter`,
  `committeeBrain` (resume), `retryFailedJob`, `cancelJob`, and the nine F02 POSTs (`/api/d1/matters`,
  `/api/d1/documents`, `/api/d1/document-workflow`, `/api/d1/reporting`, `/api/d2/court-ops`, `/api/d2/ops-reporting`,
  `/api/d4/drafts`, `/api/d4/filings`, `/api/p5/tenancy`). Next: the same nine routes plus `/api/d1/clients`,
  `/api/p1/committee-brain` and `/api/g0/normalise` (their matter-scoped answers). The retention routes are firm
  administration about the deletion itself and stay replayable (they name no matter in a permission check).
- *Rejected alternative.* Deleting the matter's idempotency records in the approval transaction: the records carried no
  matter, and their number within the 24 h window is unbounded, past a transaction's 500 writes.

**R22. Legacy committee outputs are purged by their documents (R1-002).** Rows written before `matterId` was required
carry only `documentIds`. In the first purge group, before any document row is deleted, the saga lists the matter's
document ids (pages of 300) and deletes, in fenced chunks, every `committee_outputs` row of the firm whose
`documentIds` array-contains-any of a batch of 30 of them (Firestore's limit) and whose `matterId` is null or absent.
They count on the `committee_outputs` progress, so its acknowledgement's count and hash include them. Only when the
plan purges `committee_outputs`. The Next GET drops a legacy row (no `matterId`) unless every one of its documents
still reads through the repository (which drops a tombstoned matter's documents); the rules do the same for at most
three documents (each exists, is of the row's firm, and its matter has no tombstone), and deny a legacy row naming more.

**R23. The rules refuse a tombstoned matter wherever they do not use membership (R1-003).** `notDeleted(m)` is
`!exists(/databases/$(database)/documents/matter_tombstones/$(m))`. The audit of every block (257 match blocks; the
shapes are in the plan) found these clauses that admit a reader without membership on a matter-keyed row, and each now
carries it: `matters` (the client-role own-matter read), `intimation_register` (the accounts role), `notifications`
(read and the read-receipt update, when the row names a matter), `routing_queue` (staff), `matter_parties` and
`conflict_checks` (the partner branch, when the row names a matter), `matterScoped` (the membership branch, used by
`committee_outputs`, `workflow_ops_activity`, `workflow_ops_alert_digests`, `filing_escalation_policy_baselines`) and
the legacy `committee_outputs` branch (R22). Every other clause on a matter-keyed store requires membership
(`isMember`, `memberReader`, `canAccessScope` with a matter), which the approval revokes in its own transaction; they
are not given a second check, which would cost an access call on every read for no case it closes. Cost: one more
access call (one billed read) on each changed clause.

**R24. A hold stops every remaining destructive step, instructions to third parties included (R1-004, the auditor's
ruling, adopted).** `assertNoHold` runs inside every fenced step of the prepare job (static acknowledgements, the
processor request, the enqueue), as it already did in the purge job. A hold found by either job halts the saga: the
request records `halted`, and in the same step every processor request of the request that is `pending_operator` moves
to `held`. Placing a hold moves them too, in the hold's own transaction (a hold placed after the saga finished still
stops the operator). Releasing the hold returns them to `pending_operator` and clears `halted`; a partner then retries
the dead-lettered saga job (P3-12), which resumes after its last committed step. The runbook tells the operator to
check `halted` and `legal_holds/{matterId}` before acting on any `deletion_external_requests` row.

**R25. No content can enter the deletion trail (R1-005).** Reason codes are a closed list in the policy
(`deletion.reasonCodes` for a request, `legalHold.reasonCodes` for a hold, PROPOSED), validated in the code and in the
gate; the regex is gone. A vault tombstone keeps a storage path only when it is the vault's own shape for the row:
`fs://` or `s3://`, the row's firm, `documents`, the row's document id (the row's id for `documents`, its `documentId`
otherwise) and `v<n>`. Any other path is not copied: the tombstone keeps its SHA-256 (the document id) and
`pathShape: "refused"`, and the vault acknowledgement counts it (`detail.refusedPaths`); the lifecycle executor (FU-4)
matches objects by that hash.

**R26. The two partners must be independent of each other (R1-006).** Besides being another partner of the firm,
the approver must not have been created by the requester (`users/{uid}.createdBy`, now written by `createFirmUser`)
nor made partner by the requester (`partnerGrantedBy` with `partnerSince`, written by `setUserClaims` when a role
becomes partner and by `createFirmUser` for a partner account, and removed when the role is left). The same holds the
other way round: the requester must not have been created or made partner by the approver, else a sole partner's
puppet files the request for its creator to approve (the reverse of the auditor's FP7). The approver's account and
partner role must predate the request and be at least N days old at the approval; the requester's must be N days old
at the request: N = `deletion.approverMinTenureDays`, PROPOSED 30. A partner whose start is unknown (no
`partnerSince`) is judged by `createdAt` when their claims were never changed, else by the last claims change
(`updatedAt`): later, so stricter. Refusals, each `403` with its own code and recorded as a deny audit row:
`approver_created_by_requester`, `approver_promoted_by_requester`, `requester_created_by_approver`,
`requester_promoted_by_approver`, `approver_tenure_too_short`, `approver_tenure_unknown`,
`requester_tenure_too_short`, `requester_tenure_unknown` (no readable start, fail closed); a request with no readable
time or requester is `409 request_invalid`. Ruling on a sole-partner firm: no rule inside a firm whose every account
one person provisions can prove two people; a firm with no independent second partner cannot delete through this saga
(its requests expire). The honest path is a platform operator's countersignature through the P5 platform-admin path,
recorded as FU-7 and not built here. Cost of the two-way rule: in a two-partner firm where one partner provisioned the
other's account, neither can delete through the saga, since the store cannot tell that second partner from a puppet;
such a firm waits for FU-7 (or a third partner neither provisioned). Steelman against: a new real partner must wait 30
days to co-sign; accepted for an irreversible act. Devil's advocate: a patient sole partner who creates an account
through a second creator (P makes X, X makes Y) and waits 30 days still passes; this is the residual FU-7 closes, and
the request, approval and audit rows name both partners for review.

**R27. In-flight traces are recorded (R1-007, RES-2).** (a) The anonymise or purge chunk of a trace source
(`ai_usage_logs`, `p1_decisions`), when the plan requests the processor, reads the processor request in its
transaction, finds the chunk's exported ids not yet in any part, and records them in a new part `{requestId}_opik_p{n}`
(the summary's `parts`, `count` and `lateIds` move with it) before the rows lose the matter. Existing parts are written
once, so a job caches them between chunks. (b) A row that lands after its store's acknowledgement goes through the
P1 write seam (`stage` in `functions/src/p1/gateway.ts`, shared by the call's commit and the lease reconciler): it
reads the matter's tombstone, and when the tombstone's request is in progress or completed and that store is already
acknowledged as anonymised or purged, writes the usage row and decision record with `matterId: null` and
`anonymisedBy`, and records the exported trace id in the processor request (creating it if prepare found none). An
active hold leaves the row as it is (preserve). Chosen over a sweeper: the seam has no window, costs one read per P1
commit that names a matter, and needs no scan of past tombstones. (c) The committee output's publication reads the
tombstone and refuses `403 matter_deleted`.

**R28. The inventory scanner (R1-008).** The static scan now reads every source file of the tree (`.ts`, `.tsx`,
`.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.sql`) outside tests, build output, docs and the gates, so
`components/` and scripts are covered. A collection argument is resolved: a string or template literal, a constant of
any name (the file's own, or an exported one), a `+` concatenation of those; a template with interpolation or an
unresolved part is a dynamic name, and its static prefix must begin an inventoried collection or the gate fails.
Calls recognised: `.collection(`, `.collectionGroup(`, Python's `.collection(` and `.collection_group(`, modular
`collection(h, …)`, `collectionGroup(h, …)`, `doc(h, …)` with any handle (`this.db` included), and helper calls
`(db, …)`. Names may be camelCase. Rules: every collection segment of a nested `match` path. Object prefixes: any
expression naming a firm id (`${input.firmId}/seg/`, `firmId + "/seg/"`). SQL: `CREATE [TEMP|TEMPORARY|UNLOGGED]
TABLE`, views, `SELECT … INTO` at top level, in any `.sql` file or a string of a `.py`/`.ts` file; a relation outside
the `public` schema keeps its schema (`client_private.judgment` is not `judgment`). A server-only collection no longer
depends on a rules block: the gate fails when an inventoried collection is found only through `firestore.rules`
while its block is server-only (`allow read, write: if false`), since a server-only store must be visible in code.
And a run-time check backs the static one: after the Functions emulator suite in CI, `--runtime` lists the emulator's
root collections and fails on any that is not inventoried (a short, named list of test-only fixture collections
excepted). Every one of the auditor's 33 plant shapes is a must-fail fixture.

**R29. A deleted matter's jobs are hidden (R1-009).** `getJob`, `listJobs` (both the matter list and the firm queue)
and the retry/cancel reads read the matter's tombstone with the matter; a job of a tombstoned matter has visibility
`none`.

**R30. Committee scope trusts the repository (R1-010).** In Firestore mode, a null from the matter repository evicts the
cached matter and the scope answers 404 `unknown matter` (as FA-F13-039 does for documents); memory mode keeps the
cache, which is its store.

**R31. Periodic retention cannot be ratified incoherently (R1-011).** Each class carries `periodBasis`: `row_age` (a
row ages from its own `ageField`) or `matter_closure` (Module 9 frames retention for closed matters, which ages from
the matter's closure). Config validation (Functions and the gate) refuses a class with a deleting `periodicAction` when
its basis is `matter_closure` (not built: FU-8) or when any of its matter-keyed Firestore stores has no `ageField`. The
matter classes are `matter_closure`; `ai_record` is `row_age` (spend rows, aged by their own time). The shipped policy
has no period, so it still deletes nothing.

**R32. CI cost (R1-013).** The chunk size, the chunk-step budget, the part size and the part ceiling are read through
`retentionTestSeam.limits` outside production, so the continuation, retry and many-traces cases run on about 100
rows instead of 8,801 to 10,001; one unit test pins the production values and exercises the boundaries with them. The
workflow comment is corrected: PR #128 added about six minutes to the Functions test step (22m49s on 798cf56, 28m56s
at 301e65d).

**R33. Mutants (R1-012).** Tests kill the auditor's survivors R07, R08, R09, R14, R16 and R21; R21 is a parity test that
runs the TypeScript and Python store keys over every inventoried id and a set of long and odd ids.

**R34. Backup restore (R1-014).** The runbook gains a restore step: export the deletion trail before restoring, then
re-apply every tombstone and re-run every approved request against the restored data. Not drilled (NOT DEMONSTRATED).

**R35. The e2e tests clean up everything they create (R1-015).**
