# FA-D4-001-FU1: firm-qualified court-ops acknowledgements (design)

Date: 2026-10-24. Branch: `claude/remediate-fa-d4-001-fu1` from `origin/main` 6b186a0. Severity: MEDIUM (issue #30,
reproduced by the FA-D4-001 re-audit at 333c1b7 and b83c5ac).

Written in autonomous mode under the owner's standing instruction. Every ruling below is mine, with its reason.

## 1. Finding (observed, not assumed)

`POST /api/d2/court-ops {action: "acknowledge_item", queueType, id}` writes
`workflow_ops_activity/ops:court_ops:ack:${queueType}:${id}` (app/api/d2/court-ops/route.ts, about line 261) with a
blind `setDoc`. Both parts of the id come from the request body. Nothing checks the firm, the queue type, the
characters in the id, or whether the item exists.

Reproduced on main 6b186a0 through the real route (Auth and Firestore emulators, `SIKANDER_PERSISTENCE_MODE=firestore`,
emulator ID tokens, F02 dispatch). The auditor's FU1 and FU1b cases were copied unchanged into a probe file in a
detached main worktree. Log: `scratchpad/fu1/logs/probe-main-fu1.log`. After the merge of main 798cf56 the same cases
were run again, unchanged, on 798cf56, with the same result (`scratchpad/fu1/logs/r2/probe-auditor-fu1-main-798cf56.log`).

- **FU1.** Firm B acknowledges `{queueType: "workflow", id: X}` and gets 200. The row holds firm B. Firm A sends the same
  id and gets 200. The row now holds firm A, A's actor and A's text: B's row is gone.
- **FU1b.**
  - An id `p…/sub/d…` gets 200 and writes a nested document under a sub-collection that no rule matches.
  - `queueType: "zz…"` gets 200 and is stored as given.
- The item id `audit-item-…` names no item at all, and still gets 200: nothing resolves the item.

## 2. Orient: what the code actually does

- **The ack writes only one domain document.** `acknowledgeCourtOpsItem` (services/d2-2/courtOps.ts) checks the role
  and pushes an in-memory `court_ops_acknowledge` audit row. The `workflow_ops_activity` row is the only durable domain
  write. The audit row reaches `audit_log` through the F11 outbox, or through the end-of-request flush.
- **The Functions path has no writer of its own.** `functions/src/http/f02NextAuthority.ts` registers
  `POST /api/d2/court-ops` as an F02 authority route. Its operation calls the Next core in process (`invokeF02Core`).
  In `functions/src`, `grep court_ops|workflow_ops_activity|acknowledge_item` finds no writer. So there is no Functions
  twin to fix: one fix in the Next core covers both the direct path and the Functions path.
- **The write fence (F10/F11).** Inside an idempotent request with a durable claim, every write through
  `firestoreDbModular` (`setDoc`, `runTransaction`) commits in ONE transaction. That transaction reads the claim, creates
  the effect marker and stages the request's audit-outbox entry. A repository transaction is the same transaction.
- **The request audit is flushed whatever the outcome.** On main, `acknowledgeCourtOpsItem` pushes its audit row BEFORE
  the activity write. So a failed write (for example `ABORTED`) still flushes an "acknowledged" audit row while the
  caller gets 400. That is the FA-D4-001-R1-002 shape: one record of the act says it happened, the other does not.
- **Item ids.**
  - Follow-ups are `fu_<uuid>` (`store.id("fu")`).
  - Workflow items are keyed by their document id.
  - Neither ever contains `:` or `/`.
- **Rules.** `workflow_ops_activity` already gives a firm-scoped read (`sameFirm`, `cleared`, staff roles,
  `matterScoped`) and `allow write: if false`.

## 3. Rulings

**R1. No Functions twin.** As §2 shows, the F02 Functions route calls the Next core. The fix lives in the Next core and
its repositories. The e2e drives the real `POST` with a bearer in Firestore mode, so the request goes through
`withF02Authority`, then `dispatchF02`, then the Functions router, then the core. It asserts the
`x-authority-path: functions` header to prove that path.

**R2. Queue allowlist.** `queueType` must be exactly `follow_up` or `workflow`. Anything else answers 400
`court_ops_queue_type_invalid` before any read or write.

**R3. Item id.** The id must be a string of 1 to 256 UTF-8 bytes containing no `:` and no `/`. Anything else answers
400 `court_ops_item_id_invalid` before any read or write.
- `:` would make the composite id ambiguous, and `/` would make it a sub-path.
- 256 bytes is over six times the longest real id: `doc_<uuid>` is 40 characters and `fu_<uuid>` 39 (both from
  `SpineStore.id`). The composite id stays far below Firestore's 1,500-byte limit. (Corrected on 2026-10-25: this line
  first said "ten times the longest real id (39 characters)", which missed the 40-character document ids.)
- `reason`, when present, must be a string (400 `court_ops_reason_invalid`). A non-string reason would otherwise be
  stored as a non-string `detail`.

**R4. Item resolution: 404, nothing written.** The item must exist in the caller's firm and be visible to the caller
under the queue's own rules. Otherwise the answer is 404 `court_ops_item_not_found`, and no row and no audit row is
written.
- A follow-up must be the caller firm's, and the caller must pass the matter permission check.
- A workflow item must be the caller firm's. When it is matter-bound, the caller must pass the matter check. The caller
  must also be able to read its document (`canReadDocument`), which is the same filter the queue listing uses.
- One answer covers absent, another firm's and not visible, so the endpoint is not an existence oracle across firms.
- The brief allows a choice for "A acknowledges B's item id": answer 404, or write only A's own row. **Ruling: 404, and
  nothing written.** A's own row about B's item would record an act on an item A cannot see.
- Status is not checked. An item a colleague resolved a moment earlier can still be acknowledged, so the race does not
  produce a confusing 404. The firm and the visibility checks are the security boundary; the status is not.

**R5. Firm-qualified id.** The id is `ops:court_ops:ack:${firmId}:${queueType}:${itemId}`, the auditor's form. The firm
part must be the caller's own firm id exactly: non-empty, not padded, and free of `:` and `/`.

**R6. One transactional, firm-checked writer.** `workflowOpsActivity.recordCourtOpsAcknowledgement(firmId, row)` is the
only writer of ack rows. In one transaction it reads the row at the firm-qualified id.
- A stored row stamped with another firm: refused, 409 `court_ops_ack_refused`, reason `foreign_firm`.
- A stored row that is not a canonical ack row: refused, 409, reason `malformed`.
- Otherwise it writes the new row.
- The new row must itself validate, or the writer throws. It never stores a non-canonical row.
- Within one firm, the latest acknowledgement of an item replaces that firm's previous one, as on main. The record of
  every acknowledgement is `audit_log`: one `court_ops_acknowledge` row per acknowledgement.
- `upsert` refuses any id under `ops:court_ops:ack:`, so no blind writer of ack rows remains.
- The memory repository reads, decides and writes with no `await` in between, as the FA-D4-001 memory writer does.

**R7. One commit, no misleading answer (the FA-D4-001-R1-002 lesson).**
- The writer's transaction is the fenced request transaction. Claim check, effect marker, activity row and outbox entry
  commit together or not at all.
- The `court_ops_acknowledge` audit row is pushed only AFTER that commit. A failed write leaves no "acknowledged" audit
  row, which changes main's order.
- A writer failure that is not a refusal (for example `ABORTED: Transaction lock timeout` after the Admin SDK's own
  bounded retry) answers 503 `court_ops_ack_unavailable`. Nothing committed, the claim is released, and a retry with
  the same key runs again.
- If a commit landed but its answer was lost, F10 already turns the 5xx into 409 `idempotency_effect_committed` with
  the operation id.
- No second retry loop. The SDK re-runs the whole fenced transaction (default 5 attempts); a loop around it would only
  multiply that bound.

**R8. A refusal is logged.** A 409 refusal logs one `console.error("[court-ops] acknowledgement refused", {ackId, reason})`
line, with ids only. A foreign or malformed row at a firm's own id is evidence that someone planted a row (§4, attack
A3) or that a legacy write collided with it. A durable F43 alert is a follow-up, not part of this change.

**R9. Rules: firm-scoped get bound to the id; list unchanged; no client writes.**
- `allow get` adds one condition for ids under `ops:court_ops:ack:`. The id must equal
  `'ops:court_ops:ack:' + firmId + ':' + queueType + ':' + itemId`, built from the row's own fields. `itemId` is
  `documentId` for `workflow` and `followUpId` for `follow_up`.
- So a legacy or mismatched ack row cannot be read by get. Other ids keep the existing condition.
- `allow list` keeps the existing condition: `sameFirm`, `cleared`, staff, `matterScoped`.
- `allow write: if false` stays.
- The static guard `tests/firestore.rules.matter-scope-coverage.test.ts` read only `allow read`. It now checks every
  `allow read|get|list` condition of a block. Otherwise splitting `read` would make it silently read the next block.

**R10. FA-D4-001-R1-003 (list shows legacy rows) does not transfer here.** In draft analytics, one legacy document
mixed several firms' counts. A legacy ack row is one complete write by one firm, because `setDoc` replaces the whole
document. A list therefore shows the caller firm only its own data. No version gate is needed.

**R11. Server reads follow the rules.** For ids under the ack prefix, the repositories' `get` and `listByFirm` return
only canonical ack rows. Legacy, mismatched and malformed ack rows are left out until the backfill moves them. Other
`workflow_ops_activity` rows (workflow events, follow-up resolutions) are unchanged.

**R12. Backfill** `npm run backfill:court-ops-acks`, on the F13-003 / FA-D4-001 pattern, with the R1-004 lessons. It is
a dry run by default; `--apply` writes. It reports ids only: paths and firm ids, never `detail`, actor or tags.

Each row ends up in one class:

| Class | Which rows | What the backfill does |
|---|---|---|
| `canonical` | Already at its firm-qualified id | Leaves it |
| `move` | A legacy id `ops:court_ops:ack:{queueType}:{itemId}` that matches its own content, with an allowlisted queue, a valid item id and firm id, and evidence that the item belongs to the stamped firm: `document_workflow/{itemId}` or `follow_ups/{itemId}` carrying that firm | Creates the target. If the firm acknowledged again after deploy, it keeps the later acknowledgement (by `createdAt`; a tie keeps the target). It deletes the legacy row in the same transaction |
| `needs_operator` | `item_not_in_firm`: the item is absent or is another firm's (a cross-firm write, or an acknowledgement of an unknown id) | Leaves it, reports it |
| `needs_operator` | `malformed`: an ack-prefixed row that is neither canonical nor consistent legacy (for example FU1b's arbitrary queue) | Leaves it, reports it |
| `needs_operator` | `nested`: a document under an ack-prefixed parent (FU1b's `/`) | Leaves it, reports it |
| `needs_operator` | `target_conflict`: the target is another firm's or malformed. Predicted in the dry run, and re-checked at apply | Leaves it, reports it |

Exit codes:

| Code | When | What it prints |
|---|---|---|
| 0 | Only when the run is clean | (nothing to act on) |
| 1 | A write failed, or a move was overtaken (legacy row changed or gone) | "rerun to retry" |
| 2 | At least one row needs an operator (dry run or apply) | "needs operator review", never "rerun to retry" |

- When both apply, 2 wins.
- The dry run already shows every rejection that can be known before apply. The plan holds every ack-prefixed row, the
  targets among them.
- Audit rows go to `audit_log` under `aud_court_ops_ack_backfill_{runId}…`, in batches, as in FA-D4-001.

**R13. FU1b nested documents.**
- The route refuses `/`, so no new nested document can be written.
- The backfill finds existing ones. It walks only ack-prefixed parents through `listDocuments()` and `listCollections()`,
  and reports them.
- It never deletes one: they are evidence, and the operator decides.
- The rules match no nested path, so clients cannot read them. The server never builds such an id after this change.

**R14. Scan of other ids built from request data (scope item 4; no fix widened).** grep over `app/api/**` and
`functions/src/**`:
- `id: \`…${parsed.…}\`` finds two ids.
  - The ack id, fixed here.
  - `int_${parsed.matterId}_engagement` (matters `confirm_engagement`). This one is safe: `ensureMatterAccess` resolves
    the matter in the caller's firm first, and `confirmEngagement` writes it in a transaction keyed by a globally
    unique matter id.
- `*Id(parsed.…)` finds the filings closure-chain ids: 36 call sites, 18 for each of two helpers. Every one is followed,
  within 22 lines, by a `firmId !== actor.firmId` → 404 check on the row it looked up.
- `functions/src` composite ids are either firm-prefixed (`${firmId}_…` counters, name index, budgets) or derived from
  server ids with `tx.create` (events), so they cannot overwrite.
- Two broader passes on the branch head (any interpolated `id: \`…\`` in `app/api`, and any `doc(<request field>)`)
  add four sites, none unsafe:
  - `ops:court_ops:follow_up:${updated.id}` (court-ops `resolve_follow_up`). `resolveFollowUp` first checks the
    follow-up is the caller firm's and that the caller can access its matter, and `follow_ups/{id}` is one namespace,
    so two firms cannot share the id. The write is still a blind `upsert`; that is recorded, not changed here.
  - `functions/src/d4/drafts.ts` `matters().doc(input.matterId)`: a lookup, then `matter.firmId !== caller.firmId` →
    not found.
  - `functions/src/p1/ocrCall.ts` `p1_ocr_operations.doc(req.operationId)`: the id is the server's job id
    (`p2/ocrJob.ts`), and a stored row of another firm is refused (`operation_conflict`).
  - `functions/src/p1/corpusEmbedding.ts` takes `operationId` from the body of a service-only caller, but stores it only
    as the field `corpusOperationId`; the usage row has an auto id.
- The scan is a grep-level review. A data-flow proof across the 19,082-line filings route and the 32,900-line
  ops-reporting route is NOT DEMONSTRATED. (Corrected on 2026-10-25: this line first said 16k and 12k lines.)

**R15. Unchanged on purpose.**
- `matterId` stays `null` on ack rows, as on main. Stamping the item's matter would narrow reads to members. That
  changes what ops reporting shows, so it is a follow-up.
- The collection name `workflow_ops_activity` is unchanged, for F42's inventory (PR #128).
- No TTL field, trigger, queue or alert line is added, so `infra/deploy-manifest.json` is untouched.

## 4. Adversarial pass (steelman, devil's advocate)

- **A1, cross-firm overwrite (FU1).** A's acknowledgement of B's id is now 404 (R4). Even if resolution were bypassed,
  A's write would go to A's own id (R5). B's row is unreachable from A's request.
- **A2, sub-path and queue injection (FU1b).** Refused with 400 before any I/O (R2, R3).
- **A3, a planted row at another firm's future id.**
  - Main lets A write `queueType = <B's firm id>`, `id = "workflow:X"`. That lands on
    `ops:court_ops:ack:B:workflow:X`, stamped A: exactly B's canonical id.
  - After the fix, B's acknowledgement of X is refused (409 `foreign_firm`), never overwritten, and logged (R8).
  - The backfill reports the planted row as `malformed` and B's legacy move as `target_conflict`.
  - Steelman: this is a denial of service for B until an operator acts. Accepted, because overwriting would be worse:
    it would destroy evidence.
- **A4, the firm id containing `:`.** The id builder refuses it (R5), so a crafted firm id cannot collide.
- **A5, a transient abort.** Nothing commits and no audit row is written (R7). The answer is a 503 the caller may retry
  with the same key.
- **A6, the devil's advocate on R4 (no status check).** An operator can acknowledge a long-resolved item. That is
  harmless: it writes only the firm's own row about the firm's own item.
- **A7, the devil's advocate on R11 (legacy rows hidden from the server list).**
  - The ops-reporting activity view omits legacy ack rows between deploy and backfill.
  - Accepted, and recorded as a consumer impact. The alternative is serving rows the rules now refuse on get, which is
    worse.
  - Ack rows carry `matterId: null`, so the alert digests (which group by matter) do not change.

## 5. Tests (RED on main, GREEN on branch)

- **e2e** `tests/fa-d4-001-fu1-court-ops-acks.e2e.firestore.test.ts`. Real `POST /api/d2/court-ops`, production modes,
  emulator ID tokens, F02 dispatch. It covers:
  - B's row is untouched by A's same-id acknowledgement, and A gets 404;
  - each firm acknowledging its own item keeps its own row at its firm-qualified id;
  - `/`, `:`, an unknown `queueType` and a non-string reason answer 400 and write nothing, nested documents included;
  - an unknown id answers 404 and writes nothing;
  - concurrent acknowledgements give exactly one row per firm and item, and every answer is 200;
  - a planted foreign row at the caller's id answers 409, stays as it was, and leaves no audit row.
- **Rules** `tests/fa-d4-001-fu1-court-ops-acks.rules.firestore.test.ts`: get and list are firm-scoped, a legacy or
  mismatched ack row cannot be read by get, and no client can write.
- **Backfill** `tests/fa-d4-001-fu1-court-ops-acks-backfill.e2e.firestore.test.ts`: dry run, apply, idempotence, every
  class, and the exit codes.
- **Unit** `tests/fa-d4-001-fu1-court-ops-acks.unit.test.ts`: id builder and parser, validator, writer decision, plan
  and exit codes, and the R7 audit order on the memory path.
- **Neighbours**: court-ops API, F02 authority, F12/F13, rules suites, G-2.
- **Mutation**: at least 10 hand mutants across allowlist, item resolution, id format, transactional check, rules and
  backfill.
