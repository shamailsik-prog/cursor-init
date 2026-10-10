# P2 job engine

Durable, retried, audited background jobs (spec `docs/superpowers/specs/2026-10-08-phase3a-job-engine-design.md`). A job row in `jobs/{jobId}` is the source of truth; Cloud Tasks only delivers wake-ups.

## Handler contract

A handler is registered in `registry.ts` as `{ jobType, saga, errorCodes, parse, run }` (spec P3-6):

- `parse(payload)` validates the payload; any rejection is the permanent `invalid_payload`.
- `run(ctx)` returns `{ apply?(tx), outputRefs? }`. `apply` stages Firestore writes (no reads) that commit with `done`, once. A write Firestore rejects at commit (for example `tx.create` on an existing doc) is recorded as the retryable `internal` failure and nothing of the result is written.
- `ctx.runFenced(stepId, fn)` runs `fn(tx)` in a transaction that checks the claim's lease fence and records `stepId` on the job in the same commit. A step already recorded (by an earlier attempt that crashed or failed, or before a manual requeue) is skipped and returns `undefined`, so a fenced effect commits exactly once per job. Use a fixed, distinct step id per effect (`[A-Za-z0-9_-]{1,100}`, not `__..__`, at most 50 per job; violations are permanent `invalid_fenced_step` / `fenced_step_limit`). Derive later steps from Firestore state, not from a skipped step's return value.
- Handlers must be idempotent: delivery is at least once, and effects outside Firestore happen at least once and should carry the job id or a key.

## Scheduled jobs

A scheduled job is a cron tick that enqueues one run per firm per period. The run key is `${jobType}:${periodKey}` and is also the idempotency key, so a repeated tick or a backfill reuses the existing run (P3-16). Period keys are PKT (Asia/Karachi, UTC+5): hour `YYYY-MM-DDTHH`, day `YYYY-MM-DD`, ISO week `YYYY-Www`, month `YYYY-MM`.

| jobType | Cron (PKT) | Period |
| --- | --- | --- |
| none in Phase 3a | | |

To add one: register its handler in `registry.ts`, add a `ScheduledJobSpec` to `SCHEDULED_JOBS` in `scheduled.ts`, and export `scheduledJobFunction(spec)` from `functions.ts` (and list the export in `NOT_TENANT_ENDPOINTS` in `functions/test/g2.cross-firm.test.ts`).

The sweeper (`jobSweeper`, every minute) is the engine's heartbeat, not a P2 job: it re-dispatches lost dispatches and expired leases and is not in `SCHEDULED_JOBS`.

How the sweeper picks rows (P3-34 to P3-36, O-36): every row carries `sweepAt`, the earliest time the sweeper may act on it, written with every status change (enqueue and manual requeue: now + 30 s; scheduled retry: `nextAttemptAt` + 30 s; claim: the lease expiry; terminal: null). Query B runs first and takes `running` rows with `sweepAt <= now` (expired leases); query A takes `queued` and `failed` rows with `sweepAt <= now`, and query A' `queued` and `failed` rows whose `sweepAt` lies more than 600 s ahead (stamped by a clock running fast). Each row is still re-read in its own transaction, which decides. A re-dispatch backs off `min(30 s × 2^redispatches, 600 s)`, so a row waiting in a busy queue gets 1 + 9 tasks in its first hour and 6 per hour after that, instead of one every sweep. Each query reads up to 5 pages of 100 rows per sweep, and a sweep stops after 30 s of wall-clock time; the next minute's sweep continues. Load test: `functions/test/p2.jobs-load.emu.test.ts`.

## Deploy prerequisites

Derived from what the code calls (`dispatch.ts` enqueues on the `jobWorker` task queue through the Admin SDK; `functions.ts` declares `jobWorker` as a task-queue function with no `invoker`). Confirm them at the first deploy; none can be proved without one.

- **Cloud Tasks API** (`cloudtasks.googleapis.com`) enabled on the project. `CloudTasksDispatcher` enqueues through `getFunctions(adminApp()).taskQueue("locations/asia-south1/functions/jobWorker")`, and Cloud Tasks hosts that queue.
- **Cloud Tasks Enqueuer** (`roles/cloudtasks.enqueuer`) for the runtime service account of the functions that call `dispatch` (`api` for `retryFailedJob`, `onJobCreated`, `jobWorker` for retries and `jobSweeper`). By default that is the project's default compute service account. If the dispatch also needs to act as the queue's OIDC service account, that runtime account needs Service Account User (`roles/iam.serviceAccountUser`) on it.
- **Cloud Run Invoker** (`roles/run.invoker`) on `jobWorker` for the service account Cloud Tasks uses to call it with an OIDC token. `jobWorker` is IAM-private by design (no `invoker` is set, and `p2.boot.test.ts` pins that), so without this binding every delivery is rejected with 403 and jobs stay `queued`.

Until these are in place a dispatch fails silently from the job's point of view: the row stays `queued`, each sweep re-stamps it and logs `job dispatch failed`, and nothing dead-letters, so the `job.deadLettered` alert never fires. Open item O-41 tracks an alert on repeated `job dispatch failed`.

## Dead-letter runbook

A job that exhausts its attempts becomes `dead_lettered` and the engine writes one structured log line:

    logger.error("job.deadLettered", { jobId, firmId, jobType, code, ... })

carrying codes only, never payload values. Create the log-based alert policy at deploy (open item O-30): filter on `severity=ERROR` and `jsonPayload.message="job.deadLettered"` (or the log message `job.deadLettered`), notify the on-call channel. To recover: read the job (`getJob`), fix the cause, then call `retryFailedJob` (up to 3 manual retries per job). A job that should not run again is closed with `cancelJob`.

## Backfill

    npm --prefix functions run build
    npm --prefix functions run jobs:backfill -- <jobType> <from> <to>

`<from>` and `<to>` are inclusive period keys for the job's period (for example `2026-10-01 2026-10-07` for a daily job). At most 366 periods per call. It runs against the project in the ambient Admin credentials (`GOOGLE_APPLICATION_CREDENTIALS` / `GCLOUD_PROJECT`, or `FIRESTORE_EMULATOR_HOST` for the emulator). Re-running it is safe: runs that exist are reused. Exit codes: 0 done, 2 unknown job type or bad range, 64 wrong arguments, 1 store failure or a scheduled type whose handler is not registered.
