# P2 job engine

Durable, retried, audited background jobs (spec `docs/superpowers/specs/2026-10-08-phase3a-job-engine-design.md`). A job row in `jobs/{jobId}` is the source of truth; Cloud Tasks only delivers wake-ups.

## Scheduled jobs

A scheduled job is a cron tick that enqueues one run per firm per period. The run key is `${jobType}:${periodKey}` and is also the idempotency key, so a repeated tick or a backfill reuses the existing run (P3-16). Period keys are PKT (Asia/Karachi, UTC+5): hour `YYYY-MM-DDTHH`, day `YYYY-MM-DD`, ISO week `YYYY-Www`, month `YYYY-MM`.

| jobType | Cron (PKT) | Period |
| --- | --- | --- |
| none in Phase 3a | | |

To add one: register its handler in `registry.ts`, add a `ScheduledJobSpec` to `SCHEDULED_JOBS` in `scheduled.ts`, and export `scheduledJobFunction(spec)` from `functions.ts` (and list the export in `NOT_TENANT_ENDPOINTS` in `functions/test/g2.cross-firm.test.ts`).

The sweeper (`jobSweeper`, every minute) is the engine's heartbeat, not a P2 job: it re-dispatches lost dispatches and expired leases and is not in `SCHEDULED_JOBS`.

## Dead-letter runbook

A job that exhausts its attempts becomes `dead_lettered` and the engine writes one structured log line:

    logger.error("job.deadLettered", { jobId, firmId, jobType, code, ... })

carrying codes only, never payload values. Create the log-based alert policy at deploy (open item O-30): filter on `severity=ERROR` and `jsonPayload.message="job.deadLettered"` (or the log message `job.deadLettered`), notify the on-call channel. To recover: read the job (`getJob`), fix the cause, then call `retryFailedJob` (up to 3 manual retries per job). A job that should not run again is closed with `cancelJob`.

## Backfill

    npm --prefix functions run build
    npm --prefix functions run jobs:backfill -- <jobType> <from> <to>

`<from>` and `<to>` are inclusive period keys for the job's period (for example `2026-10-01 2026-10-07` for a daily job). At most 366 periods per call. It runs against the project in the ambient Admin credentials (`GOOGLE_APPLICATION_CREDENTIALS` / `GCLOUD_PROJECT`, or `FIRESTORE_EMULATOR_HOST` for the emulator). Re-running it is safe: runs that exist are reused. Exit codes: 0 done, 2 unknown job type or bad range, 64 wrong arguments, 1 store failure.
