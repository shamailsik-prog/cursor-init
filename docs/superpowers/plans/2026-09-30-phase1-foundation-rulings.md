# Phase 1 foundation: rulings and parked follow-ups

Companion to `2026-09-30-phase1-foundation.md`. This page summarises every ruling taken while the plan was executed,
30 September to 7 October 2026, one line each. The working ledger itself was kept outside the repository. Rulings that
change what the specification says are also recorded as errata in `docs/architecture/ERRATUM_SET_2_PROPOSED.md`
(PROPOSED, pending the partner's signature); the erratum is cited where one exists.

Under the owner's standing autonomy instruction, rulings were taken by the controller and recorded rather than put to
the owner. "Cost if wrong" is what we pay if the ruling turns out to be the wrong call.

## Rulings

### Sequencing and process

| # | Ruling | Reason | Cost if wrong |
|---|---|---|---|
| 1 | Run Tasks 2 to 8 first and Task 1 (chain freeze) last, after the defect streams are integrated. | Task 1 and the auth stream both wrap the same route exports; wrapping once on the integrated branch avoids a double-wrap conflict. | The freeze lands later in the sequence. |
| 2 | Defer Task 8 (G-2) until the integrated streams are merged, and widen its brief to the spec's full scope (every read function of D1-1, D1-2, D3-1, D5-1, D2-1, web and WhatsApp). | The plan scoped only identity and Firestore reads; the spec (L18 §10 G-2) is wider, and the spec wins. | A later G-2, and a larger suite to keep green. |
| 3 | Run Task 1 in a separate worktree in parallel with Task 8 round 2, merging after review. | Throughput; the two touch few shared files. | Merge conflicts on shared files (`gate_g0.sh`, `package.json`). |
| 4 | Split the final-audit fix round into three streams: identity/rules/performance, data/idempotency, and CI/spec records/docs. | The findings fall into three file sets with little overlap. | Conflicts at merge where a finding crosses streams. |
| 5 | Treat a strict-adherence request as binding: where code deviates from L18, fix it or record it as a PROPOSED erratum; never leave it implicit. | The owner asked for strict spec adherence; L17 §1.4 rule 2 requires decisions to be visible. | More errata for the partner to sign. |

### Identity, authentication and permission (Tasks 4 to 6)

| # | Ruling | Reason | Cost if wrong |
|---|---|---|---|
| 6 | Keep the Next.js session (`platform/p5/session.ts`) and the functions `requireAuth` as two paths with the same claim semantics: claims restrict, never raise. | Functions are the spec's target runtime; the Next.js app is transitional (E-23). | Two auth paths to reconcile. The final audit found them drifting. Superseded by SEC-2: both paths now evaluate one shared policy, `platform/p5/identityPolicy.ts`, and one decision table, `platform/p5/permissionDecision.ts` (E-27). |
| 7 | The users doc is authoritative for role, clearance and active status; claims only restrict (E-27). | A demotion or deactivation must bite on the next call, not when the token expires. | One extra Firestore read per call. |
| 8 | MFA tests may stub the decoded token if the Auth emulator cannot mint second-factor tokens. | Emulator limitation, not a spec change. (In the event the emulator's real MFA flow was used.) | The MFA claim path would be proven by a unit test only. |
| 9 | Keep the `Role` type local to functions with a drift test; `callerFromCallable` requires a firmId; callables check revocation and `disabled` through `getUser().tokensValidAfterTime`. | Functions build without the Next.js tree; revocation must hold on every channel. | An extra `getUser` read per callable. Superseded by 17 (callables removed) and SEC-2 (`Role` now comes from the shared `platform/p5/identityPolicy.ts`); the revocation check holds on the HTTP `api`. |
| 10 | Fix the prototype-key fail-open with a local `Object.hasOwn` guard in `functions/src/p5`; leave the root `platform/p1/types.ts` fix to the auth stream. | Avoid an integration conflict with the stream that owned that file. | The Next.js side stays open until that stream lands. |
| 11 | `user_disabled` takes precedence over `token_revoked`; a target's `platformAdmin` is preserved; `onboardFirm` is resumable for its founder; `setUserClaims` rolls back on partial failure; a partner may not act on a user cleared above them. | Deterministic error reasons; no partial identity state; no escalation through peers. | Partners cannot manage higher-cleared peers (by design). |
| 12 | Last-partner guard; hosted bootstrap requires `SIKANDER_BOOTSTRAP_FOUNDER_EMAIL`. | A firm must never lose its last partner; first-firm bootstrap must name its founder. | An operator step at first deployment. |
| 13 | The rules fix that made identity fields on `users/{uid}` server-only goes to the rules stream, the sync hardening stays in Task 5. | One owner for `firestore.rules`. | Both had to ship in the same PR (they did). |
| 14 | MFA: recovery-code hashes live in server-only `mfa_recovery/{uid}`; codes are invalidated on disable; `syncMfaStatus` exists; disable is resumable; helpers move to `common.ts`; `firms/*` is server-only (E-29). | Codes never at rest in plaintext; no stale codes after a disable. | Disable needs an approval flow and more moving parts. |
| 15 | Accept a millisecond race in the MFA attempt reservation (N3). | The retry is idempotent and the window is milliseconds. | One extra attempt in a rare race. |
| 16 | Final audit SEC-3: enforce the users record (active, claims, MFA policy) in the Firestore rules now. | Rules trusted token claims for up to an hour. | Extra rule reads on every direct client access. |
| 17 | Final audit U-1: drop the `onCall` exports; the HTTP `api` is the §4.1 channel. | Callables took the firm from the body and had no Idempotency-Key. | Any client built on callables must move to HTTP. |

### HTTP boundary, idempotency and rate limits (Task 7)

| # | Ruling | Reason | Cost if wrong |
|---|---|---|---|
| 18 | One route table with a duplicate-route guard; order auth → rate limit → idempotency → handler. | L18 §4.1 "duplicate route registration fails the build"; refuse cheaply before work. | None identified. |
| 19 | UUID v4 keys with an `in_progress` claim; 409 on a concurrent repeat, 422 on a different body or user; a 5xx releases the claim; only final results are replayed (E-28). | A retry after a transient failure must run, not replay the failure. | A retry after a 5xx re-executes. |
| 20 | Idempotency keys and rate-limit counters in Firestore until the P6 Postgres store exists (E-28). | Postgres P6 is not built. | A migration at the P6 cutover. |
| 21 | Fixed-window rate limits, plus a per-IP pre-auth limit of 60/min. | Simple and enforceable; the pre-auth limit closes unauthenticated flooding. | Bursts at window edges. |
| 22 | Accept the rate-limit counter as atomic increment plus read-back instead of a transaction. | Fail-conservative: it never over-admits. | An over-limit parallel burst may be refused in full. |
| 23 | Per-firm limit overrides from `firms/{firmId}.rateLimits` (E-34). | Server-only and already loaded with the firm. | Not the spec's feature-flag mechanism until P6. |

### Provider policy, freeze and flags (Task 1, integration)

| # | Ruling | Reason | Cost if wrong |
|---|---|---|---|
| 24 | Provider policy follows the L18 §4.6 table (the earlier rank-0-only policy was reverted). | Strict adherence; rank-0-only was a deviation. | Providers usable at ranks 1 and 2 once a DPA is recorded (O-21). |
| 25 | Final audit U-3: rank 4 (privileged-restricted) needs an in-region provider and an executed DPA. | Rank 4 must not be less constrained than rank 3. | None identified. |
| 26 | Core filings are `create_package`, `decide_package` and the package list, derived from existing tests and code, not the plan's guessed view names. | The plan's names were a guess. | A core view frozen by mistake (tests cover create and decide). |
| 27 | With the flag off, `decide_package` writes no dispatch-queue or annexure row (a sanctioned internal edit under E-24). | Those writes are filing transport. | An approved package stops at filing readiness. |
| 28 | The disabled response is 404 `{ error: "feature_disabled", flag }` after authentication, audited at most once per user, route and flag per minute (O-17). | Hides frozen surfaces without breaking clients' error handling. | Partner may choose another response at signature. |
| 29 | The all-layers-disabled boot test enumerates the frozen surfaces exactly. | A hand-picked list let a surface slip. | Test churn when surfaces change. |
| 30 | The L18 §9.2 core-edit CI check, when built, must exempt `platform/flags/`. | The flag registry necessarily names non-core flags. | A loophole if the exemption widens. |
| 31 | Freezing the P5 tenancy lineage chains is a follow-up under E-24, not done now. | Doing it now would change the G-2 surface mid-review. | Those chains stay live a little longer. |
| 32 | The approval-path additions from the citation work (body hash, judgment re-check) stay core. | They guard filing readiness, which is in scope. | None identified. |

### Tenant isolation and Gate G-2 (Task 8)

| # | Ruling | Reason | Cost if wrong |
|---|---|---|---|
| 33 | Content-addressed upload dedup is scoped to (firmId, matterId) (E-30). | Firm-wide dedup was a membership and existence oracle (R-2). | Duplicate storage across matters. |
| 34 | G-2 discovery reads a declarative `ROUTE_SURFACE` per route, with helper-only selector access and a static guard. | Discovery by parsing missed nine selector forms. | Every new route must declare its surface. |
| 35 | Second-line firm check, atomic ephemeral emulator ports, CNIC marker and per-path denial reasons in G-2. | Defence in depth; concurrent local runs must not collide. | A more complex gate script. |
| 36 | Strip undeclared headers per surface in `withSession`, and have the guard follow imports and keep a body-field inventory. | Closes header and cookie selector backdoors. | False positives on legitimate new fields. |
| 37 | G-2 on the emulators, recorded with `recordGatePass` from a CI run URL, is the R-5 live cross-tenant test (E-36). | A staging project is not available; the emulator suite is exhaustive. | The partner may require a staging run. |

### Citation gate and drafts (security streams)

| # | Ruling | Reason | Cost if wrong |
|---|---|---|---|
| 38 | Fold citations by Unicode category and test with seeded property-based fuzzing (at least 2,000 variants per citation), instead of enumerating evasions. | Enumeration kept missing new forms. | Slower tests; folding may over-match. |
| 39 | Add a refusal layer (`draftCharset.ts`): refuse bidirectional, tag, ignorable, confusable and mixed-script characters with 422 `unsupported_characters`; store NFC; never delete text (E-32). | The gate cannot verify what it cannot read. | Some genuine pasted text is refused. |
| 40 | Add Urdu reporters and acronym year-proximity; refuse entity-encoded disallowed characters (R5-5). | Real Pakistani citation forms; closes an encoding bypass. | More false positives to tune. |
| 41 | Make six targeted false-positive fixes, with a corpus regression test that asserts the rates. | 18.8 % of realistic drafts were blocked and 10 of 28 pastes refused. | Rates must be kept under test. |
| 42 | Fix the round-6 minors F-1 to F-5 before merge. | F-1 and F-2 could pass a real reference. | None identified. |
| 43 | Leave unlisted spelled-out reporter names (for example "Pakistan Law Cases") unresolved for now. | Each is a one-line addition later. | Such a citation is UNVERIFIED until added. |
| 44 | A partner override may clear UNVERIFIED with an audited reason (E-31). | The corpus is incomplete. | Rests on partner discretion. |
| 45 | Merge the security rules as the union of both branches' restrictions. | Never widen access at a merge. | Over-restriction to unwind later. |

### CI (final-audit CI stream, 7 October 2026)

| # | Ruling | Reason | Cost if wrong |
|---|---|---|---|
| 46 | G-0 checks out full history and passes `BASE` = the PR base commit (or `origin/main` on push); the guard script is unchanged. | The guard already honours `BASE`; a depth-1 checkout has neither `origin/main` nor the base commit. | Slower checkout on a large history. |
| 47 | Pin actions to the current Node 24 majors by commit SHA (checkout v7.0.1, setup-node v7.0.0, setup-python v7.0.0, setup-java v6.0.1, cache v6.1.0, upload-artifact v7.0.1, codeql-action v4.38.2, gitleaks-action v3.0.0), one set across every workflow. Re-pinned 7 Oct 2026 when the forensic workflows landed: v6.1.0 / v6.5.0 / v6.3.0 / v5.7.0 / v5.1.0 were no longer the current majors. | The v4 and v5 majors run on the deprecated Node 20 runtime; SHAs cannot be moved under us. | A major-version behaviour change surfaces in CI. |
| 48 | The corpus pytest job installs a pinned minimal `requirements-test.txt`, not the runtime `requirements.txt`. | The runtime set is heavy and lacks `pgvector`, so it fails at collection. | The test set can drift from the runtime set. |
| 49 | In the gates job, G-0 runs before `npm ci`, and G-1 and G-2 run even if G-0 fails. | G-0 is static; the gates are independent. | None identified. |
| 50 | Emulator suites fail rather than skip when `CI` is set and the emulator env is missing. | A skip would make `test:emu` a vacuous green. | A local run with `CI` exported fails without emulators. |

## Parked follow-ups

Open items that need the partner are in ES2-4 of the erratum (O-15 to O-24). Engineering follow-ups:

- **Final audit, deferred:** M-4 rename test files by behaviour, not review round; M-7 consolidate route helpers
  (`parseLimit`, `parseCursor`, `requireActor`, per-route idempotency) into `platform/http/`; SEC-7 Next.js security
  bump (O-24); asynchronous P5 audit outbox (O-22); opaque cursors (O-23).
- **Dependencies:** remaining `npm audit` findings need majors (firebase-tools 15, vitest 5); shared code bundled into
  functions resolves third-party deps from the root `node_modules`.
- **Identity and MFA:** MFA break-glass and lockout (O-20); no claims re-sync when a revert is skipped by a newer version;
  a failed post-revert re-sync is only logged; the store-unavailable reason for an invalid caller clearance is
  unreachable; a stale comment in `functions/test/p5.permission.test.ts`.
- **Rate limits:** per-firm daily limits (100/day conflict checks, 500/day WhatsApp research) are not built (E-34).
- **Freeze:** freeze the P5 tenancy lineage chains under E-24; build the L18 §9.2 core-edit CI check with the
  `platform/flags/` exemption.
- **G-2 guard:** detect transitive or dynamic imports of `next/headers` (R1-a); key `NON_SELECTOR_BODY_FIELDS` per
  action (R2-a). Re-run and re-record G-2 when the WhatsApp webhook, D5-1 web research or Postgres RLS lands.
- **Provider policy:** the privileged-restricted deterministic path and its partner exception are not built (blocked,
  spec-safe).
- **Citation gate:** add unlisted spelled-out reporter names as they are found.
- **Later plans:** the Module 6 conflict engine; pre-existing deviations carried from `main` (E-39).

## Owner rulings, 2026-10-07

| # | Ruling | Reason | Cost if wrong |
| --- | --- | --- | --- |
| O-1 | GitHub (`shamailsik-prog/cursor-init`) is the master copy. The "port to Origin" step in PR #4 is withdrawn; AGENTS.md no longer refers to an Origin forge. | Owner instruction: "GitHub is the master copy". | None known; if an upstream mirror reappears, merges on GitHub could again be overwritten. |
| O-2 | The first-firm founder email is `ss@nhslegal.com`, committed as `SIKANDER_BOOTSTRAP_FOUNDER_EMAIL` in `functions/.env`. | Owner instruction. Firebase loads `functions/.env` for every project on deploy; the value is an address, not a secret. | Changing the founder means editing one line before the first deploy. |

## Phase 2a rulings

The matter spine and Module 6 conflict engine rulings are P2-1 to P2-22 in
`docs/superpowers/specs/2026-10-07-phase2a-matter-spine-conflict-design.md` (each with its reason and cost if
wrong). They are recorded there and not repeated here. The architecture records are Erratum E-40 (new events and
collections) and open item O-25 in `docs/architecture/ERRATUM_SET_2_PROPOSED.md`.

| # | Open item | Reason | Cost if wrong |
| --- | --- | --- | --- |
| O-25 | Corporate-group and related-person conflict screening is not built (P2-22). `corporateGroup` is stored, not screened. | Unmodelled in the architecture; YAGNI for 2a. | A group-company conflict is missed until a later part adds it. |

Phase 2a close is Gate G-4 (`npm run gate:g4:phase2a`): route coverage, boot with every layer flag off, forensic
test 3, and Gate G-2 over all routes.

## Phase 2b-A rulings

The entity review queue and `confirmMerge` rulings are P2-23 to P2-41 in
`docs/superpowers/specs/2026-10-08-phase2b-entity-review-design.md` (each with its reason and cost if wrong). They are
recorded there and not repeated here. The architecture record is Erratum E-41 in
`docs/architecture/ERRATUM_SET_2_PROPOSED.md`; it also withdraws the partner 'merge_events revert-only' rule.

| # | Open item | Reason | Cost if wrong |
| --- | --- | --- | --- |
| O-27 | Opposing-party hit label: closed. The label is max(matter, party row) (P2-37). | The 2a engine under-labelled a hit when the matter existed. | None; fixed in code. |
| O-28 | Auto-confirm materialisation: a P2 job writes the `merge_events` row at day 30 (actor `system`). Until then the 30-day auto-confirm is computed at read time and leaves no row. | Needs the P2 jobs (Phase 3) and un-merge (2b-B). | L17.2 #16 does not hold for auto-links until the job runs. |
| O-29 | Responsible-associate assignment: review items go to any partner or associate cleared to the pair. | No per-entity or per-client responsible associate exists to route to. | Review items can sit unowned. |

Final-review rulings (8 October 2026, owner's standing autonomy instruction):

- Late dispute and staleness (final review minor 2): the code stays, the spec text was wrong. A dispute of a pair aged 30 days or
  more (auto-confirmed) makes a check cleared before it 409 `check_stale` at `openMatter`, because the reopened link turns the
  stored informational same-role hit into a fresh review. This is fail-safe. P2-30 and Review Focus 4 are amended; the
  emulator test "a late dispute of an auto-confirmed pair" in `d1.entity-invariants.emu.test.ts` pins it.
- Pair label (minor 1): `getEntity` and `listAliases` use the same pair label as `readPair` and the queue, including the other
  entity's client; a pair whose other client is above the caller's clearance is hidden.

- Re-screen race at `openMatter` (Cursor Bugbot on PR #8, 8 October 2026): the P2-6 re-screen ran before the transaction and
  nothing in the transaction read what it depended on, so a `confirmMerge` (or a registration, a dispute or rejection, another
  open, a close) committing in between was missed, and P2-30 relies on that re-screen as `confirmMerge`'s stale guard. Ruling:
  a per-firm registry version, `counters/{firmId}_registry` (server-only: `counters` already denies every client read and
  write, so no rules change), bumped in the same transaction by every writer of what `loadRegistry` reads and the screen
  uses: registerClient, openMatter, closeMatter, confirmMerge, disputeLink, rejectLink (`functions/src/d1/registryVersion.ts`
  lists them and the writers left out: advanceStage writes only `stage`; no function writes `featureFlags` or
  `transliteration_map`). `openMatter` reads the version before the screen and again first in its transaction; a moved
  version makes the round write nothing (no audit row) and the round is redone. After 10 moved rounds it answers **409
  `registry_contended`**, audited as the call's one deny row. 409, not 503: the service is up and the refusal is a conflict
  with concurrent writes to the same firm's registry, as `idempotency_in_progress`; nothing was written, so a retry is safe.
  10 rounds, not the 3 first proposed: every open bumps the version and a round fails only when another registry write
  commits inside it, so N concurrent opens in a firm finish within N rounds; 3 rounds failed the 10-parallel-opens test
  (Review Focus 3) in 5 of 6 runs. Cost if wrong: under sustained registry writes an open is refused with a retryable 409
  rather than bound on a stale screen (fail-safe). Pinned by the emulator tests in `d1.matter`, `d1.entity-invariants`,
  `d1.entity-decisions` and `d1.client` (the test seam `openMatterTestSeam.afterPreScreen` makes the race deterministic).

Phase 2b-A close is Gate G-4 (`npm run gate:g4:phase2b-a`): route coverage (20 routes), boot with every layer flag off,
the two L17.2 invariant tests, and Gate G-2 over all routes.

## Phase 3a rulings

The P2 job engine core rulings are P3-1 to P3-23 in `docs/superpowers/specs/2026-10-08-phase3a-job-engine-design.md`
(each with its reason and cost if wrong). They are recorded there and not repeated in full here. The architecture record
is Erratum E-42 and open items O-30 to O-44 in `docs/architecture/ERRATUM_SET_2_PROPOSED.md`. The deciding value of each:

- P3-1 scope: 3a is the engine core, one internal job type `platform.diagnostic`, no real scheduled job, no production subscriber; 3b un-merge saga, 3c O-28.
- P3-2 data model: top-level `jobs/{jobId}` with `engine: "p2"`, `jobType`, firmId and classification on every row (not v6's nested `firms/{firmId}/jobs`).
- P3-3 states: `queued`, `running`, `failed`, `done`, `dead_lettered`, `cancelled`.
- P3-4 enqueue: a transactional outbox inside the causing transaction; no `createJob` route; doc id from (firmId, jobType, idempotencyKey).
- P3-5 delivery: Firestore trigger, then Cloud Tasks (asia-south1), then the worker; task bodies are `{ jobId, seq }` only.
- P3-6 worker: transactional claim, 600 s lease, lease-fenced commits; delivery at least once, effects exactly once.
- P3-7 retries: 1 attempt and 3 retries at 1 s / 5 s / 25 s, `MAX_ATTEMPTS = 4`, then `dead_lettered`; `MAX_MANUAL_RETRIES = 3`.
- P3-8 sweeper: every minute, re-dispatch after a 30 s grace, reclaim expired leases, clock-skew bounds (2 s, 300 s), `SWEEP_LIMIT = 100`.
- P3-9 errors: only `sanitizeError` output (code and fixed message) leaves the job row; payload values never.
- P3-10 routes: HTTP `/api/platform/jobs/{listJobs,getJob,retryFailedJob,cancelJob}`, rate kind `general`, one CallAudit row per call.
- P3-11 actions: `job.read`, `job.queue`, `job.retry`, `job.cancel`; row visibility full / restricted / none; a view never carries the payload.
- P3-12 retryFailedJob: dead-lettered only, note of at least 20 characters, at most 3 manual retries, partner only for saga types.
- P3-13 cancelJob: partner; queued, failed or dead-lettered non-saga jobs only; running is 409 `job_running` (O-31).
- P3-14 rules: engine rows are denied to the client SDK; the API is the only read path.
- P3-15 events fan-out: `onEventCreated`, one job per subscriber with key `eventId:subscriberId`; no subscriber may subscribe to `job.*`.
- P3-16 scheduled primitive: `ScheduledJobSpec`, PKT periods, run key `jobType:period`, backfill command; no real scheduled job.
- P3-17 diagnostic job type `platform.diagnostic`: behaviours succeed, fail_times, throw_raw, permanent, hang; the only registered production handler.
- P3-18 system audit: actor `system`, `onBehalfOf` the creator, written in the transition's own transaction.
- P3-19 lint: `functions/` is linted (Next.js-only rules off), zero warnings in the gate.
- P3-20 registry-version discipline: a runtime write recorder over every emulator suite, scoped by `REGISTRY_SCOPE`.
- P3-21 gates: `ci_gates/gate_g4_phase3a.sh` in five steps and the CI step after 2b-A; G-2 gains four probes.
- P3-22 indexes: eight for `listJobs`, two for the sweeper.
- P3-23 errata: E-42 and O-30 to O-35 (execution adds O-36 to O-40, and the final review O-41 to O-44).

Execution rulings (8 October 2026, owner's standing autonomy instruction; each is also an "Amended in execution" note on
its spec ruling and in E-42 (k) to (r)):

- Job notes are capped at 2000 characters: 400 `note_too_long` (P3-11).
- `listJobs` `nextCursor` comes from the last visible row, so pages are full unless the scan reaches the end; this replaces "a page may be short" (P3-11).
- The worker accepts any dispatched `seq` <= `dispatchSeq` while the row is claimable; the lease serialises the runners; this replaces the exclusive-seq rule (P3-6 to P3-8).
- `onEventCreated` runs with `retry: true`; permanent causes are logged and skipped, only store errors propagate (P3-15).
- Scheduled ticks and backfill are isolated per firm (P3-16).
- `health` declares asia-south1 itself; `setGlobalOptions` runs after the function objects are built and `deploy.test` checks the built bundle.
- `openMatter` treats a contention-aborted round transaction as a moved round: 409 `registry_contended`, not 500 (extends the 2b-A re-screen ruling).
- The Next.js build self-hosts its fonts.

| # | Open item | Reason | Cost if wrong |
| --- | --- | --- | --- |
| O-30 | Alert channel for dead-lettered jobs: an L4.10 "attention required" item and a P4 notification to the right person (L3639, L3645, L8413). Until built, a dead letter is a structured `job.deadLettered` error log line; a log-based alert policy on it is a deploy step | Phase 3a spec Appendix A. | Owner: Engineering, with L4.10 and P4. |
| O-31 | Cooperative cancel of a running job: a `cancelRequested` flag that `runFenced` honours, so a long job stops at its next fenced step (E-42(d)) | Phase 3a spec Appendix A. | Owner: Engineering, when a job type runs long enough to need it. |
| O-32 | L3.7 Cloud Personal Agent jobs (agentic, confirmation-held: `awaiting_confirmation`, `agentTasks`, the user's own permissions, L3103-3135, L7993) on the P2 engine | Phase 3a spec Appendix A. | Owner: Partner (L3.7 is OPTIONAL, L5951-5956), then engineering. |
| O-33 | Firestore database location. Firestore triggers run in the database's region; confirm at first deploy that the database is in asia-south1. If not, the two triggers deploy in the database's region or are dropped, and the sweeper alone dispatches (latency ≤ 90 s) | Phase 3a spec Appendix A. | Owner: Engineering, at first deploy. |
| O-34 | Retention of `jobs` rows and their `job.*` events. Nothing is deleted in Phase 3; any purge needs a partner decision and its own erratum (C-12, W-13) | Phase 3a spec Appendix A. | Owner: Partner, then engineering. |
| O-35 | Per-job cost (`costUSD`, L1961) and the Opik trace (`opikTraceId`, L8142): `traceId` becomes the Opik trace id, and cost is recorded from P1, when P1 and self-hosted Opik run in Cloud Functions | Phase 3a spec Appendix A. | Owner: Engineering, with P1. |
| O-36 | Sweeper re-dispatch backoff, and head-of-line blocking when more than `SWEEP_LIMIT` (100) rows are due: query A is ordered by `nextAttemptAt`, so a backlog of long-running rows can starve later ones, and a row still running is re-dispatched every 30 s grace. Resolve both, with a load test using long handlers, before 3b ships long-running jobs | Recorded in Erratum E-42 (Phase 3a spec Appendix A or execution). | Owner: Engineering, before 3b. |
| O-37 | Event fan-out reconciliation: an `events` row whose fan-out failed beyond the 7-day trigger retry window has no subscriber jobs and nothing detects it. Scan `events` for rows lacking their subscriber jobs and enqueue the missing ones | Recorded in Erratum E-42 (Phase 3a spec Appendix A or execution). | Owner: Engineering, before the first production subscriber. |
| O-38 | Scan cap for clearance-filtered lists (`listJobs`, `listClients`): many rows hidden by the caller's clearance can make one page scan much of a firm's collection | Recorded in Erratum E-42 (Phase 3a spec Appendix A or execution). | Owner: Engineering. |
| O-39 | A job's own label versus its matter's later, higher label (Task 7 finding M-4): `getJob` and `listJobs` apply the job's own classification (P3-11), so a matter raised after the job was enqueued is not re-checked. Re-check the matter's current label on single-job reads | Recorded in Erratum E-42 (Phase 3a spec Appendix A or execution). | Owner: Engineering. |
| O-40 | Cancelling a handler that overruns its budget: after `handler_timeout` the handler keeps running and a late `runFenced` step can commit until the failure commit lands (at-least-once model, documented in the worker module). Pass an `AbortSignal` on `ctx`. Distinct from O-31, which cancels a healthy running job on request | Recorded in Erratum E-42 (Phase 3a spec Appendix A or execution). | Owner: Engineering, with O-31. |

Phase 3a close is Gate G-4 (`npm run gate:g4:phase3a`): route coverage (20 d1 routes, 4 platform/jobs routes), boot with
every layer flag off, the five job-engine invariants and two registry-discipline tests by exact name, functions lint at
zero warnings, and Gate G-2 over all routes.

## Phase 3b rulings

The un-merge saga rulings are P3-24 to P3-33 in `docs/superpowers/specs/2026-10-09-phase3b-unmerge-saga-design.md` (each with
its reason and cost if wrong). The architecture record is Erratum E-43 and open items O-46 to O-48 in
`docs/architecture/ERRATUM_SET_2_PROPOSED.md`. The deciding value of each:

- P3-24 scope: `unmergeEntity` and two saga jobs for the collections that reference a link today (`entity_links`, `conflict_checks`); L8411's other collections hold no entity reference yet.
- P3-25 route: `POST /api/d1/entity/unmergeEntity { linkId, note }`, partner only, 409 `link_not_confirmed` unless every row is confirmed by one unreverted `merge_events` row.
- P3-26 "unmerge in progress" is the read-time link state `unmerging`: unresolved for the engine, 409 `unmerge_in_progress` for every decision, hidden from the queue.
- P3-27 the reversal reopens the pair as a disputed candidate (partner-only decision), not a rejection and not the prior state.
- P3-28 job types `d1.unmerge.links` and `d1.unmerge.checks`, `saga: true`, key `mergeEventId:collection`, payload ids only.
- P3-29 every effect is a `runFenced` step.
- P3-30 the last job to finish completes the saga in its own transaction and emits `entity.unmerged` once.
- P3-31 eager staleness: relying checks marked stale in fenced chunks of 200, step id from the chunk's check ids, cap 9,600.
- P3-32 no rules or index change; `merge_events` carries the revert record.
- P3-33 gate `gate_g4_phase3b.sh` (eleven named tests, 21 d1 routes); the 2b-A and 3a gates' route count moves 20 to 21. Its `gate-g0.yml` CI step is a follow-up (the autopilot token cannot edit workflow files).

Open items opened: O-46 (window before the checks job), O-47 (scan and cap for relying checks), O-48 (stuck-saga visibility).
O-28 stays open (3c). O-44 stays open: 3b does not use `jobKey`. O-36 (sweeper head-of-line blocking with long handlers)
still applies; the saga handlers are short (one transaction per step) and do not hold dispatch slots for minutes.

Phase 3b gate is `npm run gate:g4:phase3b`; a CI step since the Phase 3b close-out (P3-41).

## Phase 3b close-out rulings

PR #12 shipped the saga with O-36, O-44, O-45 and O-46 still open, although the 3a and 3b rulings had made them
preconditions, and without its CI gate step. The close-out rulings are P3-34 to P3-41 in
`docs/superpowers/specs/2026-10-10-phase3b-closeout-design.md` (each with its reason and cost if wrong); the architecture
record is Erratum E-44, and O-36, O-44, O-45 and O-46 are closed. The deciding value of each:

- P3-34 every job row carries `sweepAt`, written with every status change; the sweeper selects on `(status, sweepAt)`. Amended in execution: a third query (A') re-reads queued or failed rows whose `sweepAt` lies more than 600 s ahead, so a sweep on a clock running fast cannot hide a row; cost one extra page read per sweep, and a skewed row can wait up to about 300 s longer when 100 or more trusted near-threshold rows sort ahead of it.
- P3-35 re-dispatch backoff `min(30 s × 2^redispatches, 600 s)`; `redispatches` resets at enqueue, claim, scheduled retry and manual requeue. Amended in execution: 1 + 9 tasks in a waiting row's first hour (the draft said about 7), then 6 per further hour.
- P3-36 each query reads up to 5 pages of 100 rows per sweep, query B (expired leases) runs first, and a sweep stops after 30 s of wall-clock time (amended after the final review: a burst could outrun the 45 s timeout); the page loop stops on a short page or a page that acted on no row, and a shared set keeps one row from being handled twice in a sweep.
- P3-37 load test: 250 jobs, 240 s handlers, 10 FIFO slots, sweep every 60 s, virtual clock, real store, sweeper and worker. Amended in execution: the draft's bound of 8 tasks per job was an arithmetic error; the bound is the P3-35 schedule for each job's wait, and the fixed total must be at most a fifth of the fixed-grace control's (measured: worst job 14 against 97; total 2,170 against 12,250).
- P3-38 `jobKey` is `uid:route:lower-cased key:suffix`; it throws without a key or a route.
- P3-39 `registerClient` runs up to 10 rounds on a contention abort (and, like `openMatter`, starts no round after 90 s; a round already running can still overrun the 120 s timeout, O-49), then 409 `registry_contended` with one deny audit row and nothing written; `isContentionAbort` moved to `functions/src/d1/contention.ts`.
- P3-40 `openMatter` reads the links a stored check's hits relied on, inside its transaction before any write (rows of the caller's firm only), and answers 409 `unmerge_in_progress` if any has an un-merge in progress, whatever the L17.2 layer flag (a saga started with the flag on runs on if it is switched off); a check the checks job already marked stale answers `check_stale` first. `reliedOnLinkIds(check)` is shared with the checks job.
- P3-41 `gate:g4:phase3b` runs in the gates job after Phase 3a; it selects sixteen tests by exact name (the eleven of P3-33, the two O-46 refusals, the sweeper back-off and head-of-line tests, and the load test).

## Phase 3c rulings

The auto-confirm materialisation rulings are P3-42 to P3-50 in `docs/superpowers/specs/2026-10-11-phase3c-autoconfirm-design.md`
(each with its reason and cost if wrong). The architecture record is Erratum E-45; O-28 is closed. The deciding value of each:

- P3-42 scope: one job type `d1.autoconfirm`, one scheduled run per firm per PKT day; no route, rules or index change.
- P3-43 schedule `15 2 * * *` Asia/Karachi (`d1AutoConfirmTick`), run key `d1.autoconfirm:YYYY-MM-DD`, label `internal`, `saga: false`. O-43 stays open; a lost tick costs at most one day.
- P3-44 eligibility is the read-time rule: L17.2 on, every key row of the pair an `auto_confirmed` candidate; re-checked in the step's transaction.
- P3-45 per pair: a `merge_events` row (`basis: "auto_confirm"`, `priorState: "candidate"`, actor `system`, `effectiveAt`), rows `confirmed` with `confirmation.auto: true`, `entity.confirmed`; the same shape `confirmMerge` writes.
- P3-46 a materialised pair cannot be disputed (409 `link_not_candidate`) but can be un-merged; E-41(d), P2-28's late dispute and E-43(f) are superseded.
- P3-47 a step that writes bumps the registry version in the same transaction.
- P3-48 at most 2,000 rows read and 480 pairs per run, in fenced steps of 10 pairs.
- P3-49 job label `internal`; event rows carry the pair label.
- P3-50 gate `npm run gate:g4:phase3c` (twenty named tests, 21 d1 routes), its CI step is a follow-up (workflow edits need a token with `workflows` permission).

Open items: O-28 closed. O-43 now applies to a shipped schedule (bounded to one day).

## Phase 3c close-out rulings

P3-51 and P3-52 are in `docs/superpowers/specs/2026-10-11-phase3c-closeout-design.md`; the architecture record is Erratum E-46; O-43 is closed.

- P3-51 scheduled ticks are deployed with `retryCount: 3`, backoff 60 s to 600 s (`SCHEDULE_RETRY`); the runs are idempotent per firm and period.
- P3-52 `gate:g4:phase3c` is to run in CI after the Phase 3b step (workflow edit pending a token with `workflows` permission); its boot step (`p2.boot.test.ts`) now also pins the tick's retry config, so no new gate script.

## Phase 3c auto-confirm fixes

PR #17 shipped the auto-confirm job with a retry that could dead-letter, no audit row, a `priorState` that meant two things, a flag read once per run and untested re-check branches. The close-out rulings are P3-53 to P3-59 in `docs/superpowers/specs/2026-10-10-phase3c-closeout-design.md` (each with its reason and cost if wrong); the architecture record is Erratum E-47 (E-45 amended), and O-50 and O-51 are opened. The deciding value of each:

- P3-53 fenced step ids are positional, `autoconfirm-<n>` for chunk n of the attempt, at most 48 (`AUTO_CONFIRM_MAX_STEPS = MAX_FENCED_STEPS - 2`); a retry reuses the ids and never reaches `fenced_step_limit`; pairs that shift into a committed position wait a day.
- P3-54 one `audit_log` row per materialised pair, in the pair's transaction: actor and `onBehalfOf` `system`, action `entity.confirm`, target `merge_events/<id>`, decision `allow`, reason `auto_confirm`, classification the pair's label.
- P3-55 `priorState: "auto_confirmed"`, the pair's prior effective state, as `confirmMerge` records it; supersedes `"candidate"` in O-28 and E-45(a).
- P3-56 each step's transaction reads `firms/{firmId}` and writes nothing when L17.2 is off; a failed flag read at the start of a run is the retryable `flag_read_failed`, not a run that ends as done.
- P3-57 merge event id `auto_` + the first 32 hex characters of SHA-256 (`firmId`, NUL, `pairId`, NUL, sorted link ids joined by commas), written with `create`; an existing event means the pair is already done.
- P3-58 the in-transaction re-check has four tests in which the scan admits the pair and the transaction must reject it (young sibling for another key, a confirmed row plus an aged candidate, a dispute between scan and step, an un-merge in progress), plus a retry test; all are in the Phase 3c gate.
- P3-59 `gate:g4:phase3c` is a CI step after Phase 3b and selects twenty-nine tests by exact name; E-45 and the 3c dates are corrected (10 October 2026, merged that day); the stale late-dispute comment in `ops.ts` is fixed; `check_pr_phase_claims.py` fails `transport_stub` false while the filing transport stub markers remain.

Open items opened: O-50 (mixed pairs), O-51 (the unused `period` payload field). O-43, O-47, O-48 and O-49 stay open.
