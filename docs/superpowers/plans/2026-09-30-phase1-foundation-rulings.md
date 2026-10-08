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

Phase 2b-A close is Gate G-4 (`npm run gate:g4:phase2b-a`): route coverage (20 routes), boot with every layer flag off,
the two L17.2 invariant tests, and Gate G-2 over all routes.
