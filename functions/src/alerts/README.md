# Operational alerts (audit F43)

Spec: `docs/superpowers/specs/2026-10-24-f43-durable-alert-delivery-design.md`. The alert document is the delivery mechanism of record; log lines only announce it.

## What raises an alert

| Condition | Severity | One alert per | Raised by |
| --- | --- | --- | --- |
| `job.dead_lettered` | high | job | the dead-letter transaction (worker, sweeper query B) |
| `job.dispatch_stalled` | high | firm and job type | the sweeper: a row re-dispatched 3 times without a claim, or waiting 15 minutes |
| `job.commit_failed` | high | firm and job type | the worker, after its finish commit fails (its own transaction, bounded to 5 s) |
| `job.queue_age` | high | firm and job type | `alertChecker`: jobs due, or past their lease, 15 minutes or more |
| `saga.age` | high | firm (un-merge saga) | `alertChecker`: an un-merge in progress 60 minutes or more |
| `ai.budget_threshold` | 70: warning, 90: high | firm, month, threshold | the P1 commit transaction that crosses it |
| `ai.kill_switch_blocked` | warning, never escalated | firm (its switch), or the platform (one alert, firm `__platform__`) | the P1 commit of a call the switch refused |
| `ai.reservation_failed` | high | firm | the P1 commit of a call refused because its reservation or attempt record failed |
| `ai.reservation_unresolved` | high | firm | `alertChecker`: reservations held 10 minutes past their lease, or quarantined |

An alert carries codes, ids, integers and document references only (`detail`, `subjectKey`, `ref`), never a payload, a note or client text.

**How the checker reads a backlog.** Each of its five queries (waiting jobs, running jobs past their lease, sagas, held reservations, quarantined reservations) is read oldest first (quarantined reservations by `quarantinedAt`) in pages of 100, at most 5 pages per query per run, from a cursor kept in `platform/opsAlertChecker` (server-only). After a query's last page the cursor is cleared and the next run starts again from the oldest row; a run whose 40 s budget runs out keeps its place. The pass that starts a run rotates (`nextPass` in the same document), so no pass is starved by a slow one. The bound: in runs that read their full window of 500 rows, a row present when a query's cycle begins is read within ceil(N / 500) runs, and a row that appears behind the cursor within 2·ceil(N / 500) − 1 runs; if the budget ends runs instead, within 3·(2·ceil(N / 100) − 1) runs. A checker alert's counts (`waiting`, `inProgress`, `unresolved`, `quarantined`) are of the rows that run read, not the whole backlog. Deleting `platform/opsAlertChecker` is safe: the checker restarts every query from the oldest row and the rotation from the jobs pass.

**Cleared alerts.** When the checker reads all of a pass's queries in one run and no longer observes a `job.queue_age`, `saga.age` or `ai.reservation_unresolved` condition, its open alert gets `clearedAt` and loses its deadline: it stops escalating, stays open in the worklist, and still needs a person to resolve it. If the condition comes back, the alert is counted, `clearedAt` is removed and the deadline at its level restarts.

## Lifecycle

- **Raise.** The first raise creates the alert `open` at level 0 (owner: the on-call operator) with an acknowledgment deadline (critical 15 minutes, high 30 minutes, warning 4 hours) and one page. Later raises count it (`count`, `lastSeenAt`) and page no one. A raise after `resolved` reopens it as a new episode at level 0 with a new page.
- **Acknowledgment holds four hours.** A raise of an `acknowledged` alert within 4 hours of the acknowledgment is counted; a raise 4 hours or more after it is a new incident: a new episode at level 0, with a deadline and a page (`ACK_HOLD_MS`). So acknowledging silences a condition's continuing symptoms while you work on it, not its next incident. Resolve the alert when the condition is fixed.
- **Escalation.** `alertEscalator` (every minute) moves an `open` alert past its deadline one level up: level 1, the firm's partners (a `notifications` row each), then level 2, the firm administrator (the founding partner recorded in `platform_onboarding`; the partners if that user is no longer an active partner). Each step raises the severity one step and pages the new owner and the on-call channel. Level 2 is the last step; from then on the escalator re-pages level 2 and the on-call channel every 15 minutes (`…_l2_r1`, `…_l2_r2`, …) until someone acknowledges or resolves the alert.
- **Kill switches do not escalate.** A kill switch is set deliberately (by a partner, or by a platform admin), so `ai.kill_switch_blocked` pages the on-call operator once at level 0 and has no deadline. Its acknowledgment holds while the switch stays on. The platform switch is one alert for the whole platform (firm `__platform__`), which only the operator route reaches.
- **Acknowledge / resolve.** A partner, through `POST /api/platform/alerts/acknowledgeAlert` or `resolveAlert` (`{ alertId }`), once the alert has reached level 1; the operator at any level through `POST /api/platform/alerts/operatorAlertAction` (`{ alertId, action }`, `platformAdmin` claim). Acknowledging stops escalation (for 4 hours of recurrences, above); resolving closes the alert. Partners see the worklist through `GET /api/platform/alerts/listAlerts` (`?state=open|acknowledged|resolved&limit&cursor`).

## Log lines and their policies

All three are ERROR lines registered in `infra/deploy-manifest.json` and rendered into `infra/terraform/alerts.tf`, which notifies the on-call channel (`var.oncall_email`). Each registered event has a log-based alert policy of its own (a log-match condition must be its policy's only one), rate-limited to one notification per 5 minutes and closed after 30 minutes without a match; the page policy extracts `page_id`, so the rate limit applies per page and two pages in the same five minutes are two notifications. Each policy filters `resource.type="cloud_run_revision" AND severity="ERROR" AND jsonPayload.event="<event>"`: firebase-functions writes an ERROR line's message as a stack trace (`Error: <event>\n    at …`), so the filters match the structured `event` field, which every registered ERROR line carries as the last field of its data. A new ERROR line for a registered event must carry `event: "<event>"` too; `functions/test/deploy-contract-alert-runtime.test.ts` walks every emitter and fails if one does not, evaluates every filter against the real logger's output, and fails if the filters stop matching the functions' runtime (`cloud_run_revision`, every export being second generation). Delivery to a real inbox is not demonstrated in the repo.

- `ops_alert.notified` — one per page delivered (`pageId`, `alertId`, `firmId`, `condition`, `severity`, `level`, `ownerRole`, `episode`, `users`, `fallback`). This is the page: read the alert (`ops_alerts/{alertId}`, or `listAlerts` as a partner of the firm), act, then acknowledge or resolve it.
- `ops_alert.raise_failed` — an alert could not be written (`condition`, `firmId`, `subjectKey`, `code`). The condition is real and its durable record is missing, usually because Firestore itself is failing. The sweeper or the checker derives it again on its next run; if the line repeats, treat the Firestore outage as the incident.
- `ops_alert.pass_failed` — one pass of the escalator (`escalate`, `deliver`) or the checker (`cursors`, `rotation`, `jobs`, `sagas`, `reservations`, or a pass's clearing: `jobs.clear`, `sagas.clear`, `reservations.clear`) failed (`code`). A missing composite index is the usual first cause after a deploy: deploy `firestore.indexes.json` (`firebase deploy --only firestore:indexes`) and wait for the indexes to build. A page whose delivery failed stays pending and is retried on the next run.

## Runbook by condition

- `job.dead_lettered`: read the job (`getJob`), fix the cause, then `retryFailedJob` (up to 3 manual retries) or `cancelJob`. Resolve the alert once the job is done or cancelled.
- `job.dispatch_stalled`, `job.queue_age`: the job queue is not delivering. Check the Cloud Tasks queue for `jobWorker` (paused, IAM: the runtime account needs the Cloud Tasks Enqueuer role and the invoker binding on `jobWorker`), then the worker's errors. The rows recover on their own once dispatch works (the sweeper keeps re-dispatching); resolve the alert when `listJobs` shows them moving.
- `job.commit_failed`: the worker could not commit an outcome (Firestore unavailable or contended). The row stays `running`; lease recovery re-runs it. Repeated: treat Firestore as the incident.
- `saga.age`: an un-merge whose jobs are stuck. Look up the merge event (`ref`), then its two jobs (`d1.unmerge.links`, `d1.unmerge.checks`) in `listJobs`; a dead-lettered saga job needs a partner's retry.
- `ai.budget_threshold`: the firm has spent 70 or 90 percent of its monthly AI budget. A partner raises the budget (`setBudgetAlerts`) or accepts the stop at 100 percent.
- `ai.kill_switch_blocked`: AI calls are being refused by a kill switch (the firm's, or the platform's: firm `__platform__`). Confirm with whoever set it (`setBy` on the switch) that it is intended. While it stays on, acknowledge the alert: it does not escalate, and later refusals are only counted. When the switch is lifted, **resolve** the alert, so the next time a switch refuses calls is a new episode with a page; an alert left acknowledged would count that next switch into the old one.
- `ai.reservation_failed`, `ai.reservation_unresolved`: AI spend could not be reserved, or reserved spend is not being settled. Check the reconciler (`p1.reconcile_*` lines) and the P1 README runbook for a quarantined reservation; the firm is refused `accounting_indeterminate` until it is settled.

## Not demonstrated here

A deployed Cloud Monitoring policy, the on-call email arriving, and any SMS or pager. The schedules running in Cloud Scheduler and the composite indexes built in a real project.
