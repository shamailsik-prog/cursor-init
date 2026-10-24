# FA-D4-001: firm-qualified template analytics (design)

Status: approved under the owner's standing autonomy instruction (CLAUDE.md, "Autonomy"); every ruling below is the
builder's own, with its reason. Branch `claude/remediate-fa-d4-001`, from `origin/main` at `3c8ccb9`.

## 1. Finding (verbatim, issue #30)

> **FA-D4-001 [MEDIUM, pre-existing]** Cross-firm overwrite through a shared document id.
>
> `draftTemplateAnalyticsId` is `template:${templateId}`, not qualified by firm. Firm B composes with template T, then
> firm A composes with T through `POST /api/d4/drafts`:
> - at #44's head, `draft_template_analytics/template:T` switches to firm A with composeCount 1, and B's row is destroyed;
> - on main, A's compose incremented B's row (composeCount 2, firmId still B).
>
> The template-search upsert on main already overwrites across firms.
>
> Fix: `template:${firmId}:${templateId}`, plus a migration of existing rows.

## 2. Observed facts at `3c8ccb9`

**The id.** `platform/persistence/draftTemplateAnalytics.ts:4-6` builds `template:${templateId}`. The template id is a
shared catalog id (`data/documentTypes.json`, 159 ids, all `[a-z0-9_]+`); `composeDraft` refuses any other id
(`services/d4-1/drafts.ts:302-303`). Every firm composing template T therefore addresses the same document.

**Writers** (both in `app/api/d4/drafts/route.ts`):

| Path | Lines | What it does |
|---|---|---|
| `POST action=compose` | 366-379 | `get(template:T, actor.firmId)`; when that returns null (no row, or another firm's row), builds a fresh row for the caller's firm; `upsert` = `setDoc` of the whole document. Not in a transaction. |
| `GET view=templates&actorId=&q=` (the template search) | 161-189 | `listByFirm(caller firm)`; for each template on the page builds the caller's row (fresh when the firm has none) and `upsert`s it with `templateSearchCount + 1`. Not in a transaction; writes from a snapshot read earlier. |

**Readers**: the compose `get` above; `listByFirm` in the template view (ranking and the `analytics` block of each item)
and in the drafts view (ranking by `composeCount`, line 228). Repositories: Firestore
(`firestoreSpineRepositories.ts:2332-2342`, `getById` / `listByFirm`, both F12 firm-scoped) and memory
(`spineRepositories.ts:3240-3250`). The runtime store keeps a write-through map (`store.draftTemplateAnalytics`).

**The template-search index** is not a separate collection: it is the `templateSearchCount`, `lastTemplateSearchAt` and
`lastTemplateSearchQuery` fields of the same `draft_template_analytics` row. A repository-wide search for
`template_search` / `templateSearch` finds no other store.

**Functions.** `functions/src/d4/**` writes `drafts`, `draft_versions`, `draft_gate_results`, `draft_gate_overrides` and
`events`; it never reads or writes `draft_template_analytics`. No Functions change is needed.

**Rules.** `firestore.rules:391`: `allow read: if sameFirm() && role() in ['partner','associate','clerk']; allow write: if false;`.
Reads are bound to the stored `firmId`, not to the id. No client code in this repo reads the collection (only the Next
server, through the Admin SDK).

**RED on main** (the new e2e, production mode, real routes; section 7): B's row disappears when A composes T
(`template:T` now stamped A) and when A searches T; six concurrent composes from two firms leave one shared row with
`composeCount: 2`; a compose increments a legacy row; nothing refuses a row stamped with another firm.

## 3. Survey: document ids built from a shared or tenant-supplied id without the firm

Method: a grep of `app/api`, `platform`, `services`, `lib` and `functions/src` for template-literal ids
(`id: \`...${}\``, `return \`prefix:${}\``) and for `.doc(...)` built from a variable, then reading where each variable
comes from. It is a source survey, not a proof that no other case exists.

| Collection / id | Variable part comes from | Firm in id | Verdict |
|---|---|---|---|
| `draft_template_analytics` `template:${templateId}` | the shared template catalog | no | **In this finding's family. Fixed here.** |
| `workflow_ops_activity` `ops:court_ops:ack:${queueType}:${id}` (`app/api/d2/court-ops/route.ts:261`) | the request body `id`; `acknowledgeCourtOpsItem` (`services/d2-2/courtOps.ts:102-119`) only appends an audit row and never checks the item exists in the caller's firm; the repository write is a blind `setDoc` | no | **Follow-up FA-D4-001-FU1** (not fixed here): firm A acknowledging an item id firm B also acknowledged overwrites B's activity row with A's. Fix shape: firm-qualify the id and/or check the item in the caller's firm, and write through a firm-checked transaction. |
| `workflow_ops_activity` `ops:court_ops:follow_up:${id}` | a follow-up checked to be the caller's firm (`resolveFollowUp`), a UUID | no | safe (firm-owned UUID) |
| `matter_client_search_index` `matter:${matter.id}`, `client:${entity.id}` | server-generated UUIDs of firm-owned rows; transactional write with a validator (FA-F13-004) | no | safe (not shared, not tenant-chosen) |
| `matter_report_export_analytics`, `matter_report_relevance_snapshots` (`reportExportAnalyticsId(matter.id)`) | a matter UUID resolved in the caller's firm | no | safe |
| filing collections (`packet:`, `digest:`, `exception:`, `receipt:`, `annexure:`, `rota:`, `closure-*:` ... `${packageId}` / derived ids) | `store.id()` UUIDs of firm-owned packages and their children | no | safe |
| `intimations` `int_${matterId}_engagement` | a matter UUID resolved in the caller's firm | no | safe |
| `idempotency_keys` / `idempotency_effects` (Next `durableDocId(firm, user, route, key)`, Functions `idempotencyDocId(firm, key)`) | the client's Idempotency-Key | **yes** | safe |
| `counters`, `ai_usage_months`, `ai_budget_alerts`, conflict name index, `entity_links`, `events` `${firmId}_...` | firm id first | **yes** | safe |
| `events` (Functions D4) `${draftId}_${version}_${suffix}`, other `events` `${generatedId}_...` | generated ids | no | safe |
| `matter_members` `${matterId}_${userId}` | matter UUID and Auth uid | no | safe |
| `rate_limits` `${uid}_...`, `ip:${ip}_anon_...` | global identities, no tenant rows | n/a | safe |
| `audit_outbox` `${requestId}_${seq}` | `randomUUID()` per request | no | safe |

## 4. Rulings

**R1. Id format.** `template:${firmId}:${templateId}`, built only by `draftTemplateAnalyticsId(firmId, templateId)`. The
firm goes through the F12 `requireCallerFirmId` (non-empty, trimmed); both parts must be non-empty and contain neither
`:` nor `/`, or the builder throws `DraftTemplateAnalyticsIdError`. Reason: `:` would make the id ambiguous (firm `a:b`
with template `c` equals firm `a` with template `b:c`), which reopens a cross-firm collision; `/` would address a
sub-collection. No real id is refused: catalog ids are `[a-z0-9_]+` and firm ids are Firestore auto-ids.
Devil's advocate: percent-encoding the parts would never refuse anything. Rejected: the rules compare the id literally
(R9) and cannot decode; refusing is fail-closed and visible.

**R2. One transactional writer.** `DraftTemplateAnalyticsRepository.upsert(row)` is replaced by
`record(firmId, template, change, opts?)` with `change` = `{ kind: "compose" }` or `{ kind: "search", query }`. Firestore:
one `runTransaction` (the `firestoreDbModular` wrapper, so the F10 fence and the F11 outbox stage as for every other
transactional write) reads `template:{firm}:{T}`, refuses a stored row whose `firmId` is not the caller's
(`foreign_firm`) or that fails the canonical validator (`malformed`) by throwing `DraftTemplateAnalyticsRefusedError`,
otherwise applies the change to the stored row (or a fresh row) and sets it. Memory: the same decision function, with no
`await` between read and write. Reason: the blind upsert was the overwrite path, and the non-transactional
read-modify-write loses increments under concurrency (RED: six concurrent composes, count 2).

**R2a. A template-search page is ONE transaction** (PR #126, Codex P2). The search counts its page through
`recordSearchHits(firmId, templates, query, opts?)`, not a loop of `record` calls: one transaction reads every hit's
row, decides every next row (one `foreign_firm` / `malformed` refusal throws, and the transaction writes nothing), then
sets every row. Memory decides every row before storing any. Bound: at most `DRAFT_TEMPLATE_ANALYTICS_MAX_SEARCH_HITS`
= 100 templates, none repeated; 100 is the route's page cap (`MAX_PAGE_LIMIT`, pinned by a unit test), so a page is at
most 100 reads + 100 writes + the request's audit-outbox entry, inside Firestore's 500 writes per transaction and its
10 MiB transaction size. A larger page is refused, never split. Compose stays on the single-row `record`. Reason: with
the per-hit loop, a later refused hit returned 409 after the earlier hits had committed, and every retry counted them
again (RED at `333c1b7`: the first hit's `templateSearchCount` went 0 to 1 under the 409).

**R3. F12 / F13 helpers, unchanged.** Reads use the F12 helpers as they are: `getById` (`get`) and
`listAllRowsByFirm` + `asFirmScopedList` (`listByFirm`), and `requireCallerFirmId`. Following the F13 canonical-shape
pattern (`readMatterClientSearchIndexRow`), a new validator `readDraftTemplateAnalyticsRow(id, data)` type-checks every
field and requires the document id to equal `template:{row.firmId}:{row.templateId}`; the document id wins over any
stored `id`. No F12 or F13 helper is edited.

**R4. Legacy ids are ignored.** A legacy `template:{T}` row (or any row whose id does not match its own firm and
template) is dropped by `listByFirm`, is `null` from `get`, and is never addressed by `record`. It stays in storage until
the backfill moves or reports it.

**R5. A refusal is an error, not an absence.** Both paths answer **409** with code `template_analytics_refused`. The
Next core sends `{ error, code, reason: "foreign_firm" | "malformed" }`; through the F02 router (production) the client
receives `{ error: { code: "template_analytics_refused" } }` (the router forwards the code only). Compose: the draft is
created first (as on main), then the analytics transaction refuses; the 409 carries the F10 `effectCommitted` signal
(observed through the F02 router), so a retry with the same key is not taken for a fresh compose. Search: the GET
answers 409 and counts no hit of the page, on the first attempt or on a retry (R2a). Reason: the FA-F13-004 precedent
(`SearchIndexMalformedError`): a refused integrity check must never be taken for a missing row and silently replaced.
Observed before this ruling (route e2e, production mode): compose answered 400 `invalid_request` and search 500
`internal`, both misleading for a stored-state conflict; the e2e now pins 409 and the code. Devil's advocate: the compose
reports failure while its draft exists. Accepted: this only happens over a row that is already corrupt (another firm's
stamp under this firm's id, or bad fields), which no code path in this repo can now produce; it is loud and specific.

**R6. Template metadata.** A row keeps the name, posture and category written when it was first created (as on main).

**R7. Runtime store map.** Keyed by the firm-qualified id (the memory repository shares it).

**R8. Migration** (`scripts/backfill-template-analytics.ts`, `npm run backfill:template-analytics`), the F13-003 pattern:
dry-run by default, `--apply` to write, per-row lines, audit rows in `audit_log` (firm `_platform`), credentials from the
environment. Each row of `draft_template_analytics` is classified:

- **canonical**: its id is `template:{firmId}:{templateId}` of its own fields and it validates. Left as it is.
- **legacy, movable**: id `template:{T}` (no further `:`), the fields validate, `templateId == T`, and no `drafts` row of
  template T belongs to a firm other than the row's stamped firm.
- **legacy, unrecoverable**: as above, but `drafts` of template T exist for another firm. Several firms shared the one
  document, so its counts (and possibly its stamp) mix firms. It cannot be split; it is reported with **ids only** (the
  row path and the firm ids involved, never counts or query text), never moved and never deleted.
- **malformed**: anything else (bad fields, `templateId` not matching the id, an unknown id shape, a canonical-shaped id
  whose firm is not the row's). Reported, untouched.

Evidence for "unrecoverable" is the `drafts` collection, read per template with `select("firmId")` (no bodies). A move,
in one transaction, re-reads the legacy row (rejected if it changed since planning: identity or counts) and the target;
rejects a target that is foreign or malformed; creates the target from the legacy fields, or, if the firm has written the
target since deploy, merges (counts summed, each `last*` taken from the later of the two with its query, `updatedAt` the
later); then deletes the legacy row. Reason for deleting: a copy that leaves the legacy row is not idempotent (a rerun
would add its counts again), and a marker field would not survive an old instance's whole-document write during rollout;
deleting in the same transaction makes a rerun see only rows written after it. The script deletes only a row whose
content it has just written to the target, in that transaction, when the operator passes `--apply`; this session runs it
only against the emulator.
Search-only cross-firm overwrites leave no `drafts` evidence and cannot be detected: residual (section 8).
Exit codes: `0` nothing failed and nothing unrecoverable; `1` a write failed (later rows still run); `2` unrecoverable
rows were reported (dry-run or apply). A second run after an apply plans no move.

**R9. Rules.** `draft_template_analytics`: `allow get` needs `sameFirm()`, a staff role (partner, associate, clerk) and
`id == 'template:' + resource.data.firmId + ':' + resource.data.templateId`; `allow list` keeps `sameFirm()` and the staff
role (a list query cannot constrain the document id; it must filter `firmId ==` the caller's firm); writes stay `false`.
G-2 (`functions/test/g2.cross-firm.test.ts`) seeds every collection at `g2-a-doc`; its control read would now be refused
by the id check, so its fixture seeds this collection at `template:g2-rules-firm-a:g2_template` with a `templateId`
(fixture only; every G-2 assertion is unchanged). F32 TTL rules are not touched.

**R10. Scope.** Only `draft_template_analytics` (and its search fields) is fixed. FA-D4-001-FU1 is recorded, not fixed.
The collection name is unchanged (F42's inventory may name it).

## 5. Components

- `platform/persistence/draftTemplateAnalytics.ts`: id builder and parser, `isLegacyDraftTemplateAnalyticsId`, the row
  validator, `nextDraftTemplateAnalyticsRow` (the decision both repositories use), `DraftTemplateAnalyticsIdError`,
  `DraftTemplateAnalyticsRefusedError`.
- `platform/persistence/spineRepositories.ts`: the repository type (`record`, `get`, `listByFirm`) and the memory
  implementation.
- `platform/persistence/firestoreSpineRepositories.ts`: the Firestore implementation.
- `app/api/d4/drafts/route.ts`: compose and search call `record`.
- `platform/persistence/draftTemplateAnalyticsBackfill.ts`: pure plan, dry-run text, apply with audit rows.
- `scripts/lib/draftTemplateAnalyticsBackfillAdmin.ts` (Admin SDK store and loader), `scripts/lib/draftTemplateAnalyticsBackfillCli.ts`
  (exit codes), `scripts/backfill-template-analytics.ts` (entry), `package.json` script.
- `firestore.rules` (this collection's block only); G-2 fixture.

## 6. Consumer impact

- `DraftTemplateAnalyticsRepository.upsert` is gone; `record` replaces it. The only production caller is the D4 drafts
  route. Test doubles that stub the repository must add `record`.
- Response shapes of `/api/d4/drafts` are unchanged. Until the backfill runs, each firm's counts start from zero (legacy
  rows are ignored), so template ranking restarts; after it, moved rows carry their counts.
- A compose or template search over a corrupt row of the caller's own id now answers 409
  `template_analytics_refused` (R5) instead of overwriting it.
- Clients can no longer `get` a legacy or mismatched row (no client reads this collection in the repo).
- Operators: run `npm run backfill:template-analytics` (dry-run), then `-- --apply`, after the new code is fully deployed.

## 7. Testing

- `tests/fa-d4-001-template-analytics.e2e.firestore.test.ts` (production mode, real routes, emulator): RED on main 5/5.
- `tests/fa-d4-001-template-analytics.rules.firestore.test.ts`: RED on main 2/6 (legacy and mismatched reads).
- `tests/fa-d4-001-template-analytics-backfill.e2e.firestore.test.ts`: dry-run, apply, rerun, merge, unrecoverable,
  malformed, exit codes, audit rows; RED on main (module absent).
- `tests/fa-d4-001-template-analytics.unit.test.ts`: id, validator, decision function, memory repository.
- Updated: `tests/persistence.repositories.test.ts` (`upsert` to `record`), `tests/persistence.route-wiring.test.ts`
  (stub adds `record`), the G-2 fixture.
- At least 10 hand mutants: id format, separator refusal, the transaction's firm check, the validator's id check,
  legacy filtering, the search path, migration idempotency, unrecoverable detection, merge arithmetic, the rules (get id
  check, `sameFirm()`).

## 8. Residuals (NOT DEMONSTRATED or out of reach)

- The backfill has not run against any real project; only the emulator.
- A cross-firm overwrite done only through searches leaves no `drafts` evidence; such a legacy row is moved to the firm it
  is stamped with, and the other firm's lost search counts cannot be recovered.
- Old instances still running during a rolling deploy write legacy ids; run the backfill after the rollout (a later
  rerun moves rows written meanwhile).
- FA-D4-001-FU1 (court-ops acknowledgement activity id) is open.
