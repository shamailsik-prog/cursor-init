# Phase 3a P2 Job Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The P2 Job Engine in Cloud Functions: a `jobs` collection written by transactional enqueue, a Firestore-trigger → Cloud Tasks → worker runtime with leases, fencing, 1s/5s/25s retries and a dead-letter state, a sweeper, the `events` fan-out, the scheduled-job primitive, four `/api/platform/jobs/*` routes, lint for `functions/`, a registry-version write recorder, and the G-4 Phase 3a gate.

**Architecture:** Pure units (`constants`, `errors`, `view`, `periodKey`) under unit tests; Firestore cores (`enqueueJobs`, `runJobTask`, `sweep`, `fanOutEvent`, `enqueueScheduledRuns`) that take an injected `JobDeps` (dispatcher, clock, alert, handler budget) and are driven by emulator tests through an in-process dispatcher; thin `firebase-functions` wrappers (`onJobCreated`, `jobWorker`, `jobSweeper`, `onEventCreated`) exported from `index.ts`; HTTP operations in the existing `FirmOperation` shape registered in `http/router.ts`; permissions in the shared table `platform/p5/permissionDecision.ts`.

**Tech Stack:** TypeScript, firebase-functions 6.6.0 (`v2/firestore`, `v2/tasks`, `v2/scheduler`; asia-south1), firebase-admin 13 (`firebase-admin/functions` task queue), Firestore + Auth emulators, vitest 3, `@firebase/rules-unit-testing`, ESLint 9 flat config, pytest (gate checker only).

**Spec:** `docs/superpowers/specs/2026-10-08-phase3a-job-engine-design.md` (rulings P3-1..P3-23, §7 testing, §8 Review Focus, Appendix A: E-42, O-30..O-35). Conventions follow the Phase 2b-A plan `docs/superpowers/plans/2026-10-08-phase2b-entity-review.md`. Architecture: `docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt` (P2 L981-999; L18 §4.1 L8142-8148, §4.2 L8150-8151, §5.2 L8289-8291, events L8202, §7.5 L8413).

**Task boundaries (vs. the requested a-h order).** Nine tasks. Two changes, both forced by the spec's structure: (1) the `JobDispatcher` interface and the in-process test dispatcher move from the dispatch task into the worker task (Task 3), because the worker's retry transition dispatches after commit (P3-7) and gate invariants 1 and 3 are driven through that dispatcher; the Cloud Tasks implementation, the trigger and the sweeper stay in Task 4. (2) The scheduled-job primitive (P3-16) is not in a-h; it is its own task (Task 6) because it has its own suite, build entry, CLI and README, and a reviewer can reject it while approving the fan-out.

## Global Constraints

- Region `asia-south1` for every function (`REGION` from `functions/src/health.ts`, passed explicitly in each wrapper as `api` does). No new runtime dependency; the only new devDependency is `globals` (root, P3-19). Task queue API: `getFunctions(adminApp()).taskQueue("locations/asia-south1/functions/jobWorker")` from `firebase-admin/functions`.
- Pinned values (`functions/src/p2/constants.ts`): `MAX_ATTEMPTS = 4`, `MAX_MANUAL_RETRIES = 3`, `RETRY_DELAYS_MS = [1000, 5000, 25000]`, `JOB_LEASE_MS = 600_000`, `JOB_WORKER_TIMEOUT_SECONDS = 300`, `JOB_HANDLER_BUDGET_MS = 240_000`, `DISPATCH_GRACE_MS = 30_000`, `CLOCK_SKEW_TOLERANCE_MS = 2_000`, `MAX_CLOCK_SKEW_MS = 300_000`, `SWEEP_LIMIT = 100`, `MAX_PAYLOAD_BYTES = 16_384`, `MAX_LOG_ENTRIES = 50`, `MAX_REFS = 20`. Worker queue: `retryConfig { maxAttempts: 3, minBackoffSeconds: 10, maxBackoffSeconds: 60 }`, `rateLimits { maxConcurrentDispatches: 10, maxDispatchesPerSecond: 5 }`. Sweeper schedule `"every 1 minutes"`. Scheduled jobs `timeZone: "Asia/Karachi"`.
- Every job time field is `Timestamp.fromMillis(deps.clock())` (or the router's `session.now`), never `serverTimestamp()`. (`appendAudit`'s own `occurredAt` is unchanged.)
- No payload value leaves the job row: task bodies are `{ jobId, seq }`; `lastError`, `logs`, events, audit `reason`, alerts, logger fields and API views carry codes and fixed messages only (`sanitizeError`, P3-9). Logging follows `functions/src/log.ts` (`logFailure`: code only).
- After-commit dispatch failures (worker retry, API retry, trigger) are logged with `logFailure("job dispatch failed", err)` and swallowed: the sweeper re-dispatches after 30 s. The API still answers 200.
- Routes: `/api/platform/jobs/{listJobs,getJob,retryFailedJob,cancelJob}`, Bearer + X-Firm-Id, POSTs carry Idempotency-Key, rate kind `general`, one CallAudit row per call through `runAudited`; no layer flag (P2 is CORE). Errors `{ error: { code } }` via `HttpError`, codes exactly as spec §6.
- **Every new `/api` route needs, in the task that adds it: a `viaApi("<name>")` test, a G-2 `PROBES` entry and its module in `HANDLER_MODULES` (`functions/test/g2.cross-firm.test.ts`). A GET probe uses `target: true` wherever it can name a firm-A id, and the G-2 positive control reads it as firm A's own partner.** Every new deployed export goes in that file's `NOT_TENANT_ENDPOINTS` with a reason, in the task that exports it.
- Emulator-only test files under `tests/` must be listed in the root `vitest.config.ts` exclude list (the root unit job runs `tests/**`); this plan adds rules tests only to the already-excluded `tests/firestore.rules.test.ts`. Functions emulator suites use `describe.skipIf(!EMULATORS)`.
- Commands. Functions unit: `cd functions && npx vitest run <files>`. Functions emulator: `npx firebase emulators:exec --only auth,firestore --project demo-sikander "cd functions && npx vitest run <files>"`. Full functions: `npm --prefix functions run test:emu`. Typecheck: `cd functions && npx tsc --noEmit` and `npm run typecheck`. Rules: `npm run test:rules`. Lint: `npm run lint`.
- Never skip, disable or weaken a test to get green; never relax an existing assertion.
- Commit messages end with exactly these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01DtzafHsrLji6x2SM4jCSWT`

### Data shapes

```ts
// jobs/{jobId}   jobId = "j" + sha256(`${firmId}\0${jobType}\0${idempotencyKey}`).hex.slice(0, 40)
type JobRow = {
  engine: "p2"; schemaVersion: 1; firmId: string; jobType: string; classification: Classification;
  matterId: string | null; payload: Record<string, unknown>; payloadHash: string /* sha256 hex of canonicalJson(payload) */;
  inputRefs: string[]; outputRefs: string[] /* "collection/id", ≤ 20 */; idempotencyKey: string; runKey: string | null;
  status: "queued" | "running" | "failed" | "done" | "dead_lettered" | "cancelled";
  attempts: number /* 0-4, this round */; totalAttempts: number; maxAttempts: 4; manualRetries: number /* 0-3 */;
  nextAttemptAt: Timestamp | null; lease: { owner: string; expiresAt: Timestamp } | null;
  dispatchSeq: number; dispatchedAt: Timestamp; traceId: string /* randomUUID */;
  lastError: { code: string; message: string } | null;
  logs: Array<{ at: Timestamp; event: JobLogEvent; attempt: number; code?: string }> /* ≤ 50, oldest dropped */;
  createdBy: string /* uid | "system" */; requeues: Array<{ by: string; role: string; at: Timestamp; note: string }>;
  cancellation: { by: string; role: string; at: Timestamp; note: string } | null;
  createdAt: Timestamp; updatedAt: Timestamp; startedAt: Timestamp | null; finishedAt: Timestamp | null }
type JobLogEvent = "enqueued" | "claimed" | "reclaimed" | "done" | "failed" | "dead_lettered" | "requeued" | "cancelled"

// events/{jobId}_failed_{totalAttempts}  and  events/{jobId}_deadLettered_{manualRetries}
{ name: "job.failed" | "job.deadLettered", firmId, classification /* the job's */, occurredAt: Timestamp,
  idempotencyKey: /* = the doc id */, payload: { jobId, jobType, attempts: totalAttempts, error: code } }

// audit_log (system path, P3-18): { firmId, actorId: "system", onBehalfOf: createdBy, action, target: "jobs/<id>",
//   classification /* the job's; unknown → "privileged-restricted" */, decision: "allow", reason }
type JobAuditAction = "job.enqueue" | "job.start" | "job.done" | "job.fail" | "job.dead_letter"

// API view (spec §3)
type JobView = { jobId; jobType; status; matterId: string | null /* or "restricted" */; classification; attempts; maxAttempts;
  totalAttempts; manualRetries; maxManualRetries; nextAttemptAt; createdAt; updatedAt; startedAt; finishedAt /* ISO | null */;
  createdBy; traceId; runKey; lastError; retryable: boolean; cancellable: boolean;
  inputRefs?; outputRefs?; logs?: Array<{ at: string; event; attempt; code? }> /* full only; logs in getJob only */ }
```

## Review Focus

The spec's five (§8), each pinned to the task that owns the code:

1. **Duplicate delivery** (two deliveries in parallel, a third after `done`, a duplicate trigger): one claim, counter 1, `attempts` 1, one `job.done` audit row, one task `j…-0`. Pinned: Task 3 invariant 1; Task 4 duplicate-trigger test.
2. **Lease expiry mid-handler** (a frozen worker resumes after a second worker took over): the stale commit and its `apply` write nothing; one `job.lease_lost` log; `runFenced` after loss writes nothing. Pinned: Task 4 invariant 2; Task 3 `runFenced` test.
3. **Clock-skew retry storm** (early deliveries, sweeps at skewed clocks, twenty sweeps in a row): ≤ 1 dispatch per job per sweep, never within 30 s of the last, no fifth attempt, dead-letter at 4. Pinned: Task 4 invariant 5.
4. **Cross-firm read or retry; one key in two firms**: 404 with X-Firm-Id B, 403 `firm_mismatch` with X-Firm-Id A, two job ids for one key, SDK cannot read engine rows. Pinned: Task 7 cross-firm test, G-2 probes and rules tests; Task 2 invariant 4.
5. **Poison payload in error text**: the marker never reaches `lastError`, `logs`, events, audit, alerts, the logger, or the API. Pinned: Task 7 poison test (and Task 2's `sanitizeError` unit).

---

### Task 1: Lint `functions/` and fix the one warning (P3-19)

**Files:**
- Modify: `eslint.config.mjs:1-34` (replace the `functions/**` ignore; add the functions block)
- Modify: `package.json:41-60` (devDependency `"globals": "^14.0.0"`), `package-lock.json` (via `npm install -D globals@^14.0.0`)
- Modify: `functions/src/p5/identity.ts:381` (delete the unused `const userRef = usersRef().doc(uid)`)
- Modify: `.github/workflows/gate-g0.yml:41-46` (lint-typecheck job: `- run: npm --prefix functions ci` after `npm ci`, before Lint)

**Interfaces:**
- Produces: `npm run lint` and `npx eslint --max-warnings 0 functions` cover `functions/**/*.{ts,mjs}` except `functions/lib/**`, `functions/node_modules/**`, `functions/.stryker-tmp/**`. Every later task's files are linted.

- [ ] **Step 1: Record the failing check.** Run `npx eslint --max-warnings 0 functions`. Expected: non-zero exit, "All files matched by 'functions' are ignored."
- [ ] **Step 2: Implement the config.** `globalIgnores`: drop `"functions/**"`, add `"functions/lib/**"`, `"functions/node_modules/**"`, `"functions/.stryker-tmp/**"`. Append, after the existing rules block:

```js
import globals from "globals";
const NEXT_ONLY = /^(@next\/next|react|react-hooks|jsx-a11y)\//;
const offForFunctions = Object.fromEntries(
  [...nextVitals, ...nextTs].flatMap((c) => Object.keys(c.rules ?? {})).filter((k) => NEXT_ONLY.test(k)).map((k) => [k, "off"])
);
// block: { files: ["functions/**/*.{ts,mjs}"], languageOptions: { globals: globals.node }, rules: offForFunctions }
```

- [ ] **Step 3: Run** `npx eslint --max-warnings 0 functions`. Expected: exit 1 with exactly one problem, `'userRef' is assigned a value but never used` at `functions/src/p5/identity.ts:381`. Any other finding is fixed in this step without changing behaviour (the spec measured 0 errors, 1 warning).
- [ ] **Step 4: Remove line 381.** Run `npx eslint --max-warnings 0 functions` → exit 0, 0 problems; `npx eslint --print-config functions/src/index.ts | node -e 'const c=JSON.parse(require("fs").readFileSync(0));const bad=Object.entries(c.rules).filter(([k,v])=>/^(@next\/next|react|react-hooks|jsx-a11y)\//.test(k)&&!(v===0||v[0]===0||v==="off"||v[0]==="off"));process.exit(bad.length?1:0)'` → exit 0; `npm run lint` → exit 0; `cd functions && npx tsc --noEmit` and `npm run typecheck` → pass; `npm --prefix functions run test:emu` → pass (identity unchanged).
- [ ] **Step 5: Commit** `chore(lint): lint functions/ with the root config; drop the unused userRef (P3-19)`.

### Task 2: Jobs model, transactional enqueue, handler registry, diagnostic type, system audit

**Files:**
- Create: `functions/src/p2/constants.ts`, `functions/src/p2/errors.ts`, `functions/src/p2/registry.ts`, `functions/src/p2/diagnostic.ts`, `functions/src/p2/enqueue.ts`, `functions/src/p2/audit.ts`
- Modify: `functions/src/p5/audit.ts:5-13` (`AuditRow.onBehalfOf?: string`), `functions/src/p5/common.ts:141` (`Session` gains `idempotencyKey?: string`), `functions/src/http/router.ts:230-235,289` (`execute(op, auth, body, now, idempotencyKey)`; for POST/PUT pass `header(headers, "idempotency-key")` into the session; GET passes none)
- Create tests: `functions/test/p2.engine.test.ts` (unit), `functions/test/jobs.ts` (helpers), `functions/test/p2.jobs-enqueue.emu.test.ts`, `functions/test/p2.jobs-invariants.emu.test.ts` (suite `"P2 job engine invariants (P3-4, P3-6..P3-8)"`, invariant 4)

**Interfaces:**
- Produces (`constants.ts`): the Global Constraints values; `JOB_STATUSES` (the six, in P3-3 order) and `type JobStatus`; `JOB_ENGINE = "p2"`, `JOB_SCHEMA_VERSION = 1`; `assertJobTimings(leaseMs: number, timeoutSeconds: number, budgetMs: number): void` — throws `/lease/` unless `leaseMs >= timeoutSeconds * 1000 + 60_000`, throws `/budget/` unless `budgetMs < timeoutSeconds * 1000`; called at module load with the constants.
- Produces (`errors.ts`): `class JobError extends Error { readonly code: string; readonly permanent: boolean; constructor(code: string, opts?: { permanent?: boolean }) }` (its `message` is the code). `ENGINE_CODES = ["invalid_payload", "unknown_job_type", "handler_timeout", "lease_expired", "store_unavailable", "internal"] as const`. `JOB_ERROR_MESSAGES`: invalid_payload "The job's payload is invalid.", unknown_job_type "The job type is not registered.", handler_timeout "The job exceeded its time budget.", lease_expired "The job's worker stopped before finishing.", store_unavailable "The data store was unavailable.", internal "The job failed with an internal error.". `type SanitizedError = { code: string; message: string; permanent: boolean }`. `sanitizeError(err: unknown, handler?: Pick<JobHandler, "errorCodes">): SanitizedError` — a `JobError` whose code matches `^[a-z][a-z0-9_]{0,63}$` and is an engine code or a key of `handler.errorCodes` keeps it, message from the table (handler codes from `errorCodes`); `invalid_payload` and `unknown_job_type` are always permanent, others take `err.permanent`; an error with a numeric `code` in 1..16 (gRPC status) → `store_unavailable`, not permanent; anything else → `internal`, not permanent. `class LeaseLostError extends Error` (thrown by `runFenced`, Task 3).
- Produces (`registry.ts`): `type JobContext<P> = { job: { id: string; firmId: string; jobType: string; classification: Classification; matterId: string | null; attempt: number; totalAttempts: number; traceId: string }; payload: P; now(): number; runFenced<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> }`; `type JobResult = { apply?: (tx: Transaction) => void; outputRefs?: string[] }`; `type JobHandler<P = unknown> = { jobType: string; saga: boolean; errorCodes: Readonly<Record<string, string>>; parse(payload: unknown): P; run(ctx: JobContext<P>): Promise<JobResult> }`; `JOB_HANDLERS: ReadonlyMap<string, JobHandler>` = `platform.diagnostic` only; `jobTestSeam: { handlers: Map<string, JobHandler> }` (Task 5 adds `subscribers`); `handlerFor(jobType: string): JobHandler | undefined` (production map first, then the seam).
- Produces (`diagnostic.ts`): `type DiagnosticPayload = { behaviour: "succeed" | "fail_times" | "throw_raw" | "permanent" | "hang"; failTimes?: number; marker?: string }`; `diagnosticHandler: JobHandler<DiagnosticPayload>` (`saga: false`, `errorCodes: { diag_failure: "Diagnostic failure (planned).", diag_permanent: "Diagnostic permanent failure (planned)." }`); `parse` rejects (permanent `invalid_payload`) an unknown behaviour, an extra key, `failTimes` absent for `fail_times` or not an integer 1-4, `marker` not a string or longer than 64. `run`: `succeed` → `apply` stages `tx.set(diagnosticCounterRef(firmId, jobId), { firmId, kind: "jobdiag", jobId, classification: "internal", count: FieldValue.increment(1) }, { merge: true })`; `fail_times` throws `new JobError("diag_failure")` while `ctx.job.totalAttempts <= failTimes`, else as `succeed`; `throw_raw` throws `new Error(\`diagnostic raw failure ${marker}\`)`; `permanent` throws `new JobError("diag_permanent", { permanent: true })`; `hang` awaits an unref'd timer of `JOB_LEASE_MS`. `diagnosticCounterRef(firmId, jobId)` = `counters/${firmId}_jobdiag_${jobId}`.
- Produces (`enqueue.ts`): `type JobSpec = { firmId: string; jobType: string; classification: Classification; matterId: string | null; payload: Record<string, unknown>; inputRefs?: string[]; idempotencyKey: string; runKey?: string | null; createdBy: string }`; `type EnqueueResult = { jobId: string; reused: boolean }`; `JobRow` (Data shapes); `jobsRef()`; `canonicalJson(value: unknown): string` (object keys sorted recursively, `JSON.stringify` otherwise); `jobIdFor(firmId: string, jobType: string, idempotencyKey: string): string`; `jobKey(session: Session, suffix: string): string` = `` `${session.idempotencyKey}:${suffix}` `` (throws `Error("jobKey: no idempotency key")` when absent); `enqueueJobs(tx: Transaction, specs: readonly JobSpec[], opts: { now: number }): Promise<EnqueueResult[]>` and `enqueueJob(tx, spec, opts): Promise<EnqueueResult>`. Validation throws `Error("enqueue: invalid <field>")` (field name only, no value): `handlerFor(jobType)` undefined; label not `isKnownClassification`; `matterId` neither `null` nor `isSafeDocId`; payload not a plain JSON object (prototype `Object.prototype` or null; values string, finite number, boolean, null, array or plain object, recursively) or `Buffer.byteLength(canonicalJson(payload)) > 16_384`; more than 20 `inputRefs` or a ref not `<isSafeDocId>/<isSafeDocId>`; `idempotencyKey` not a string of 1-512 chars; `createdBy` neither `"system"` nor `isSafeDocId`. It validates every spec, reads every target with `tx.getAll`, then for each: existing doc with equal `payloadHash`, `classification` and `matterId` → `reused: true`, no write; any difference → `HttpError(409, "job_key_conflict")`; missing → `tx.create` with the full `JobRow` (`status: "queued"`, `nextAttemptAt`/`dispatchedAt`/`createdAt`/`updatedAt` = `now`, `dispatchSeq: 0`, `logs: [{ at: now, event: "enqueued", attempt: 0 }]`) and, when `createdBy === "system"`, `stageJobAudit(tx, …, "job.enqueue", "ok")`. Two specs with one id in one call follow the same reuse/conflict rule.
- Produces (`audit.ts`): `type JobAuditSubject = { id: string; firmId: string; classification: unknown; createdBy: string }`; `stageJobAudit(tx: Transaction, job: JobAuditSubject, action: JobAuditAction, reason: string): Promise<void>` (via `appendAudit(row, tx)`).
- Produces (`functions/test/jobs.ts`): `T0 = Date.parse("2026-10-08T09:00:00Z")`; `diagSpec(firmId: string, payload: DiagnosticPayload, over?: Partial<JobSpec>): JobSpec` (key `uniq("k")`, label `internal`, `matterId: null`, `createdBy: "system"`); `enqueueAt(spec: JobSpec, now: number): Promise<EnqueueResult>`; `readJob(jobId): Promise<JobRow & { updateTime: Timestamp }>`; `jobAuditRows(jobId): Promise<DocumentData[]>` (by `target`, ordered by `occurredAt`); `newFirm(): Promise<string>`.

- [ ] **Step 1: Write the failing unit tests** (`p2.engine.test.ts`):

```ts
it("jobIdFor: 'j' + 40 hex of SHA-256(firmId NUL jobType NUL key); the firm is in the hash", () => {
  const id = jobIdFor("f1", "platform.diagnostic", "k1")
  expect(id).toBe("j" + createHash("sha256").update("f1\0platform.diagnostic\0k1").digest("hex").slice(0, 40))
  expect(jobIdFor("f2", "platform.diagnostic", "k1")).not.toBe(id)
})
it("assertJobTimings: lease ≥ timeout + 60 s, budget < timeout", () => {
  expect(() => assertJobTimings(600_000, 300, 240_000)).not.toThrow()
  expect(() => assertJobTimings(360_000, 300, 240_000)).not.toThrow()
  expect(() => assertJobTimings(359_999, 300, 240_000)).toThrow(/lease/)
  expect(() => assertJobTimings(600_000, 300, 300_000)).toThrow(/budget/)
})
it("sanitizeError: declared codes keep a fixed message; everything else is internal; raw text never survives", () => {
  const h = diagnosticHandler, cnic = "42101-1234567-1"
  expect(sanitizeError(new JobError("diag_failure"), h)).toEqual({ code: "diag_failure", message: "Diagnostic failure (planned).", permanent: false })
  expect(sanitizeError(new JobError("diag_permanent", { permanent: true }), h)).toEqual({ code: "diag_permanent", message: "Diagnostic permanent failure (planned).", permanent: true })
  expect(sanitizeError(new JobError("invalid_payload"), h)).toMatchObject({ code: "invalid_payload", permanent: true })
  expect(sanitizeError(new JobError("undeclared"), h)).toEqual({ code: "internal", message: "The job failed with an internal error.", permanent: false })
  expect(sanitizeError(new JobError("Bad-Code"), { errorCodes: { "Bad-Code": "x" } }).code).toBe("internal")
  expect(sanitizeError(Object.assign(new Error(`UNAVAILABLE ${cnic}`), { code: 14 }), h)).toEqual({ code: "store_unavailable", message: "The data store was unavailable.", permanent: false })
  expect(JSON.stringify(sanitizeError(new Error(`CNIC ${cnic}`), h))).not.toContain("42101")
})
it("diagnostic parse accepts the five behaviours and rejects everything else as permanent invalid_payload", () => {
  expect(diagnosticHandler.parse({ behaviour: "fail_times", failTimes: 4 })).toEqual({ behaviour: "fail_times", failTimes: 4 })
  for (const bad of [{ behaviour: "explode" }, { behaviour: "fail_times" }, { behaviour: "fail_times", failTimes: 5 }, { behaviour: "fail_times", failTimes: 0 },
                     { behaviour: "succeed", extra: 1 }, { behaviour: "throw_raw", marker: "x".repeat(65) }, null, []])
    expect(() => diagnosticHandler.parse(bad)).toThrow(expect.objectContaining({ code: "invalid_payload", permanent: true }))
})
it("canonicalJson sorts keys recursively", () => expect(canonicalJson({ b: 1, a: { d: [1, { f: 1, e: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"e":2,"f":1}]},"b":1}'))
```

- [ ] **Step 2: Write the failing emulator tests** (`p2.jobs-enqueue.emu.test.ts`, suite "P2 enqueue (P3-2, P3-4)"):

```ts
it("enqueueJob creates an engine row with the P3-2 fields, timed from the caller's clock", async () => {
  // spec = diagSpec(firm, { behaviour: "succeed" }, { createdBy: partnerUid, idempotencyKey: "k1" }); enqueueAt(spec, T0)
  expect(row).toMatchObject({ engine: "p2", schemaVersion: 1, firmId: firm, jobType: "platform.diagnostic", classification: "internal", matterId: null,
    payload: { behaviour: "succeed" }, payloadHash: createHash("sha256").update('{"behaviour":"succeed"}').digest("hex"), inputRefs: [], outputRefs: [],
    idempotencyKey: "k1", runKey: null, status: "queued", attempts: 0, totalAttempts: 0, maxAttempts: 4, manualRetries: 0, lease: null,
    dispatchSeq: 0, lastError: null, createdBy: partnerUid, requeues: [], cancellation: null, startedAt: null, finishedAt: null })
  for (const f of ["nextAttemptAt", "dispatchedAt", "createdAt", "updatedAt"]) expect(row[f].toMillis()).toBe(T0)
  expect(row.traceId).toMatch(/^[0-9a-f-]{36}$/)
  expect(row.logs.map((l) => [l.event, l.attempt])).toEqual([["enqueued", 0]])
})
it("a repeated key reuses the row; a different payload, label or matter is 409 job_key_conflict", async () => {
  expect(await enqueueAt(spec, T0 + 5)).toEqual({ jobId, reused: true })            // updateTime unchanged
  for (const over of [{ payload: { behaviour: "permanent" } }, { classification: "confidential" }, { matterId: seededMatterId }])
    await expect(enqueueAt({ ...spec, ...over }, T0)).rejects.toMatchObject({ status: 409, code: "job_key_conflict" })
})
it("a rolled-back transaction leaves no row", async () => { /* runTransaction: enqueueJob then throw */ expect((await jobsRef().doc(id).get()).exists).toBe(false) })
it("invalid specs throw before any write", async () => {
  // each rejects with /enqueue: invalid/ and creates no doc: jobType "nope.type"; classification "secret"; matterId undefined;
  // payload { s: "x".repeat(16_400) }; payload { d: new Date() }; 21 inputRefs; inputRefs ["a/b/c"]; inputRefs ["../x"]; createdBy "a/b"; idempotencyKey ""
  // and a payload whose canonical JSON is exactly 16_384 bytes is accepted
})
it("one call with the same key twice: identical → one row (second reused); different → 409", async () => {
  expect(await enqueueAll([s, s])).toEqual([{ jobId, reused: false }, { jobId, reused: true }])
})
it("system-created jobs stage one job.enqueue audit row; an HTTP-caused one stages none", async () => {
  expect(await jobAuditRows(sysId)).toEqual([expect.objectContaining({ actorId: "system", onBehalfOf: "system", action: "job.enqueue",
    target: `jobs/${sysId}`, decision: "allow", reason: "ok", classification: "internal", firmId: firm })])
  expect(await jobAuditRows(userId)).toEqual([])
})
it("the router gives a POST op session.idempotencyKey and a GET op none; jobKey appends the suffix", async () => {
  // createRouter([post probe op, get probe op]) capturing session; POST with header idempotency-key "idem-1"
  expect(postSession.idempotencyKey).toBe("idem-1"); expect(getSession.idempotencyKey).toBeUndefined()
  expect(jobKey(postSession, "ocr")).toBe("idem-1:ocr"); expect(() => jobKey(getSession, "ocr")).toThrow(/no idempotency key/)
})
```

  Invariant 4 (`p2.jobs-invariants.emu.test.ts`):

```ts
it("P2 invariant: enqueue is idempotent and a job exists iff its transaction committed", async () => {
  const results = await Promise.all([1, 2, 3].map(() => enqueueAt(spec, T0)))       // three transactions, one key
  expect(results.filter((r) => !r.reused)).toHaveLength(1)
  expect((await jobsRef().where("firmId", "==", firm).where("idempotencyKey", "==", spec.idempotencyKey).get()).size).toBe(1)
  // a transaction that enqueues a fresh key then throws: no doc with that id
  const [a, b] = [await enqueueAt(diagSpec(firmA, p, { idempotencyKey: "same" }), T0), await enqueueAt(diagSpec(firmB, p, { idempotencyKey: "same" }), T0)]
  expect(a.jobId).not.toBe(b.jobId); expect(a.reused || b.reused).toBe(false)
})
```

- [ ] **Step 3: Run** `cd functions && npx vitest run test/p2.engine.test.ts` and `npx firebase emulators:exec --only auth,firestore --project demo-sikander "cd functions && npx vitest run test/p2.jobs-enqueue.emu.test.ts test/p2.jobs-invariants.emu.test.ts"`. Expected: FAIL (modules not found).
- [ ] **Step 4: Implement** the six modules and the three modifications per Interfaces.
- [ ] **Step 5: Run** the same two commands → PASS; `npm --prefix functions run test:emu` → PASS (the router change is additive); `cd functions && npx tsc --noEmit`, `npm run typecheck`, `npm run lint` → pass.
- [ ] **Step 6: Commit** `feat(p2): jobs model, transactional enqueue, handler registry and diagnostic type (P3-2, P3-4, P3-9, P3-17, P3-18)`.

### Task 3: Worker — claim, lease fence, run, retries, dead-letter, job events

**Files:**
- Create: `functions/src/p2/dispatch.ts` (types only in this task), `functions/src/p2/jobEvents.ts`, `functions/src/p2/worker.ts`
- Modify: `functions/test/jobs.ts` (in-process dispatcher, fake clock, test handlers)
- Test: `functions/test/p2.jobs-worker.emu.test.ts`; `functions/test/p2.jobs-invariants.emu.test.ts` (invariants 1 and 3)

**Interfaces:**
- Consumes: Task 2 (`JobRow`, `jobsRef`, `handlerFor`, `sanitizeError`, `JobError`, `LeaseLostError`, `stageJobAudit`, constants).
- Produces (`dispatch.ts`): `type JobTask = { jobId: string; seq: number }`; `interface JobDispatcher { dispatch(task: JobTask, opts?: { scheduleAt?: number }): Promise<void> }`; `type JobDeps = { dispatcher: JobDispatcher; clock: () => number; alert: DeadLetterAlert; handlerBudgetMs: number }`.
- Produces (`jobEvents.ts`): `type DeadLetterInfo = { jobId: string; jobType: string; firmId: string; attempts: number; code: string }`; `interface DeadLetterAlert { deadLettered(info: DeadLetterInfo): void | Promise<void> }`; `logDeadLetterAlert: DeadLetterAlert` → `logger.error("job.deadLettered", { jobId, jobType, firmId, attempts, code })`; `stageJobFailedEvent(tx, jobId: string, row: JobRow, code: string, now: number): void` and `stageJobDeadLetteredEvent(tx, jobId, row, code, now): void` (`tx.set` of the event shapes; `row` is the post-transition row).
- Produces (`worker.ts`): `type TaskOutcome = "dropped" | "done" | "failed" | "dead_lettered" | "lease_lost"`; `runJobTask(task: JobTask, deps: JobDeps): Promise<TaskOutcome>` — throws only when the claim transaction fails (store error); `stageFailure(tx: Transaction, ref: DocumentReference, row: JobRow, err: SanitizedError, now: number): "failed" | "dead_lettered"` (shared with the sweeper); `jobWorkerTestSeam: { afterClaim?: (c: { jobId: string; owner: string }) => Promise<void>; afterHandler?: (c: { jobId: string; owner: string }) => Promise<void> }`.
- Produces (`functions/test/jobs.ts`): `class FakeClock { constructor(ms: number); now(): number; set(ms: number): void; advance(ms: number): void }`; `class InProcessDispatcher implements JobDispatcher { tasks: Array<JobTask & { scheduleAt: number | null }>; deliver(task: JobTask, at?: number): Promise<TaskOutcome>; drainDue(now: number): Promise<TaskOutcome[]> }` (dedupes by `${jobId}-${seq}` like Cloud Tasks; `deliver` sets the clock to `at` when given and calls `runJobTask` with its deps); `testDeps(clock: FakeClock, opts?: { handlerBudgetMs?: number }): JobDeps & { dispatcher: InProcessDispatcher; alerts: DeadLetterInfo[] }` (budget default 240_000); test handlers `test.saga` (`saga: true`, succeeds) and `test.fenced` (`saga: false`, `run` calls `ctx.runFenced(tx => tx.set(counterRef, { count: increment(1) }, { merge: true }))`), installed with `installTestHandlers()` / `removeTestHandlers()` on `jobTestSeam.handlers`.

Claim, run and commit (the algorithm the signatures do not fix):

```text
claim tx: row = get(job); drop unless row.engine == "p2" && task.seq == row.dispatchSeq &&
  ((status in {queued, failed} && nextAttemptAt <= now + CLOCK_SKEW_TOLERANCE_MS) || (status == running && lease.expiresAt <= now))
  reclaim with attempts == MAX_ATTEMPTS → stageFailure(lease_expired); commit; alert after commit; return "dead_lettered"
  else update: status running, attempts+1, totalAttempts+1, lease {owner: randomUUID(), expiresAt: now + JOB_LEASE_MS},
    startedAt, updatedAt, log "claimed"|"reclaimed", stageJobAudit("job.start", "ok"|"lease_expired_reclaim")
afterClaim seam → handler = handlerFor(jobType) (missing → JobError unknown_job_type) → parse → run raced against handlerBudgetMs
  (overrun → JobError handler_timeout; timer cleared) → afterHandler seam
runFenced(fn): tx: re-read; fence holds iff status == running && lease.owner == owner; else throw LeaseLostError; then fn(tx)
commit tx: re-read; fence lost → write nothing, logger.warn("job.lease_lost", { jobId, jobType }) → "lease_lost"
  success → result.apply?.(tx); status done, outputRefs (validated as refs), lease null, nextAttemptAt null, finishedAt, log "done", audit job.done "ok"
  error → stageFailure(sanitizeError(err, handler)); LeaseLostError from the handler is the fence-lost path
stageFailure: retryable && attempts < MAX_ATTEMPTS → status failed, lastError, nextAttemptAt = now + RETRY_DELAYS_MS[attempts-1],
    dispatchSeq+1, dispatchedAt now, lease null, log "failed", job.failed event, audit job.fail <code>
  else → status dead_lettered, lastError, nextAttemptAt null, lease null, finishedAt, log "dead_lettered",
    job.failed + job.deadLettered events, audit job.dead_letter <code>
after commit: failed → dispatcher.dispatch({ jobId, seq: dispatchSeq }, { scheduleAt: nextAttemptAt }); dead_lettered → alert.deadLettered(info)
commit tx store error → logFailure("job commit failed", err) and rethrow (Cloud Tasks' retry then finds the row running and drops it; the lease and sweeper Query B recover the job)
logs: append, keep the last MAX_LOG_ENTRIES
```

- [ ] **Step 1: Write the failing tests** (`p2.jobs-worker.emu.test.ts`, suite "P2 worker (P3-3, P3-6, P3-7, P3-9)"; every case enqueues at `T0` with `d = testDeps(new FakeClock(T0))`). Shorthands used in this and later tasks' test code: `deliver` = `d.dispatcher.deliver`; `row` = `await readJob(jobId)`; `count` = the diagnostic counter's `count` (0 when the doc is absent); `events` = the job's `events` docs keyed by id; `enqueueAll(specs)` = `enqueueJobs` in one transaction at `T0`:

```ts
it("success: claim, run, commit; counter 1; audit job.start then job.done as system on behalf of the creator", async () => {
  expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("done")
  expect(row).toMatchObject({ status: "done", attempts: 1, totalAttempts: 1, lease: null, nextAttemptAt: null, lastError: null })
  expect(row.finishedAt.toMillis()).toBe(T0); expect(count).toBe(1)
  expect((await jobAuditRows(jobId)).map((r) => [r.action, r.reason, r.actorId, r.onBehalfOf])).toEqual([["job.start", "ok", "system", uid], ["job.done", "ok", "system", uid]])
  expect(row.logs.map((l) => l.event)).toEqual(["enqueued", "claimed", "done"])
})
it("retry schedule: fail_times 2 fails at attempts 1 and 2 (1 s, then 5 s later) and succeeds at 3", async () => {
  expect(await d.dispatcher.deliver({ jobId, seq: 0 }, T0)).toBe("failed")
  expect(row).toMatchObject({ status: "failed", attempts: 1, dispatchSeq: 1, lastError: { code: "diag_failure", message: "Diagnostic failure (planned)." } })
  expect(row.nextAttemptAt.toMillis()).toBe(T0 + 1000)
  expect(d.dispatcher.tasks.at(-1)).toEqual({ jobId, seq: 1, scheduleAt: T0 + 1000 })
  expect(event(`${jobId}_failed_1`)).toMatchObject({ name: "job.failed", firmId, classification: "internal", idempotencyKey: `${jobId}_failed_1`,
    payload: { jobId, jobType: "platform.diagnostic", attempts: 1, error: "diag_failure" } })
  expect(await d.dispatcher.deliver({ jobId, seq: 1 }, T0 + 1000)).toBe("failed")      // nextAttemptAt = T0 + 6000, task seq 2
  expect(await d.dispatcher.deliver({ jobId, seq: 2 }, T0 + 6000)).toBe("done"); expect(count).toBe(1); expect(row.totalAttempts).toBe(3)
})
it("permanent, invalid payload and unknown type dead-letter at attempt 1 with job.failed and job.deadLettered", async () => {
  // behaviour "permanent" → code diag_permanent; payload overwritten with { behaviour: "nope" } via the Admin SDK → invalid_payload;
  // jobType overwritten to "gone.type" → unknown_job_type. For each:
  expect(row).toMatchObject({ status: "dead_lettered", attempts: 1, nextAttemptAt: null, lease: null, lastError: { code } })
  expect(Object.keys(events).sort()).toEqual([`${jobId}_deadLettered_0`, `${jobId}_failed_1`])
  expect(d.alerts).toEqual([{ jobId, jobType, firmId, attempts: 1, code }])
})
it("hang overruns the handler budget: retryable handler_timeout", async () => { /* testDeps(clock, { handlerBudgetMs: 50 }) */ expect(row).toMatchObject({ status: "failed", lastError: { code: "handler_timeout" } }) })
it("a stale seq, a not-yet-due delivery (> 2 s early), a cancelled, done or non-engine row is dropped; 1.5 s early runs", async () => {
  expect(await deliver({ jobId, seq: 1 }, T0)).toBe("dropped")                          // dispatchSeq is 0; updateTime unchanged
  // after one failure (nextAttemptAt N = T0 + 1000): seq 1 at N - 2500 → "dropped", no new task recorded; at N - 1500 → "failed"
  // status "cancelled" → "dropped"; a done job delivered again → "dropped", count stays 1; a row without engine → "dropped"
  // every dropped delivery writes no audit row (jobAuditRows unchanged) and changes no field (P3-18)
})
it("runFenced after the fence is lost writes nothing and the commit is skipped", async () => {
  // test.fenced job; jobWorkerTestSeam.afterClaim sets lease.owner = "intruder" (deleted in finally)
  expect(outcome).toBe("lease_lost"); expect((await fencedCounter.get()).exists).toBe(false)
  expect(row).toMatchObject({ status: "running", lease: { owner: "intruder" } })
  expect(warn).toHaveBeenCalledWith("job.lease_lost", { jobId, jobType: "test.fenced" })
})
it("logs keep the last 50 entries", async () => { /* row seeded with 50 log entries, then a claim */ expect(row.logs).toHaveLength(50); expect(row.logs.at(-1).event).toBe("done") })
it("the default alert logs job.deadLettered with codes only", async () => {
  await logDeadLetterAlert.deadLettered({ jobId: "j1", jobType: "t", firmId: "f", attempts: 4, code: "internal" })
  expect(error).toHaveBeenCalledWith("job.deadLettered", { jobId: "j1", jobType: "t", firmId: "f", attempts: 4, code: "internal" })
})
```

  Invariants (`p2.jobs-invariants.emu.test.ts`):

```ts
it("P2 invariant: duplicate delivery commits the effect exactly once", async () => {
  await d.dispatcher.dispatch({ jobId, seq: 0 }); await d.dispatcher.dispatch({ jobId, seq: 0 })
  expect(d.dispatcher.tasks).toHaveLength(1)                                            // task id j…-0 deduped
  expect((await Promise.all([deliver(t, T0), deliver(t, T0)])).sort()).toEqual(["done", "dropped"])
  expect(await deliver(t, T0 + 10)).toBe("dropped")
  expect([count, row.attempts, row.totalAttempts]).toEqual([1, 1, 1])
  expect((await jobAuditRows(jobId)).filter((r) => r.action === "job.done")).toHaveLength(1)
})
it("P2 invariant: a failing job retries at 1s, 5s and 25s, then dead-letters with job.deadLettered", async () => {
  // fail_times 4; deliver each recorded task at its scheduleAt
  expect(gaps).toEqual([1000, 5000, 25000])                                             // scheduleAt − failure clock, per retry
  expect(row).toMatchObject({ status: "dead_lettered", attempts: 4, totalAttempts: 4, lastError: { code: "diag_failure" } })
  expect(eventIds.sort()).toEqual([1, 2, 3, 4].map((n) => `${jobId}_failed_${n}`).concat(`${jobId}_deadLettered_0`).sort())
  expect(events[`${jobId}_deadLettered_0`]).toMatchObject({ name: "job.deadLettered", payload: { jobId, jobType: "platform.diagnostic", attempts: 4, error: "diag_failure" } })
  expect(d.alerts).toEqual([{ jobId, jobType: "platform.diagnostic", firmId, attempts: 4, code: "diag_failure" }])
  expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual(["job.enqueue", ...Array(3).fill(["job.start", "job.fail"]).flat(), "job.start", "job.dead_letter"])
})
```

- [ ] **Step 2: Run** `npx firebase emulators:exec --only auth,firestore --project demo-sikander "cd functions && npx vitest run test/p2.jobs-worker.emu.test.ts test/p2.jobs-invariants.emu.test.ts"` — FAIL.
- [ ] **Step 3: Implement** `dispatch.ts` types, `jobEvents.ts`, `worker.ts`, the `test/jobs.ts` additions.
- [ ] **Step 4: Run** the same → PASS (invariant 4 still passes); `npm --prefix functions run test:emu`, `cd functions && npx tsc --noEmit`, `npm run lint` → pass.
- [ ] **Step 5: Commit** `feat(p2): worker with lease fence, 1s/5s/25s retries, dead-letter and job events (P3-3, P3-6, P3-7, P3-9)`.

### Task 4: Dispatch and recovery — Cloud Tasks dispatcher, trigger, worker function, sweeper

**Files:**
- Modify: `functions/src/p2/dispatch.ts` (`CloudTasksDispatcher`, `defaultDeps`, `jobRuntime`, `runtimeDeps`)
- Create: `functions/src/p2/sweeper.ts`, `functions/src/p2/functions.ts`
- Modify: `functions/src/index.ts:8-9` (export `onJobCreated`, `jobWorker`, `jobSweeper` from `./p2/functions`), `firestore.indexes.json` (two collection-scope `jobs` indexes: `status ASC, nextAttemptAt ASC`; `status ASC, lease.expiresAt ASC`), `functions/test/deploy.test.ts:44-49` (iterate only exports whose `__endpoint.httpsTrigger` is defined), `functions/test/g2.cross-firm.test.ts:56` (`NOT_TENANT_ENDPOINTS` gains `onJobCreated: "Firestore trigger on jobs, no caller"`, `jobWorker: "Cloud Tasks queue function, OIDC-invoked by Cloud Tasks only; acts on the job id it is given"`, `jobSweeper: "scheduler, no caller"`) and `:217` (title "only the HTTP api, the health probe and the job runtime functions are deployed; every route has a cross-firm probe and runs its operation")
- Test: `functions/test/p2.dispatch.test.ts` (unit), `functions/test/p2.boot.test.ts` (unit), `functions/test/p2.jobs-sweeper.emu.test.ts`; `functions/test/p2.jobs-invariants.emu.test.ts` (invariants 2 and 5)

**Interfaces:**
- Consumes: Task 3 (`runJobTask`, `stageFailure`, `JobDeps`, `JobDispatcher`, `logDeadLetterAlert`, `InProcessDispatcher`).
- Produces (`dispatch.ts`): `type TaskQueueLike = { enqueue(data: JobTask, opts: { id: string; scheduleTime?: Date }): Promise<void> }`; `class CloudTasksDispatcher implements JobDispatcher { constructor(queue?: () => TaskQueueLike) }` — the default resolves `getFunctions(adminApp()).taskQueue("locations/asia-south1/functions/jobWorker")` on first dispatch (no work at construction); `dispatch` enqueues exactly `{ jobId, seq }` with `id: \`${jobId}-${seq}\`` and `scheduleTime: new Date(scheduleAt)` only when given; an error with `code === "functions/task-already-exists"` resolves. `defaultDeps(): JobDeps` = `{ dispatcher: new CloudTasksDispatcher(), clock: Date.now, alert: logDeadLetterAlert, handlerBudgetMs: JOB_HANDLER_BUDGET_MS }`. `jobRuntime: { deps?: JobDeps }` (test seam) and `runtimeDeps(): JobDeps` = `jobRuntime.deps ?? defaultDeps()`.
- Produces (`sweeper.ts`): `sweep(deps: JobDeps): Promise<{ dispatched: string[]; deadLettered: string[] }>` — Query A: `jobs where status in ["queued","failed"] and nextAttemptAt <= now - DISPATCH_GRACE_MS orderBy nextAttemptAt limit SWEEP_LIMIT`; per row a transaction re-reads and proceeds only if still an engine row in that status, due, and (`dispatchedAt <= now - DISPATCH_GRACE_MS` or `dispatchedAt > now + MAX_CLOCK_SKEW_MS`); sets `dispatchSeq + 1`, `dispatchedAt = now`, `updatedAt`; dispatches `{ jobId, seq }` after commit (no `scheduleAt`). Query B: `status == "running" and lease.expiresAt <= now orderBy lease.expiresAt limit SWEEP_LIMIT`; per row a transaction re-reads; `attempts >= MAX_ATTEMPTS` → `stageFailure` with `lease_expired` (permanent) and the alert after commit; otherwise `dispatchSeq + 1`, `dispatchedAt = now`, dispatch after commit. A dropped re-read writes nothing.
- Produces (`functions.ts`): `onJobCreatedCore(jobId: string, data: DocumentData | undefined, deps: JobDeps): Promise<void>` (non-engine row → return; else `dispatch({ jobId, seq: 0 })`; failure logged, swallowed); `parseJobTask(data: unknown): JobTask | null` (`jobId` `isSafeDocId`, `seq` a non-negative safe integer, no other keys); `onJobCreated = onDocumentCreated({ document: "jobs/{jobId}", region: REGION }, …)`; `jobWorker = onTaskDispatched({ region: REGION, timeoutSeconds: JOB_WORKER_TIMEOUT_SECONDS, retryConfig, rateLimits }, …)` (invalid body → `logger.warn("job.task_invalid")`, return); `jobSweeper = onSchedule({ schedule: "every 1 minutes", region: REGION }, () => sweep(runtimeDeps()))`.

- [ ] **Step 1: Write the failing unit tests.** `p2.dispatch.test.ts`:

```ts
it("CloudTasksDispatcher enqueues { jobId, seq } as task jobId-seq; task-already-exists is success; other errors reject", async () => {
  await new CloudTasksDispatcher(() => fake).dispatch({ jobId: "jabc", seq: 2 }, { scheduleAt: T0 })
  expect(fake.calls).toEqual([[{ jobId: "jabc", seq: 2 }, { id: "jabc-2", scheduleTime: new Date(T0) }]])
  await new CloudTasksDispatcher(() => fake).dispatch({ jobId: "jabc", seq: 3 }); expect(fake.calls[1][1]).toEqual({ id: "jabc-3" })
  await expect(dispatcherRejecting({ code: "functions/task-already-exists" }).dispatch(t)).resolves.toBeUndefined()
  await expect(dispatcherRejecting({ code: "functions/unavailable" }).dispatch(t)).rejects.toMatchObject({ code: "functions/unavailable" })
})
it("onJobCreatedCore dispatches seq 0 for an engine row only; a duplicate trigger reuses task j…-0", async () => {
  await onJobCreatedCore("j1", { engine: "p2" }, d); await onJobCreatedCore("j1", { engine: "p2" }, d); await onJobCreatedCore("j2", { jobType: "ocr" }, d)
  expect(d.dispatcher.tasks).toEqual([{ jobId: "j1", seq: 0, scheduleAt: null }])
})
it("parseJobTask accepts { jobId, seq } only", () => {
  expect(parseJobTask({ jobId: "j1", seq: 0 })).toEqual({ jobId: "j1", seq: 0 })
  for (const bad of [{ jobId: "a/b", seq: 0 }, { jobId: "j1", seq: -1 }, { jobId: "j1", seq: 1.5 }, { jobId: "j1", seq: 0, payload: {} }, null]) expect(parseJobTask(bad)).toBeNull()
})
```

  `p2.boot.test.ts` (with every `SIKANDER_FLAG_*` of `d1.boot.test.ts` set `false`):

```ts
it("the index exports api, health and the job runtime functions, each in asia-south1 with its trigger kind", async () => {
  const index = await import("../src/index")
  expect(Object.keys(index).sort()).toEqual(["api", "health", "jobSweeper", "jobWorker", "onJobCreated"])
  for (const n of ["onJobCreated", "jobWorker", "jobSweeper"]) expect(index[n].__endpoint.region).toEqual(["asia-south1"])
  expect(index.onJobCreated.__endpoint.eventTrigger).toMatchObject({ eventType: "google.cloud.firestore.document.v1.created", eventFilterPathPatterns: { document: "jobs/{jobId}" } })
  expect(index.jobWorker.__endpoint).toMatchObject({ timeoutSeconds: 300, taskQueueTrigger: { retryConfig: { maxAttempts: 3, minBackoffSeconds: 10, maxBackoffSeconds: 60 },
    rateLimits: { maxConcurrentDispatches: 10, maxDispatchesPerSecond: 5 } } })
  expect(index.jobSweeper.__endpoint.scheduleTrigger).toMatchObject({ schedule: "every 1 minutes" })
  expect([...JOB_HANDLERS.keys()]).toEqual(["platform.diagnostic"])
})
```

- [ ] **Step 2: Write the failing sweeper tests** (`p2.jobs-sweeper.emu.test.ts`, suite "P2 sweeper (P3-8)"; each job seeded at `T0` with no trigger run; local helpers `sweepAt(ms)` = set the clock to `ms`, then `sweep(d)`, and `tasksFor(jobId)` = the dispatcher's tasks for that job):

```ts
it("query A: a due row whose trigger was lost is re-dispatched once, 30 s after its last dispatch", async () => {
  expect((await sweepAt(T0 + 29_999)).dispatched).not.toContain(jobId)
  expect((await sweepAt(T0 + 30_000)).dispatched).toContain(jobId)
  expect(row).toMatchObject({ dispatchSeq: 1 }); expect(row.dispatchedAt.toMillis()).toBe(T0 + 30_000)
  expect(tasksFor(jobId)).toEqual([{ jobId, seq: 1, scheduleAt: null }])
  expect((await sweepAt(T0 + 59_999)).dispatched).not.toContain(jobId)
  expect((await sweepAt(T0 + 60_000)).dispatched).toContain(jobId)                      // seq 2
  expect((await jobAuditRows(jobId)).map((r) => r.action)).toEqual(["job.enqueue"])     // a re-dispatch writes no audit row
})
it("query B: an expired lease is re-dispatched and the worker reclaims with attempts + 1", async () => {
  // Admin SDK: status running, attempts 1, totalAttempts 1, lease { owner: "dead", expiresAt: T0 + 600_000 }
  expect((await sweepAt(T0 + 599_999)).dispatched).not.toContain(jobId)
  expect((await sweepAt(T0 + 600_000)).dispatched).toContain(jobId)
  expect(await deliver({ jobId, seq: 1 }, T0 + 600_000)).toBe("done"); expect(row.attempts).toBe(2)
  expect((await jobAuditRows(jobId)).find((r) => r.action === "job.start")!.reason).toBe("lease_expired_reclaim")
})
it("query B: an expired lease at attempt 4 dead-letters with lease_expired", async () => {
  expect((await sweepAt(T0 + 600_000)).deadLettered).toEqual([jobId])
  expect(row).toMatchObject({ status: "dead_lettered", lease: null, lastError: { code: "lease_expired", message: "The job's worker stopped before finishing." } })
  expect(d.alerts).toEqual([expect.objectContaining({ jobId, code: "lease_expired", attempts: 4 })])
  expect((await jobAuditRows(jobId)).at(-1)).toMatchObject({ action: "job.dead_letter", reason: "lease_expired" })
})
it("three concurrent sweeps dispatch a job once", async () => {
  const r = await Promise.all([1, 2, 3].map(() => sweep(d)))
  expect(r.flatMap((x) => x.dispatched).filter((id) => id === jobId)).toHaveLength(1); expect(row.dispatchSeq).toBe(1)
})
it("a dispatchedAt more than 300 s ahead is reset; 299 s ahead is trusted", async () => {
  // dispatchedAt = now + 300_001 → re-dispatched, dispatchedAt = now; dispatchedAt = now + 299_000 → not dispatched
})
```

  Invariants (`p2.jobs-invariants.emu.test.ts`):

```ts
it("P2 invariant: a lease that expires mid-handler is reclaimed and the stale commit is discarded", async () => {
  // succeed job; afterClaim records owners; afterHandler (first call only, guarded): clock.advance(JOB_LEASE_MS),
  // sweep(d) (query B), then deliver the new task to "done"; then worker 1 continues to its commit
  expect(outcomeOfWorker1).toBe("lease_lost"); expect(owners).toHaveLength(2)
  expect(row).toMatchObject({ status: "done", attempts: 2, totalAttempts: 2, lease: null }); expect(count).toBe(1)
  expect(row.logs.filter((l) => l.event === "done")).toEqual([expect.objectContaining({ attempt: 2 })])
  expect(warn.mock.calls.filter(([m]) => m === "job.lease_lost")).toHaveLength(1)
})
it("P2 invariant: skewed clocks never dispatch a job twice in one sweep or run a fifth attempt", async () => {
  // fail_times 4. For each attempt k with due = nextAttemptAt: deliver(seq) at due − 3000 → "dropped" and no task added;
  // at due − 1500 → runs; the same seq again at due → "dropped". After each step: expect(row.attempts).toBeLessThanOrEqual(4)
  // Sweeps between attempts at clocks T − 600_000, T + 600_000 and T + 40_000 (T = the last failure), then 20 sweeps at one clock:
  for (const r of sweepResults) expect(r.dispatched.filter((id) => id === jobId).length).toBeLessThanOrEqual(1)
  expect(twentyInARow.flatMap((r) => r.dispatched).filter((id) => id === jobId).length).toBeLessThanOrEqual(1)
  // the T + 600_000 sweep stamps dispatchedAt 10 min ahead; the T + 40_000 sweep resets it to T + 40_000 (one dispatch)
  expect(row).toMatchObject({ status: "dead_lettered", totalAttempts: 4, attempts: 4 })
})
```

- [ ] **Step 3: Run** `cd functions && npx vitest run test/p2.dispatch.test.ts test/p2.boot.test.ts test/deploy.test.ts` and `npx firebase emulators:exec --only auth,firestore --project demo-sikander "cd functions && npx vitest run test/p2.jobs-sweeper.emu.test.ts test/p2.jobs-invariants.emu.test.ts"` — FAIL.
- [ ] **Step 4: Implement** `dispatch.ts` additions, `sweeper.ts`, `functions.ts`, the index exports, the indexes, `deploy.test.ts` and the G-2 `NOT_TENANT_ENDPOINTS` and title.
- [ ] **Step 5: Run** the same → PASS; `npm --prefix functions run test:emu`, `npm run gate:g2`, `npm --prefix functions run build`, `cd functions && npx tsc --noEmit`, `npm run lint` → pass.
- [ ] **Step 6: Commit** `feat(p2): Cloud Tasks dispatch, onJobCreated, jobWorker and the sweeper (P3-5, P3-8, P3-22)`.

### Task 5: Events fan-out

**Files:**
- Create: `functions/src/p2/fanout.ts`
- Modify: `functions/src/p2/registry.ts` (`jobTestSeam.subscribers: Subscriber[]`, `import type { Subscriber } from "./fanout"`), `functions/src/p2/functions.ts` (`onEventCreated = onDocumentCreated({ document: "events/{eventId}", region: REGION }, e => fanOutEvent(e.params.eventId, e.data?.data(), runtimeDeps()))`), `functions/src/index.ts` (export `onEventCreated`), `functions/test/g2.cross-firm.test.ts:56` (`onEventCreated: "Firestore trigger on events, no caller"`), `functions/test/p2.boot.test.ts` (exports list gains `onEventCreated` with `eventFilterPathPatterns: { document: "events/{eventId}" }`; `expect(SUBSCRIBERS).toEqual([])`), `functions/test/jobs.ts` (test handler `test.event`: `parse` accepts exactly `{ eventId: string }`, `run` reads `events/<eventId>` and succeeds)
- Test: `functions/test/p2.fanout.test.ts` (unit), `functions/test/p2.jobs-events.emu.test.ts`

**Interfaces:**
- Consumes: Task 2 (`enqueueJobs`, `jobIdFor`, `handlerFor`), Task 4 (`runtimeDeps`).
- Produces: `type Subscriber = { id: string; eventNames: readonly string[]; jobType: string; matterIdOf?: (event: DocumentData) => string | null }`; `SUBSCRIBERS: readonly Subscriber[] = []`; `validateSubscribers(list: readonly Subscriber[]): void` — throws `/duplicate subscriber/`, `/unregistered job type/`, `/job\.\* events/` (any event name starting `job.`); called at load on `SUBSCRIBERS` and on every `fanOutEvent` call for `SUBSCRIBERS` plus `jobTestSeam.subscribers`. `fanOutEvent(eventId: string, data: DocumentData | undefined, deps: Pick<JobDeps, "clock">): Promise<{ created: string[]; reused: string[] }>` — no string `firmId` → `logger.warn("event.fanout_ignored", { eventId })`, empty result; otherwise one transaction enqueuing, per subscriber whose `eventNames` include `data.name`: `{ firmId, jobType, classification: known label or "privileged-restricted", matterId: matterIdOf?.(data) ?? null, payload: { eventId }, inputRefs: [\`events/${eventId}\`], idempotencyKey: \`${eventId}:${subscriber.id}\`, createdBy: "system" }` (the `job.enqueue` audit row comes from `enqueueJobs`).

- [ ] **Step 1: Write the failing tests.** `p2.fanout.test.ts`:

```ts
it("validateSubscribers: unique ids, registered types, no job.* events", () => {
  const ok = { id: "s1", eventNames: ["entity.candidate"], jobType: "platform.diagnostic" }
  expect(() => validateSubscribers([ok])).not.toThrow()
  expect(() => validateSubscribers([ok, ok])).toThrow(/duplicate subscriber/)
  expect(() => validateSubscribers([{ ...ok, jobType: "nope" }])).toThrow(/unregistered job type/)
  for (const n of ["job.failed", "job.deadLettered"]) expect(() => validateSubscribers([{ ...ok, eventNames: [n] }])).toThrow(/job\.\* events/)
})
```

  `p2.jobs-events.emu.test.ts` (suite "P2 events fan-out (P3-15)"; `jobTestSeam.subscribers = [{ id: "diag", eventNames: ["entity.candidate"], jobType: "test.event" }]`, reset in `afterEach`; event `{ name: "entity.candidate", firmId, classification: "confidential", payload: { entityIds: ["a", "b"], note: marker } }`):

```ts
it("one job per matching subscriber, keyed eventId:subscriberId, carrying only the event id", async () => {
  const id = jobIdFor(firmId, "test.event", `${eventId}:diag`)
  expect(await fanOutEvent(eventId, data, { clock: () => T0 })).toEqual({ created: [id], reused: [] })
  expect(row).toMatchObject({ jobType: "test.event", firmId, classification: "confidential", matterId: null, payload: { eventId },
    inputRefs: [`events/${eventId}`], idempotencyKey: `${eventId}:diag`, createdBy: "system" })
  expect((await jobAuditRows(id)).map((r) => r.action)).toEqual(["job.enqueue"])
})
it("a redelivered trigger reuses the job", async () => { expect(await fanOutEvent(eventId, data, c)).toEqual({ created: [], reused: [id] }); expect(await jobAuditRows(id)).toHaveLength(1) })
it("no matching subscriber, no job", async () => { expect(await fanOutEvent(e2, { ...data, name: "matter.created" }, c)).toEqual({ created: [], reused: [] }) })
it("a payload value in the event never appears in the job", async () => { expect(JSON.stringify(row)).not.toContain(marker) })
it("an unknown label reads as privileged-restricted; matterIdOf sets the matter", async () => { /* classification "secret" → "privileged-restricted"; subscriber matterIdOf: e => e.payload.matterId */ })
it("an event without firmId is logged and ignored", async () => {
  expect(await fanOutEvent("e-nofirm", { name: "entity.candidate" }, c)).toEqual({ created: [], reused: [] })
  expect(warn).toHaveBeenCalledWith("event.fanout_ignored", { eventId: "e-nofirm" })
})
```

- [ ] **Step 2: Run** `cd functions && npx vitest run test/p2.fanout.test.ts test/p2.boot.test.ts` and `npx firebase emulators:exec --only auth,firestore --project demo-sikander "cd functions && npx vitest run test/p2.jobs-events.emu.test.ts"` — FAIL.
- [ ] **Step 3: Implement** `fanout.ts` and the modifications.
- [ ] **Step 4: Run** the same → PASS; `npm --prefix functions run test:emu`, `npm run gate:g2`, `cd functions && npx tsc --noEmit`, `npm run lint` → pass.
- [ ] **Step 5: Commit** `feat(p2): events fan-out, one job per subscriber keyed eventId:subscriberId (P3-15)`.

### Task 6: Scheduled-job primitive, backfill command, README

**Files:**
- Create: `functions/src/p2/scheduled.ts`, `functions/src/cli/jobsBackfill.ts`, `functions/src/p2/README.md`
- Modify: `functions/build.mjs:60-72` (second entry `src/cli/jobsBackfill.ts` → `lib/cli/jobsBackfill.js`, same options), `functions/package.json:9-15` (`"jobs:backfill": "node lib/cli/jobsBackfill.js"`), `functions/test/jobs.ts` (test handler `test.scheduled`: `parse` accepts `{ period }`, succeeds)
- Test: `functions/test/p2.scheduled.test.ts` (unit), `functions/test/p2.jobs-scheduled.emu.test.ts`

**Interfaces:**
- Consumes: Task 2 (`enqueueJob`, `jobIdFor`, `handlerFor`).
- Produces: `type Period = "hour" | "day" | "week" | "month"`; `type ScheduledJobSpec = { jobType: string; cron: string; period: Period }`; `SCHEDULED_JOBS: readonly ScheduledJobSpec[] = []`; `periodKey(period: Period, nowMs: number): string` — computed on `nowMs + 5 h` in UTC (PKT, no DST): hour `YYYY-MM-DDTHH`, day `YYYY-MM-DD`, ISO week `YYYY-Www`, month `YYYY-MM`; `periodRange(period: Period, fromKey: string, toKey: string): string[]` — inclusive, throws `/invalid period key/` on a malformed key, `/from after to/`, `/at most 366/`; `enqueueScheduledRuns(spec: ScheduledJobSpec, nowMs: number, opts?: { pageSize?: number }): Promise<{ firms: number; created: number; reused: number }>` — pages `firms` ordered by `__name__` (page 300), per firm one transaction `enqueueJob(tx, { firmId, jobType, classification: "internal", matterId: null, payload: { period: key }, idempotencyKey: \`${jobType}:${key}\`, runKey: same, createdBy: "system" }, { now })`; `backfillScheduledRuns(spec, fromKey, toKey, nowMs)` (same per key in `periodRange`); `scheduledJobFunction(spec): ScheduleFunction` = `onSchedule({ schedule: spec.cron, timeZone: "Asia/Karachi", region: REGION }, () => enqueueScheduledRuns(spec, Date.now()))`. CLI: `runBackfill(argv: string[], deps: { schedules: readonly ScheduledJobSpec[]; now: () => number; out: (line: string) => void }): Promise<number>` — `<jobType> <from> <to>`; wrong arity → 64 and a usage line; a type not in `schedules` → 2 and `"no schedule for <jobType>"`; a range error → 2; success → 0 and one summary line; `main` runs only when `require.main === module` with `SCHEDULED_JOBS`.
- README: "Scheduled jobs" table (jobType, cron in PKT, period) with "none in Phase 3a"; "The sweeper (`jobSweeper`, every minute) is the engine's heartbeat, not a P2 job"; dead-letter runbook: the `logger.error("job.deadLettered", …)` line, the log-based alert policy to create at deploy (O-30), and `retryFailedJob`; backfill usage.

- [ ] **Step 1: Write the failing unit tests** (`p2.scheduled.test.ts`):

```ts
it("periodKey is computed in PKT", () => {
  expect(periodKey("hour", Date.parse("2026-10-08T09:30:00Z"))).toBe("2026-10-08T14")
  expect(periodKey("day", Date.parse("2026-10-08T18:59:59.999Z"))).toBe("2026-10-08")
  expect(periodKey("day", Date.parse("2026-10-08T19:00:00Z"))).toBe("2026-10-09")
  expect(periodKey("week", Date.parse("2026-10-08T09:00:00Z"))).toBe("2026-W41")
  expect(periodKey("week", Date.parse("2026-12-31T09:00:00Z"))).toBe("2026-W53")
  expect(periodKey("week", Date.parse("2027-01-03T18:59:59Z"))).toBe("2026-W53")
  expect(periodKey("week", Date.parse("2027-01-03T19:00:00Z"))).toBe("2027-W01")
  expect(periodKey("month", Date.parse("2026-10-31T18:59:59Z"))).toBe("2026-10")
  expect(periodKey("month", Date.parse("2026-10-31T19:00:00Z"))).toBe("2026-11")
})
it("periodRange is inclusive, crosses month and ISO-year ends, and caps at 366", () => {
  expect(periodRange("day", "2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"])
  expect(periodRange("week", "2026-W52", "2027-W02")).toEqual(["2026-W52", "2026-W53", "2027-W01", "2027-W02"])
  expect(periodRange("month", "2026-11", "2027-01")).toEqual(["2026-11", "2026-12", "2027-01"])
  expect(periodRange("day", "2026-01-01", "2027-01-01")).toHaveLength(366)
  expect(() => periodRange("day", "2026-01-01", "2027-01-02")).toThrow(/at most 366/)
  expect(() => periodRange("day", "2026-03-01", "2026-02-27")).toThrow(/from after to/)
  expect(() => periodRange("week", "2026-W54", "2026-W54")).toThrow(/invalid period key/)
})
it("the backfill CLI refuses a type with no schedule", async () => {
  expect(await runBackfill(["platform.diagnostic", "2026-10-01", "2026-10-02"], { schedules: [], now: () => T0, out })).toBe(2)
  expect(lines).toContain("no schedule for platform.diagnostic")
  expect(await runBackfill(["x"], deps)).toBe(64)
})
it("scheduledJobFunction carries the cron and Asia/Karachi", () => {
  expect(scheduledJobFunction({ jobType: "test.scheduled", cron: "0 2 * * *", period: "day" }).__endpoint).toMatchObject({
    region: ["asia-south1"], scheduleTrigger: { schedule: "0 2 * * *", timeZone: "Asia/Karachi" } })
  expect(SCHEDULED_JOBS).toEqual([])
})
```

  `p2.jobs-scheduled.emu.test.ts` (suite "P2 scheduled jobs (P3-16)"; three new firms; spec `{ jobType: "test.scheduled", cron: "0 2 * * *", period: "day" }`):

```ts
it("one run per firm per period; a repeated tick reuses it", async () => {
  await enqueueScheduledRuns(spec, T0, { pageSize: 2 })                                 // paging over more than one page
  for (const f of firms) expect(await readJob(jobIdFor(f, "test.scheduled", "test.scheduled:2026-10-08"))).toMatchObject({
    runKey: "test.scheduled:2026-10-08", matterId: null, classification: "internal", createdBy: "system", payload: { period: "2026-10-08" } })
  await enqueueScheduledRuns(spec, T0 + 60_000)                                          // updateTime of each unchanged
})
it("backfill enqueues every period of the range per firm", async () => {
  await backfillScheduledRuns(spec, "2026-10-05", "2026-10-07", T0)
  // for each firm, jobs with runKey test.scheduled:2026-10-05, …-06, …-07 exist
})
```

- [ ] **Step 2: Run** `cd functions && npx vitest run test/p2.scheduled.test.ts` and `npx firebase emulators:exec --only auth,firestore --project demo-sikander "cd functions && npx vitest run test/p2.jobs-scheduled.emu.test.ts"` — FAIL.
- [ ] **Step 3: Implement** `scheduled.ts`, the CLI, the README, `build.mjs` and the npm script.
- [ ] **Step 4: Run** the same → PASS; `npm --prefix functions run build` → `lib/cli/jobsBackfill.js` exists and `npm --prefix functions run jobs:backfill -- platform.diagnostic 2026-10-01 2026-10-02` exits 2 printing `no schedule for platform.diagnostic`; `npm --prefix functions run test:emu`, `cd functions && npx tsc --noEmit`, `npm run lint` → pass.
- [ ] **Step 5: Commit** `feat(p2): scheduled-job primitive in PKT with backfill command and README (P3-16)`.

### Task 7: API routes, permission actions, rules and indexes, G-2 probes

**Files:**
- Modify: `platform/p5/permissionDecision.ts:72-115,157-165` (`JOB_ACTIONS`, `JobAction`, `isJobAction`, `JOB_ROLES`; branch after the D1 branch), `functions/src/p5/permission.ts:85-89` (`requirePermission(caller, action: FirmAdminAction | D1Action | JobAction, matterId?)`)
- Create: `functions/src/p2/view.ts`, `functions/src/p2/ops.ts`
- Modify: `functions/src/http/router.ts:60-65,79-111` (`const PLATFORM_JOBS = "/api/platform/jobs"`; `get(\`${PLATFORM_JOBS}/listJobs\`, listJobsOp)`, `get(…/getJob, getJobOp)`, `post(…/retryFailedJob, retryFailedJobOp)`, `post(…/cancelJob, cancelJobOp)`)
- Modify: `firestore.rules:272-276` (spec §5 jobs read rule), `firestore.indexes.json` (eight `jobs` indexes: `firmId ASC`, then each subset of [`matterId ASC`, `status ASC`, `jobType ASC`] in that order, then `createdAt DESC`, `__name__ DESC`)
- Modify: `tests/firestore.rules.test.ts:855-944` (seed `r2jobEngine` `{ engine: "p2", firmId: "firmA", matterId: "r2m", classification: "internal", jobType: "platform.diagnostic" }`, `r2jobEngineFirm` (same, `matterId: null`), and member partner `r2-partner-m` on `r2m`; new tests below; existing assertions unchanged)
- Modify: `functions/test/g2.cross-firm.test.ts` — `PROBES` (`:65-96`): `listJobs: { data: (a) => ({ matterId: a.matterId }), target: true }`, `getJob: { data: (a) => ({ jobId: a.deadJobId }), target: true }`, `retryFailedJob: { data: (a) => ({ jobId: a.deadJobId, note: "G2 probe requeue note, long enough" }), target: true }`, `cancelJob: { data: (a) => ({ jobId: a.queuedJobId, note: "G2 probe cancel note, long enough" }), target: true }`; `HANDLER_MODULES` (`:98`) gains `jobOps` (`import * as jobOps from "../src/p2/ops"`); `FirmA` (`:113`) gains `deadJobId`, `queuedJobId`; seed (`:165-215`): two firm-A `platform.diagnostic` jobs on `matterId` via `enqueueJob` (`createdBy` = A's partner, label `internal`), the first then set `status: "dead_lettered"`, `lastError: { code: "diag_failure", message: "Diagnostic failure (planned)." }`; `snapshotFirmA` (`:129-147`) adds `{ status, manualRetries, dispatchSeq, cancellation }` of both; `firmATokens` (`:150-152`) adds both ids; positive control (`:268-276`) reads `getJob { jobId: A.deadJobId }` and `listJobs { matterId: A.matterId }`, token `A.deadJobId`
- Modify: `functions/test/p2.boot.test.ts` (new case: with every layer flag off, `createRouter(ROUTES)` builds and `ROUTES` paths include exactly the four `/api/platform/jobs/*` paths: P2 is CORE, L8456)
- Test: `tests/p5.permission-job-actions.test.ts`, `functions/test/p2.view.test.ts` (unit), `functions/test/p2.jobs-api.emu.test.ts`

**Interfaces:**
- Consumes: Tasks 2-4 (`JobRow`, `handlerFor`, `runtimeDeps`, `jobRuntime`, `testDeps`, `InProcessDispatcher`), `parsePage`/`encodeCursor`/`decodeCursor`, `isSafeDocId`, `rankOf`, `isKnownClassification`.
- Produces (decision table): `JOB_ACTIONS = ["job.read", "job.queue", "job.retry", "job.cancel"] as const`; roles: read → partner, associate, clerk; queue → partner; retry → partner, associate; cancel → partner. Branch: client or `own_matters` → `client-denied`; `job.read` with `matter !== undefined` → `matterGate` (cross-firm / not-member / clearance); then the role table → `role-not-permitted`. Accounts keep `accounts-register-only` (earlier row).
- Produces (`view.ts`): `type Visibility = "none" | "restricted" | "full"`; `visibilityOf(caller: Caller, job: DocumentData | undefined, isMember: boolean): Visibility` (P3-11 table: none if missing, not an engine row, other firm, unknown label, or above clearance; `matterId == null` → full for partner, else none; matter job → full for a member partner/associate/clerk, restricted for a non-member partner, else none); `jobView(id: string, job: DocumentData, visibility: "full" | "restricted", opts: { logs: boolean }): JobView` (restricted: `matterId: "restricted"`, no `inputRefs`/`outputRefs`/`logs`; never `payload`, `payloadHash`, `idempotencyKey`, `lease`; `retryable = status == "dead_lettered" && manualRetries < 3`; `cancellable = status in {queued, failed, dead_lettered} && handlerFor(jobType)?.saga === false`; `maxManualRetries: 3`).
- Produces (`ops.ts`, all `auth: "firm"`, `kind: "general"`, `target: "jobs"`): `listJobsOp` (action `"job.read"`; query validation first: `matterId` `isSafeDocId`, `status` in `JOB_STATUSES`, `jobType` `isSafeDocId`, else 400 `invalid_query`; `parsePage`; with `matterId` → `requirePermission(caller, "job.read", matterId)`, keep `full` rows; without → `requirePermission(caller, "job.queue")`, keep `full` and `restricted`; query `firmId ==` [+ filters] `orderBy createdAt desc, __name__ desc`, start after the cursor (`sortKey = "<seconds>.<nanos>"`), `limit`; non-engine rows and hidden rows are omitted; `nextCursor` = the last scanned doc when `docs.length === limit`, else null; `audit.allow()`); `getJobOp` (action `"job.read"`; `jobId` safe else 400 `invalid_query`; `requirePermission(caller, "job.read")`; read job and `matter_members/{matterId}_{uid}`; `none` → 404 `not_found`; view with `logs: true`); `retryFailedJobOp` (action `"job.retry"`; `requirePermission(caller, "job.retry")`; body `jobId` safe and `note` a string, else 400 `invalid_query`; `note.trim().length < 20` → 400 `note_too_short`; one transaction: visibility none → 404, restricted → 403 `not_member`; saga or unregistered type and caller not partner → 403 `role_not_permitted`; status ≠ `dead_lettered` → 409 `job_not_dead_lettered`; `manualRetries >= 3` → 409 `retry_limit_reached`; update `status: "queued"`, `attempts: 0`, `manualRetries + 1`, `nextAttemptAt = now`, `dispatchSeq + 1`, `dispatchedAt = now`, `updatedAt`, `finishedAt: null`, append `requeues { by, role, at, note }`, log `"requeued"`; `lastError` kept; `audit.stage(tx, "allow", "ok")`; after commit `audit.committed()` then `runtimeDeps().dispatcher.dispatch({ jobId, seq })`; returns the full view); `cancelJobOp` (action `"job.cancel"`, partner; same body checks; visibility none → 404, restricted → 403 `not_member`; saga or unregistered → 409 `job_not_cancellable`; `running` → 409 `job_running`; `done`/`cancelled` → 409 `job_finished`; update `status: "cancelled"`, `cancellation`, `lease: null`, `nextAttemptAt: null`, `finishedAt`, `updatedAt`, log `"cancelled"`, staged audit; returns the view). `now` is `session.now ?? Date.now()`.

- [ ] **Step 1: Write the failing permission and view unit tests.** `tests/p5.permission-job-actions.test.ts`:

```ts
const MATRIX = { "job.read": PAC, "job.queue": P, "job.retry": PA, "job.cancel": P }
it("exports the 4 job actions", () => expect([...JOB_ACTIONS].sort()).toEqual(Object.keys(MATRIX).sort()))
it("the role table, 6 roles × 4 actions, firm-level", () => {
  for (const [action, allowed] of Object.entries(MATRIX)) for (const role of ROLES)
    expect([action, role, decide(caller(role), action, undefined, false)]).toEqual([action, role,
      allowed.includes(role) ? { allow: true, reason: "ok" } : { allow: false, reason: role === "client" ? "client-denied" : role === "accounts" ? "accounts-register-only" : "role-not-permitted" }])
})
it("job.read with a matter: cross-firm, not-member, clearance, then the role", () => {
  expect(decide(caller("associate"), "job.read", { firmId: "f2", classification: "internal" }, true)).toEqual({ allow: false, reason: "cross-firm" })
  expect(decide(caller("partner"), "job.read", matter, false)).toEqual({ allow: false, reason: "not-member" })
  expect(decide({ ...caller("clerk"), clearanceLevel: "internal" }, "job.read", matter, true)).toEqual({ allow: false, reason: "clearance" })
  expect(decide(caller("clerk"), "job.read", matter, true)).toEqual({ allow: true, reason: "ok" })
  expect(decide(caller("associate"), "job.read", matter, true, { scope: "own_matters" })).toEqual({ allow: false, reason: "client-denied" })
})
```

  `functions/test/p2.view.test.ts`: `visibilityOf` over partner/associate/clerk × member or not × `matterId` null or set × clearance at or below the job label (a `confidential` job: an `internal` caller → `none`); intern, client → `none`; other firm, unknown label, missing, non-engine → `none`; `jobView` restricted keys `not.toHaveProperty` `inputRefs`, `outputRefs`, `logs`, `payload`, `payloadHash`, `idempotencyKey`, `lease` and `matterId === "restricted"`; full view has `inputRefs` and, with `logs: true`, ISO `at`; `retryable`/`cancellable` per status and saga.

- [ ] **Step 2: Write the failing rules tests** (`tests/firestore.rules.test.ts`, the R-2 block):

```ts
it("engine job rows (engine: \"p2\") are denied to every SDK reader (P3-14)", async () => {
  await assertFails(getDoc(doc(await authed("r2-clerk", CLERK_MEMBER), "jobs", "r2jobEngine")))
  await assertFails(getDoc(doc(await authed("r2-partner-m", { firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted" }), "jobs", "r2jobEngine")))
  await assertFails(getDoc(doc(await authed("r2-partner-c", { firmId: "firmA", role: "partner", clearanceLevel: "confidential" }), "jobs", "r2jobEngineFirm")))
  await assertSucceeds(getDoc(doc(await authed("r2-clerk", CLERK_MEMBER), "jobs", "r2job")))  // the Next.js writer's row: unchanged
})
```

- [ ] **Step 3: Write the failing API tests** (`p2.jobs-api.emu.test.ts`, suite "P2 jobs API (P3-10..P3-13)"; `jobRuntime.deps = testDeps(clock)` in `beforeEach`, deleted in `afterEach`; firm with partner P (member of matter M), associate A (member), clerk C (member), intern, accounts, client, non-member partner P2 (`confidential`), all `privileged-restricted` unless stated; jobs on M enqueued at `T0 + i`):

```ts
it("getJob: partner, associate, clerk members read the full view; intern, accounts, client are refused", async () => {
  expect(await getJob(P, { jobId })).toMatchObject({ jobId, matterId: M, status: "queued", maxAttempts: 4, maxManualRetries: 3, retryable: false, cancellable: true, inputRefs: [], logs: [expect.objectContaining({ event: "enqueued" })] })
  expect(view).not.toHaveProperty("payload"); expect(view).not.toHaveProperty("idempotencyKey"); expect(view).not.toHaveProperty("lease")
  for (const [who, code] of [[intern, "role_not_permitted"], [accounts, "accounts_register_only"], [client, "client_denied"]]) expectKind(await apiErrorOf(getJob(who, { jobId })), "permission-denied", code)
})
it("a non-member partner sees the restricted view and cannot retry or cancel (403 not_member)", async () => {
  expect(v.matterId).toBe("restricted"); expect(v).not.toHaveProperty("logs"); expect(v).not.toHaveProperty("inputRefs")
  expectKind(await apiErrorOf(retry(P2, { jobId: dead, note })), "permission-denied", "not_member")
})
it("firm-level jobs are partner-only; a job above the caller's clearance is 404", async () => {
  // matterId null: P → 200; A, C → 404 not_found. A "privileged" job on M read by a member associate cleared "internal" → 404 not_found
})
it("listJobs: the firm queue (partner) and a matter's jobs (members), newest first, filtered and paginated with omitted rows", async () => {
  // 5 jobs at T0..T0+4, the one at T0+3 labelled "privileged"; caller P2 (confidential), limit=2
  expect(ids(page1)).toEqual([j4]); expect(page1.nextCursor).not.toBeNull()
  expect(ids(page2)).toEqual([j2, j1]); expect(ids(page3)).toEqual([j0]); expect(page3.nextCursor).toBeNull()
  // with matterId=M as A → only full rows; without matterId as A → 403 role_not_permitted; matterId of another firm → 403 cross_firm;
  // non-member associate with matterId=M → 403 not_member; status=dead_lettered and jobType filters narrow the list
  for (const q of [{ status: "x" }, { jobType: "a/b" }, { matterId: "a/b" }]) expectKind(await apiErrorOf(list(P, q)), "invalid-argument", "invalid_query")
  expectKind(await apiErrorOf(list(P, { limit: "0" })), "invalid-argument", "invalid_limit")
  expectKind(await apiErrorOf(list(P, { cursor: "!!" })), "invalid-argument", "invalid_cursor")
})
it("retryFailedJob requeues a dead-lettered job, keeps lastError, dispatches, and stops after 3", async () => {
  expect(await retry(A, { jobId: dead, note })).toMatchObject({ status: "queued", attempts: 0, manualRetries: 1, lastError: { code: "diag_failure" } })
  expect(row.requeues).toEqual([expect.objectContaining({ by: A.uid, role: "associate", note })]); expect(row.dispatchSeq).toBe(prevSeq + 1)
  expect(d.dispatcher.tasks.at(-1)).toEqual({ jobId: dead, seq: prevSeq + 1, scheduleAt: null })
  // manualRetries 3 → 409 retry_limit_reached; status done → 409 job_not_dead_lettered; note of 19 chars → 400 note_too_short;
  // jobId "a/b" or note 5 (number) → 400 invalid_query; clerk → 403 role_not_permitted
})
it("retryFailedJob: a saga job type needs a partner", async () => {
  expectKind(await apiErrorOf(retry(A, { jobId: sagaDead, note })), "permission-denied", "role_not_permitted")
  expect(await retry(P, { jobId: sagaDead, note })).toMatchObject({ status: "queued", manualRetries: 1 })
})
it("retryFailedJob replays the first answer for the same Idempotency-Key", async () => {
  // two calls with headers { "idempotency-key": k } → identical bodies; row.manualRetries 1; row.requeues length 1
})
it("cancelJob: queued, failed and dead-lettered cancel; running, done, cancelled and saga types are refused", async () => {
  expect(await cancel(P, { jobId: q, note })).toMatchObject({ status: "cancelled", cancellable: false })
  expect(row.cancellation).toMatchObject({ by: P.uid, role: "partner", note }); expect(row.lease).toBeNull()
  // failed, dead_lettered → 200; running → 409 job_running; done, cancelled → 409 job_finished; test.saga → 409 job_not_cancellable;
  // associate → 403 role_not_permitted; a task delivered after the cancel → "dropped"
})
it("a parallel cancel and claim: exactly one wins", async () => {
  const [c, w] = await Promise.allSettled([cancel(P, { jobId, note }), d.dispatcher.deliver({ jobId, seq: 0 }, T0)])
  const cancelled = c.status === "fulfilled"
  expect(cancelled ? [row.status, (w as PromiseFulfilledResult<string>).value, count] : [row.status, ((c as PromiseRejectedResult).reason as ApiError).status, count])
    .toEqual(cancelled ? ["cancelled", "dropped", 0] : ["done", 409, 1])
})
it("cross-firm: getJob, retryFailedJob and cancelJob on another firm's jobId answer 404 and change nothing; one idempotency key in two firms makes two jobs", async () => {
  // firm-B partner, X-Firm-Id B, firm-A ids → 404 not_found each; X-Firm-Id A → 403 firm_mismatch; firm-A rows' updateTime unchanged;
  // listJobs as firm-B partner never returns a firm-A id; enqueue key "shared" in A and B → two ids
})
it("poison: a raw error carrying a payload value never reaches lastError, logs, events, audit, alerts or the API", async () => {
  // marker = `poison-${randomUUID()}`; throw_raw job driven through 4 deliveries to dead_lettered; logger spies on info/warn/error
  const sources = [row.lastError, row.logs, events, auditRows, d.alerts, spies.flatMap((s) => s.mock.calls), await getJob(P, { jobId }), await list(P, {})]
  expect(JSON.stringify(sources)).not.toContain(marker)
  expect(row.lastError).toEqual({ code: "internal", message: "The job failed with an internal error." })
})
```

- [ ] **Step 4: Run** `npx vitest run tests/p5.permission-job-actions.test.ts`, `cd functions && npx vitest run test/p2.view.test.ts test/p2.boot.test.ts`, `npm run test:rules`, and `npx firebase emulators:exec --only auth,firestore --project demo-sikander "cd functions && npx vitest run test/p2.jobs-api.emu.test.ts"` — FAIL.
- [ ] **Step 5: Implement** the decision-table branch, `requirePermission` widening, `view.ts`, `ops.ts`, the four routes, the rule, the indexes, the rules-test seed and the G-2 entries in this one change (G-2 fails if a route lacks its probe or module).
- [ ] **Step 6: Run** the four commands → PASS; then `npx vitest run tests/p5`, `npm --prefix functions run test:emu`, `npm run gate:g2`, `python3 ci_gates/check_route_coverage.py functions/src/http/router.ts functions/test` (still `d1 routes found: 20; d1 entries in the route table: 20`), `cd functions && npx tsc --noEmit`, `npm run typecheck`, `npm run lint` → pass.
- [ ] **Step 7: Commit** `feat(p2): /api/platform/jobs routes, job permission actions, SDK-denied engine rows, G-2 probes (P3-10..P3-14, P3-22)`.

### Task 8: Registry-version write recorder

**Files:**
- Modify: `functions/src/d1/registryVersion.ts:3-22` (header names the recorder) and add `REGISTRY_SCOPE`
- Create: `functions/test/setup/registryWriteRecorder.ts`
- Modify: `functions/vitest.config.ts:4-17` (`setupFiles: ["test/setup/registryWriteRecorder.ts"]`)
- Test: `functions/test/p2.registry-discipline.emu.test.ts` (suite `"Registry-version discipline (P3-20)"`)

**Interfaces:**
- Produces: `REGISTRY_SCOPE: Readonly<Record<string, { all: true } | { except: readonly string[] } | { only: readonly string[] }>>` = `clients`, `matter_parties`, `entity_links`, `transliteration_map` → `{ all: true }`; `matters` → `{ except: ["stage"] }`; `firms` → `{ only: ["featureFlags"] }`.
- Produces (`registryWriteRecorder.ts`): `type RegistryViolation = { file: string; line: number; collection: string; reason: "no_bump" | "outside_transaction" }`; `registryRecorder: { take(): RegistryViolation[]; attributeTo(site: string | null): void; readsDuring<T>(fn: () => Promise<T>): Promise<Set<string>> }`; an `afterEach` that throws `registry write without bumpRegistryVersion: <file>:<line> (<collection>)` for each violation left untaken.

Recorder rules (the part the signatures do not fix):

```text
patch Transaction.prototype.{create,set,update,delete}, WriteBatch.prototype.{same}, DocumentReference.prototype.{same},
  Firestore.prototype.runTransaction (wrap updateFunction), Query.prototype.get and DocumentReference.prototype.get (read log)
site = attributeTo override, else the first stack frame outside node_modules and outside this file; product iff it lies under functions/src/
registry write = collection in REGISTRY_SCOPE and: delete; or create / non-merge set whose data names an in-scope field;
  or update / merge set touching an in-scope field (top-level segment of each field path; `except` = any field but those; `only` = those)
bump = a set on counters/<firmId>_registry
per transaction attempt: record product registry writes (with firmId from the data when present) and bumped firm ids;
  when updateFunction resolves: each write needs a bump for its firmId (or any bump when the data names none) → else no_bump
product registry write through WriteBatch or DocumentReference → outside_transaction
readsDuring(fn): collection ids of every get() started while fn runs
```

- [ ] **Step 1: Write the failing tests:**

```ts
it("registry discipline: a product transaction that writes a registry collection without bumpRegistryVersion is reported", async () => {
  registryRecorder.attributeTo("functions/src/fake/product.ts:1")
  try {
    await db.runTransaction(async (tx) => tx.update(clientRef, { name: "X" }))
    expect(registryRecorder.take()).toEqual([{ file: "functions/src/fake/product.ts", line: 1, collection: "clients", reason: "no_bump" }])
    await db.runTransaction(async (tx) => { tx.update(clientRef, { name: "Y" }); bumpRegistryVersion(tx, firmId) }); expect(registryRecorder.take()).toEqual([])
    await db.runTransaction(async (tx) => tx.update(matterRef, { stage: "filed" })); expect(registryRecorder.take()).toEqual([])
    await db.runTransaction(async (tx) => tx.update(matterRef, { title: "T" })); expect(registryRecorder.take().map((v) => v.collection)).toEqual(["matters"])
    await db.runTransaction(async (tx) => tx.set(firmRef, { clientPrefix: "AB" }, { merge: true })); expect(registryRecorder.take()).toEqual([])
    await db.runTransaction(async (tx) => tx.set(firmRef, { featureFlags: { L17_2_ENABLED: false } }, { merge: true })); expect(registryRecorder.take().map((v) => v.collection)).toEqual(["firms"])
    await linkRef.update({ state: "rejected" }); expect(registryRecorder.take().map((v) => v.reason)).toEqual(["outside_transaction"])
  } finally { registryRecorder.attributeTo(null) }
  await db.runTransaction(async (tx) => tx.update(clientRef, { name: "Z" })); expect(registryRecorder.take()).toEqual([])   // a test-file write
})
it("registry discipline: loadRegistry reads exactly the collections in REGISTRY_SCOPE", async () => {
  expect([...(await registryRecorder.readsDuring(() => loadRegistry(firmId, new Date(T0))))].sort()).toEqual(Object.keys(REGISTRY_SCOPE).sort())
})
```

- [ ] **Step 2: Run** `npx firebase emulators:exec --only auth,firestore --project demo-sikander "cd functions && npx vitest run test/p2.registry-discipline.emu.test.ts"` — FAIL.
- [ ] **Step 3: Implement** `REGISTRY_SCOPE`, the setup file and the `setupFiles` entry.
- [ ] **Step 4: Run** the same → PASS; then `npm --prefix functions run test:emu` → PASS with the recorder active over every existing suite (registerClient, openMatter, closeMatter, confirmMerge, disputeLink, rejectLink bump; advanceStage writes only `stage`). A failure here is a real missing bump: fix the product code under superpowers:systematic-debugging, never the recorder's scope. Also `npm run gate:g2`, `cd functions && npx tsc --noEmit`, `npm run lint` → pass.
- [ ] **Step 5: Commit** `test(d1): runtime registry-version write recorder over every emulator suite (P3-20)`.

### Task 9: G-4 Phase 3a gate, CI wiring, records

**Files:**
- Modify: `ci_gates/check_route_coverage.py:18-62` (`--domain <d>`, default `d1`), `ci_gates/test_check_route_coverage.py` (new cases)
- Create: `ci_gates/gate_g4_phase3a.sh`
- Modify: `package.json:21` (`"gate:g4:phase3a": "bash ci_gates/gate_g4_phase3a.sh"`), `.github/workflows/gate-g0.yml:176-178` (after the 2b-A step: name "Gate G-4 Phase 3a close (routes, boot, job invariants, registry discipline, functions lint, G-2)", `if: ${{ !cancelled() }}`, `run: npm run gate:g4:phase3a`)
- Modify: `docs/architecture/ERRATUM_SET_2_PROPOSED.md` (title line 4 and §ES2-1 heading `:34` to "E-23 to E-42"; row **E-42** after `:58`, verbatim from spec Appendix A; open items O-30..O-35 after `:118`, verbatim; `:120` "O-15 to O-35 are new")
- Modify: `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md` (append "## Phase 3a rulings": P3-1..P3-23 by reference to the spec, one line each with the deciding value; O-30..O-35 rows; "Phase 3a close is Gate G-4 (`npm run gate:g4:phase3a`)"), `docs/superpowers/plans/2026-09-30-phase1-foundation.md:172` (Phase 3 becomes "Phase 3a P2 job engine core · 3b un-merge saga · 3c O-28 auto-confirm job · then the AI layer (P1 cost log, 70/90% alerts, kill switch, Opik self-hosted)", per P3-1)

**Interfaces:**
- Produces (`check_route_coverage.py`): usage `check_route_coverage.py [--domain D] <router.ts> <tests-dir>`; prefix `/api/<D>`; route constants are any `const NAME = "<prefix>"` or `"<prefix>/<service>"`; routes are `${NAME}/<fn>` paths and full literals under the prefix; output `"<D> routes found: N; <D> entries in the route table: M"` and `PASS`/`FAIL` lines with `<D>` in place of `d1`. Default output is byte-identical to today.
- Produces (`gate_g4_phase3a.sh`, modelled on `gate_g4_phase2b_a.sh`, same emulator-config and `--inner` handling): [1] the checker with no flag must print `d1 routes found: 20; d1 entries in the route table: 20`, and with `--domain platform/jobs` `platform/jobs routes found: 4; platform/jobs entries in the route table: 4`; [2] `npx vitest run test/d1.boot.test.ts test/p2.boot.test.ts`; [3] under the emulators `npx vitest run test/p2.jobs-invariants.emu.test.ts test/p2.registry-discipline.emu.test.ts -t "${G4C_FILTER:-<anchored, escaped alternation of the 7 full names>}" --reporter=json`, passing only if `numPassedTests === 7 && numFailedTests === 0` and the passed full names equal exactly the seven (suite name + space + test name); [4] `npx eslint --max-warnings 0 functions`; [5] `bash ci_gates/gate_g2.sh`. Full names: `"P2 job engine invariants (P3-4, P3-6..P3-8) P2 invariant: duplicate delivery commits the effect exactly once"`, `… P2 invariant: a lease that expires mid-handler is reclaimed and the stale commit is discarded`, `… P2 invariant: a failing job retries at 1s, 5s and 25s, then dead-letters with job.deadLettered`, `… P2 invariant: enqueue is idempotent and a job exists iff its transaction committed`, `… P2 invariant: skewed clocks never dispatch a job twice in one sweep or run a fifth attempt`, `"Registry-version discipline (P3-20) registry discipline: a product transaction that writes a registry collection without bumpRegistryVersion is reported"`, `… registry discipline: loadRegistry reads exactly the collections in REGISTRY_SCOPE`.

- [ ] **Step 1: Write the failing pytest cases:**

```python
def test_platform_jobs_domain(tmp_path):
    router = 'const PLATFORM_JOBS = "/api/platform/jobs"\nexport const ROUTES = [\n  get(`${PLATFORM_JOBS}/listJobs`, a),\n  post(`${PLATFORM_JOBS}/cancelJob`, b),\n]\n'
    r = run(tmp_path, router, {"a.test.ts": 'viaApi("listJobs")'}, args=["--domain", "platform/jobs"])
    assert r.returncode == 1
    assert "platform/jobs routes found: 2; platform/jobs entries in the route table: 2" in r.stdout
    assert "/api/platform/jobs/cancelJob" in r.stdout
def test_default_domain_ignores_platform_routes(tmp_path):
    r = run(tmp_path, ROUTER + 'const PLATFORM_JOBS = "/api/platform/jobs"\n  get(`${PLATFORM_JOBS}/getJob`, g),\n', COVERED)
    assert "d1 routes found: 3; d1 entries in the route table: 3" in r.stdout and r.returncode == 0
```

  (`run` gains an `args=()` parameter passed before the two paths.)
- [ ] **Step 2: Run** `python3 -m pytest ci_gates/test_check_route_coverage.py` — the new cases FAIL, the existing ones PASS.
- [ ] **Step 3: Implement** the `--domain` option, the gate script, the npm script, the CI step and the three documents.
- [ ] **Step 4: Run** `python3 -m pytest ci_gates/test_check_route_coverage.py`, `npm run gate:g4:phase3a`, `npm run gate:g4:phase2b-a`, `npm run gate:g4:phase2a`, `npm run gate:g2`, `npm run test:rules`, `npm run test:unit`, `npm --prefix functions run test:emu`, `npm run lint`, `npm run typecheck`, `cd functions && npx tsc --noEmit` → all PASS. Prove the gate can fail: `G4C_FILTER="no such test" npm run gate:g4:phase3a` exits non-zero.
- [ ] **Step 5: Commit** `ci(gates): G-4 phase-close for Phase 3a; route coverage by domain; E-42 and O-30..O-35`.
