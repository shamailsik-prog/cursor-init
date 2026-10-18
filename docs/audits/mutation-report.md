# Mutation testing report: security modules

StrykerJS 10.0.0 with the Vitest runner (`perTest` coverage, related tests
only). Configurations: `stryker.config.mjs` (Next app) and
`functions/stryker.config.mjs` (Cloud Functions, run under the Auth +
Firestore emulators). How to run and what each scope covers:
[README.md](README.md) "Mutation testing". Both configurations fail below a
score of 85 (`thresholds.break`).

The score is (killed + timed out) / (killed + timed out + survived + no
coverage). "Before" is the first full run on `feat/forensic` at 4dd5f6e plus
the tooling commit (no new tests); "After" is a full, non-incremental
(`--force`) run after the test commits. Raw HTML/JSON reports are not
committed (`reports/`, gitignored); CI uploads them as artifacts.

> **Scores below are for the code at 4dd5f6e.** On 7 Oct 2026 this branch was
> merged after the final-audit fixes:
> - The per-route idempotency caches became one `IdempotencyStore` (F4).
> - `persistAuditEntriesSince` was removed in favour of the end-of-request flush (F8).
> - The functions callables were removed (U-1).
> - The Next session and functions auth share `platform/p5/identityPolicy.ts`
>   and `platform/p5/permissionDecision.ts` (SEC-2, I-3).
>
> The tests were adapted to keep targeting the same mutant classes; the
> adaptations and deletions are listed in the commits after the merge. The
> configurations now also mutate:
> - `identityPolicy.ts` and `permissionDecision.ts`;
> - `platform/audit/requestAudit.ts` and `platform/persistence/requestAuditFlush.ts`.
>
> Scope after the merge: Next 23 files / 1972 mutants, functions 13 files /
> 1943 mutants. Both dry runs (`--dryRunOnly`) pass. The tables need a fresh
> full run, which is not yet done (over 2 hours).

## Next app (`npm run mutation`)

| Module | Mutants | Before | After | Killed by new tests | Remaining (survived + no coverage) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `platform/flags/featureFlags.ts` | 37 | 78.4% | 97.3% | 7 | 1 |
| `platform/flags/routeGate.ts` | 78 | 75.6% | 83.3% | 6 | 13 |
| `platform/http/errors.ts` | 12 | 75.0% | 100.0% | 3 | 0 |
| `platform/http/idempotency.ts` | 99 | 64.6% | 85.9% | 21 | 14 |
| `platform/http/publicError.ts` | 2 | 50.0% | 100.0% | 1 | 0 |
| `platform/http/surface.ts` | 106 | 84.9% | 99.1% | 15 | 1 |
| `platform/http/validation.ts` | 141 | 83.0% | 97.9% | 21 | 3 |
| `platform/http/withSession.ts` | 217 | 71.4% | 96.3% | 54 | 8 |
| `platform/p1/providerPolicy.ts` | 83 | 94.0% | 100.0% | 5 | 0 |
| `platform/p1/types.ts` | 13 | 84.6% | 92.3% | 1 | 1 |
| `platform/p5/checkPermission.ts` | 120 | 55.0% | 94.2% | 47 | 7 |
| `platform/p5/committeeScope.ts` | 83 | 57.8% | 97.6% | 33 | 2 |
| `platform/p5/requestSession.ts` | 2 | 100.0% | 100.0% | 0 | 0 |
| `platform/p5/session.ts` | 230 | 60.0% | 97.4% | 86 | 6 |
| `platform/persistence/auditAppendConflictError.ts` | 24 | 62.5% | 100.0% | 9 | 0 |
| `platform/persistence/auditSync.ts` | 7 | 14.3% | 100.0% | 6 | 0 |
| `platform/persistence/auditWriteThrough.ts` | 21 | 66.7% | 95.2% | 6 | 1 |
| `platform/persistence/runtimeRepositories.ts` | 60 | 81.7% | 100.0% | 11 | 0 |
| **All** | 1335 | **70.86%** | **95.73%** | 332 | 57 |

routeGate.ts stays at 83.3%: 11 of its 13 remaining mutants are in the
refusal-dedupe sweep (memory housekeeping that no API exposes, see below);
excluding them it is 97.0%.

## Cloud Functions (`npm run mutation:functions`)

| Module | Mutants | Before | After | Killed by new tests | Remaining (survived + no coverage) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `src/http/errors.ts` | 35 | 85.7% | 100.0% | 5 | 0 |
| `src/http/headers.ts` | 7 | 100.0% | 100.0% | 0 | 0 |
| `src/http/idempotency.ts` | 249 | 78.3% | 90.0% | 29 | 25 |
| `src/http/rateLimit.ts` | 97 | 76.3% | 94.8% | 18 | 5 |
| `src/http/router.ts` | 223 | 79.8% | 89.2% | 21 | 24 |
| `src/p5/audit.ts` | 6 | 100.0% | 100.0% | 0 | 0 |
| `src/p5/auth.ts` | 225 | 80.4% | 92.0% | 26 | 18 |
| `src/p5/classification.ts` | 17 | 76.5% | 88.2% | 2 | 2 |
| `src/p5/common.ts` | 163 | 86.5% | 99.4% | 21 | 1 |
| `src/p5/gates.ts` | 133 | 87.2% | 95.5% | 11 | 6 |
| `src/p5/identity.ts` | 499 | 79.4% | 81.6% | 11 | 92 |
| `src/p5/mfa.ts` | 380 | 84.9% | 86.6% | 9 | 51 |
| `src/p5/permission.ts` | 153 | 81.7% | 95.4% | 21 | 7 |
| **All** | 2187 | **81.48%** | **89.44%** | 174 | 231 |

"After" for functions is a full run (`--force` equivalent: no incremental
file) on c122c46, which Stryker completed and saved (its incremental results
cover 2186 of the 2187 mutants) before the job hit a 2-hour background limit
while writing the HTML report, followed by incremental re-runs after each
later test commit (after 25f6cfd: 319 mutants re-tested; after 8df8faf and
b734d06: 988). The
baseline counted 2184 mutants (three were not recorded by the first run).

identity.ts stays at 81.6%. Its remaining survivors are listed below by
kind: none is on an authorisation decision that a sequential test can reach
and that is not already asserted; the gap is mostly defence-in-depth checks
on values the same transaction built, concurrency-only paths, and fault
injection after commit. It is the main functions-side follow-up.

Two existing concurrency tests are timing-sensitive under Stryker's
instrumented single-thread runner and failed one dry run each (re-run
passed): `p5.mfa.test.ts` "the attempt cap holds under concurrency: 30
parallel wrong codes" (15 s timeout) and `p5.identity.test.ts`
"two concurrent calls on one target are serialised". Both pass in plain
`npm --prefix functions run test:emu` runs.

## Document vault (`npm run mutation:documents`, per PR)

Audit FA-D16-002 (v2 audit): the F03 integrity checks were never exercised;
`documentObjectStore.ts` scored 57.65 %, with the content-hash, key-length and
format-version checks uncovered. Configuration: `stryker.documents.config.mjs`
(the Next configuration, narrowed) with `vitest.stryker.documents.config.ts`,
which runs only the four F03 unit suites. Those suites need neither emulator
nor MinIO: the fault proxy in `tests/helpers/s3-document-vault.ts` serves an
in-memory S3 and injects hangs, hostile errors, lost PUTs and oversized
bodies. Non-incremental, break 85, run per PR by Gate G-0 ("Mutation floor
(document vault)"), because `mutation.yml` is disabled in the repository
settings.

| Module | Mutants | Before (main 62d1d66, main's tests) | After (PR #47) | Remaining (survived + no coverage) |
| --- | ---: | ---: | ---: | ---: |
| `platform/documents/documentObjectStore.ts` | 196 → 361 | 57.65% | 96.40% | 13 |
| `platform/documents/documentObjectS3.ts` | (new) 467 | - | 93.36% | 31 |
| **All** | 828 | **57.65%** | **94.69%** | 44 |

Before: 113 killed, 54 survived, 29 no coverage. The hash, key and version
checks (main's lines 47, 93 and 112) were among the uncovered and surviving
mutants. After: 780 killed, 4 timed out, 33 survived, 11 no coverage; every
mutant on those three checks, and on the new one-byte-repeated key check, is
killed. The mutant count grew because the store gained the S3 backend
selection and production rules, and the S3 adapter is new.

Remaining mutants, by kind (all checked by hand):

| Location | Mutant | Why it is equivalent / unkillable |
| --- | --- | --- |
| documentObjectS3.ts:214 | client cache bypassed | A new client per call behaves the same; only cost differs. |
| documentObjectS3.ts:247, 294 | one `typeof` guard dropped | `Number.isInteger` / the code regex reject a non-number / non-string anyway. |
| documentObjectS3.ts:317-318 | no `clearTimeout` | The timer then aborts a controller whose call has already finished: no effect. |
| documentObjectS3.ts:334-335 (5) | `if (!body)` | Unreachable: the SDK returns a body stream for every 200 GET. |
| documentObjectS3.ts:338 | `typeof ContentLength` guard dropped | `undefined > cap` is false. |
| documentObjectS3.ts:339, 351, 343 | `body.destroy?.()` to `body.destroy()` | The SDK body always has `destroy`. |
| documentObjectS3.ts:343-344, 356-359 (9) | our own abort listener on the body, and the post-loop abort check | The SDK destroys the request, and so the body, when the same signal aborts; ours is a second guard. A stalled body is still cut at the deadline (asserted). |
| documentObjectS3.ts:373 | `ContentType` to `""` | The SDK then sends `application/octet-stream` itself (asserted on the wire). |
| documentObjectS3.ts:411, 420-421 (5) | settle-loop boundaries (`<=` to `<`, the bottom break) | At most one extra poll interval inside the budget; the budget assertions allow it. |
| documentObjectS3.ts:452 | `httpStatus !== null` to `true` | `null >= 500` is false. |
| documentObjectS3.ts:70 | `?.trim()` on the backend name | Killable (backend unset while the SSE mode is resolved); not exercised. Accepted. |
| documentObjectStore.ts:178 | hook flag initialised `true` | Every test resets the hooks before use. |
| documentObjectStore.ts:223-224 (5) | path-escape check | Unreachable: every segment already passed `SAFE_SEGMENT`. Kept as defence in depth. |
| documentObjectStore.ts:280-282 (4) | production branch of the rollback delete for a non-s3 path | Unreachable: in production every object path is `s3://`, and the rollback deletes the path the same call built. |
| documentObjectStore.ts:330-331 (3) | byte comparison after the hash check | Equal firm-keyed hashes imply equal bytes; kept as a direct check. |

Runtime: 13 to 26 minutes on 4 shared cores (load 10 to 20), 3 workers;
the dry run is 62 tests in 9 seconds. With `related: true` every static mutant
ran the whole unit suite (2162 tests, 208 static mutants, 97 % of the time),
which is why the vault run lists its suites instead.

## Tests added to kill survivors

| Commit | File | Kills |
| --- | --- | --- |
| 49b2b39 | `tests/p5.checkPermission.decision-table.test.ts` | checkPermission: every branch with its exact reason; a cross-firm matter that *has* a membership row isolates the firm check from the membership check behind it; clearance at the boundary; list_matters answered before matter checks; own_matters scope for staff; seedUser refusal. |
| 49b2b39 | `tests/p5.committeeScope.test.ts` | committeeScope (no direct tests before): store-vs-repository hydration, max-of-labels with unreadable labels as privileged-restricted, document/matter binding, 404/403 codes and messages, party names only from the actor's firm. |
| 49b2b39 | `tests/p5.session.resolution.test.ts` | session: auth-mode parsing, hosted-runtime markers, warn-once, firebase-admin init (project id and credential choice, reuse, retry after failure), Bearer grammar, uid / firm claim / X-Firm-Id checks, role-claim warning, clearance restriction, loadUserRecord authoritative vs cached paths. |
| a662f8f | `tests/http.withSession.boundary.test.ts` | withSession: AuthError mapping and message hygiene, body read (empty / non-JSON / null / array / string), raw body untouched, body userId binding, 413 limit naming, declared-surface refusal, 500 log line, insecure-dev identity claims; errors / PublicError helpers. |
| a662f8f | `tests/http.validation-idempotency-surface.test.ts` | validation caps and stream errors, leading-only BOM strip, base64 anchoring; UUID v4 anchoring, TTL boundary, eviction by write time; defineSurface refusals and the surface selectors. |
| cc19be2 | `tests/flags-p1-persistence.security-gaps.test.ts` | flag registry metadata and env "false"; refusal audit row and its one-minute dedupe boundary; P1 guard messages and the production refusal of the provider-table override; auditRowsEqual, syncFirmAudit, persistAuditEntriesSince; runtimeRepositories configuration errors and firestore mode. |
| 1e833e0 | `functions/test/p5.http.guards.test.ts` | toHttpsError table; classification/role/second-factor guards; isSafeDocId at 128/129 and reserved-id anchoring; target clearance ceiling; CallAudit one-row-per-call and failure paths; runAudited; limitFor's 1..1000 window; isStorableResult at 199/200/299/300; canonicalJson; router shape checks. |
| b734d06 | `functions/test/p5.mfa.test.ts` (new block) | disableMfa re-checks the approver at use: moved firm, demoted, deactivated, cleared below the subject, unreadable clearance; exact-level approver; approval for another subject or expiring now. |
| 1e833e0, c122c46, later | `functions/test/p5.security-gaps.emu.test.ts` | checkPermission's decision and audit row (target, classification) per branch; Bearer anchoring; revoked-token subject; verified email only; rate-limit refusal and counter TTL; anonymous IP key sanitising; setUserClaims refusing a target whose Auth claims name another firm; claimsVersion fallbacks; email parsing at 254 chars; gate evidence validation and merge; checkRevoked asserted on the Admin SDK call (the emulator rejects revoked tokens even without it); idempotency claim boundaries. |

## Real bugs found

None. No surviving mutant exposed a behaviour that is wrong today; every
survivor on a security-relevant line was a missing assertion (killed by the
tests above) or is listed below as equivalent or unreachable. Two findings are
worth recording as design notes, not bugs:

- `platform/p5/checkPermission.ts:50-51` (and the same branch in
  `functions/src/p5/permission.ts:102`): the `client-research-denied` branch
  is unreachable, because every client `research` request is already denied
  as `client-channel-denied`. Kept as defence in depth.
- `functions/src/p5/identity.ts` setUserClaims / deactivateUser: the
  `last_partner` check can only fire under concurrent demotions (the caller is
  itself an active partner other than the target), so its mutants are not
  killable by a sequential test.

## Equivalent and unobservable mutants

Mutants that cannot change observable behaviour (equivalent), or that only
change behaviour no public API exposes. One line each.

### Next app

| Location | Mutant | Why it is equivalent / unkillable |
| --- | --- | --- |
| p5/checkPermission.ts:50-51 (7) | client-research branch | Unreachable: a client's `research` returns `client-channel-denied` at line 25. |
| p5/committeeScope.ts:40 | `>` to `>=` | Equal ranks are the same label; the result is identical. |
| p5/committeeScope.ts:61 | default action `"committee_brain"` to `""` | checkPermission treats both as an ordinary action. |
| p5/session.ts:168 | drop `if (!header) return null` | `exec(null)` coerces to `"null"`, which never matches the Bearer regex. |
| p5/session.ts:169 | `\s*$` to `\S*$` | `Headers` trims values, so no trailing whitespace reaches the regex. |
| p5/session.ts:205 | `if (preferRepository)` to `true` | Reached without preferRepository only when nothing is cached, so evicting is a no-op and both return null. |
| p5/session.ts:215 | `<=` to `<` | Equal ranks are the same label. |
| p5/session.ts:250 | drop `typeof role === "string"` | `Set.has` of a non-string is false anyway. |
| p5/session.ts:263 | drop `.trim()` | `Headers` already trims header values. |
| p1/types.ts:20 | drop `typeof value === "string"` | `Set.has` of a non-string is false anyway. |
| flags/featureFlags.ts:53 | empty `firmOverride` body | The stub already returns undefined. |
| flags/routeGate.ts:36 | `until !== undefined` to `true` | `undefined > now` is false. |
| flags/routeGate.ts:37-38 (11) | refusal-dedupe sweep | Only bounds the in-memory map; no API exposes its size (killing needs a test hook). |
| flags/routeGate.ts:110-111 | null-safe `?.action`, empty `catch` | Both paths leave `action` undefined, the same answer. |
| http/idempotency.ts:53-54, 67-69 (10) | TTL re-check in get / getReplay | `prune()` runs first and already removed every expired entry; the branch is unreachable. |
| http/idempotency.ts:94 (2) | eviction early return | With size <= max the eviction loop drops 0 entries. |
| http/idempotency.ts:98-99 | `ordered[i]?.[0]`, `if (key)` | `i < drop <= size`; keys are UUID v4, never empty. |
| http/surface.ts:111 | drop `typeof raw === "string"` | `includes` of a non-string is false. |
| http/validation.ts:17 | drop `if (!raw)` | `Number("")` is 0, which falls back to the default anyway. |
| http/validation.ts:77 | `?? ""` fallback text | `Number` of either is non-finite or 0; neither exceeds a cap. |
| http/validation.ts:158 | `\s+` to `\s` | With the `g` flag both remove all whitespace. |
| http/withSession.ts:116, 122, 158 | `parsedOk` for no / empty body | Nothing is parsed, so nothing is attached or bound either way. |
| http/withSession.ts:139 | default `mutated = false` | Every call passes it explicitly. |
| http/withSession.ts:173 | default subject list | Only differs for a query key literally named "Stryker was here". |
| http/withSession.ts:185 | always set identity params | Present values already equal the session (mismatch returned earlier). |
| http/withSession.ts:207 | empty `catch` in describe() | `new URL(request.url)` cannot throw for a constructed Request. |
| http/withSession.ts:216 | drop `parsed &&` | Only null differs, and JSON null never reaches here with an identity. |
| persistence/auditWriteThrough.ts:19 | `<` to `<=` | The extra index is a hole and is skipped. |

### Cloud Functions

| Location | Mutant | Why it is equivalent / unkillable |
| --- | --- | --- |
| p5/permission.ts:102 (8) | client-research branch | Unreachable: a client's `research` is denied `client-channel-denied` at line 77. |
| p5/permission.ts:31 | `"store-unavailable"` reason text | Fault path (Firestore read error); the deny itself is asserted, the reason text is not. Accepted. |
| p5/classification.ts:9, 15 (3) | `typeof` guards | `Object.hasOwn` of a non-string label is false; a known label's rank is always an integer, an unknown one is `undefined` and fails `Number.isInteger` anyway. |
| p5/auth.ts:26 | `typeof` guard in isRole | `Set.has` of a non-string is false. |
| p5/auth.ts:73 (9), 72, 74 | tokenSubject bounds | Only called after the Admin SDK verified the token (revoked / disabled): its `sub` is always a non-empty uid of at most 128 characters. |
| p5/auth.ts:85 | `?? ""` fallback text | No Authorization header fails the Bearer regex either way. |
| p5/auth.ts:90 | `err?.code` | The Admin SDK never throws null. |
| p5/auth.ts:161-162 | store_unavailable on a failed users/firms read | Fault path; needs a Firestore fault injected inside getAll. Accepted. |
| p5/auth.ts:170 | `<` to `<=` | Equal ranks are the same label. |
| p5/common.ts:192 | `{ now }` dropped for firmless rate limits | Only the pinned test clock differs; real calls use Date.now either way. |
| p5/gates.ts:50-51, 55, 75 | URL / record / count type guards | `new URL` of a JSON value either parses or throws into the same refusal; `Number.isInteger` rejects non-numbers. |
| p5/gates.ts:114 | `audit.committed()` dropped | Nothing can fail after commit in recordGatePass, so no second (deny) row is ever attempted. |
| http/idempotency.ts:25-26 (5) | import-time lease/timeout assertion | Holds for the pinned constants (5 min > 120 s); asserted by `http.test.ts`. |
| http/idempotency.ts:51, 60, 102 | `typeof` guards | `Set.has` / `RegExp.test` / `typeof` of non-matching values already fail. |
| http/idempotency.ts:154 | `{ kind: "claimed" }` | An object without a kind falls through to the same "run the handler" path. |
| http/idempotency.ts:174 | `< 300` to `<= 300` | No handler returns 300. |
| http/idempotency.ts:156-158, 167, 192-205 | store failure and settle retries | Fault paths (transaction failure, retry count and backoff); the retry itself is covered by "settle is retried", the exact count and backoff are not. Accepted. |
| http/rateLimit.ts:68, 86 | `typeof` guard, `data()?.count` | `Number.isInteger` rejects non-numbers; the counter doc always exists right after `set`. |
| http/rateLimit.ts:87-89 | store failure | Fault path. Accepted. |
| http/router.ts:103 | `path.length > 1` | "/" trimmed or not routes to "/api" (404) either way. |
| http/router.ts:136, 146, 241-243 | AuthFailure text, non-HttpError auth failure, 500 path | Need a non-HttpError thrown inside authentication; not reachable through the Admin SDK. Accepted. |
| http/router.ts:165 | idempotency refusal audit | Only differs for an HttpError other than the three refusals thrown by withIdempotency (store_unavailable), a fault path. |
| http/router.ts:179, 189 (7) | firm / firmless consistency guards | The route table pairs every operation with its own auth kind; the guard is defence in depth. |
| http/router.ts:211, 226, 229 | rawBody fallback, firm override for firmless routes, `_nofirm` prefix | rawBody is always set by the runtime; firmless sessions carry no firm doc; the `_nofirm` prefix is asserted at withIdempotency level. |
| p5/identity.ts (about 90) | see below | Defence in depth on values the transaction itself built (`checkedResult`, `claimsMatch`), `last_partner` checks that can only fire under concurrent demotions (the caller is itself an active partner other than the target), the claims-sync revert / re-sync recovery paths (need Auth failures injected after commit), bootstrap-founder environment parsing, and the default audit target labels of early refusals (not asserted). |
| p5/mfa.ts (about 55) | see below | Crockford encoding tail bits of generated codes (output is random; format asserted by CODE_RE), the import-time normalised-code regex, recovery-code hash comparison guards on malformed stored hashes, partial-factor removal bookkeeping, resume paths after a failed post-commit step, and the default audit target labels of early refusals. |

## Timeouts

A mutant that makes a test hang until Stryker's timeout counts as detected.
The final Next run had 19, mostly in identity binding (`withSession.ts`
190-201) and in `auditRowsEqual`'s recursion (`auditAppendConflictError.ts`
18-21), where the mutated code does not return within the timeout; the functions
run had 6, all loops that no longer terminate (idempotency settle retry loop, the claims-sync retry loop in identity.ts, the recovery-code encoder loop in mfa.ts). The incremental runs before them reported most of
the same mutants as killed outright.

## Runtime

Measured on 4 cores, 15 GB:

| Run | Mutants | Wall time |
| --- | ---: | ---: |
| Next, first full run (3 workers) | 1335 | 83 min |
| Next, final full run (3 workers) | 1335 | 50 min |
| functions, first full run (3 workers, 3 emulator sets) | 2187 | about 60 min |
| functions, final full run (3 workers, 3 emulator sets) | 2187 | about 70 min |
| Incremental re-run after a test change | 185 to 988 re-tested | 8 to 26 min |

This is why `.github/workflows/mutation.yml` runs weekly and on demand, not
per PR.

## Scope notes

- `platform/audit/**` does not exist; the audit write path is
  `platform/persistence/audit*.ts`, mutated here.
- `platform/p5/tenancyAdmin.ts` (2.7k lines of admin orchestration whose
  authorisation goes through checkPermission) is not in this run; adding it
  would roughly double the Next runtime. It is the main remaining gap.
- The functions run mutates every file in `functions/src/p5/**` and
  `functions/src/http/**` with the full emulator suites (not only the pure
  modules), one independent emulator set per Stryker worker.
- Static mutants (code that runs at import) are re-tested only on a full run;
  incremental runs reuse their earlier result. Use `--force` (or delete the
  incremental file) before quoting scores.
