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
| `ai.kill_switch_blocked` | warning | firm and switch | the P1 commit of a call the switch refused |
| `ai.reservation_failed` | high | firm | the P1 commit of a call refused because its reservation or attempt record failed |
| `ai.reservation_unresolved` | high | firm | `alertChecker`: reservations held 10 minutes past their lease, or quarantined |

An alert carries codes, ids, integers and document references only (`detail`, `subjectKey`, `ref`), never a payload, a note or client text.

## Lifecycle

- **Raise.** The first raise creates the alert `open` at level 0 (owner: the on-call operator) with an acknowledgment deadline (critical 15 minutes, high 30 minutes, warning 4 hours) and one page. Later raises count it (`count`, `lastSeenAt`) and page no one. A raise after `resolved` reopens it as a new episode at level 0 with a new page.
- **Escalation.** `alertEscalator` (every minute) moves an `open` alert past its deadline one level up: level 1, the firm's partners (a `notifications` row each), then level 2, the firm administrator (the founding partner recorded in `platform_onboarding`; the partners if that user is no longer an active partner). Each step raises the severity one step and pages the new owner and the on-call channel. Level 2 is the last.
- **Acknowledge / resolve.** A partner, through `POST /api/platform/alerts/acknowledgeAlert` or `resolveAlert` (`{ alertId }`), once the alert has reached level 1; the operator at any level through `POST /api/platform/alerts/operatorAlertAction` (`{ alertId, action }`, `platformAdmin` claim). Acknowledging stops escalation; resolving closes the alert. Partners see the worklist through `GET /api/platform/alerts/listAlerts` (`?state=open|acknowledged|resolved&limit&cursor`).

## Log lines and their policies

All three are ERROR lines registered in `infra/deploy-manifest.json` and rendered into `infra/terraform/alerts.tf`, which notifies the on-call channel (`var.oncall_email`).

- `ops_alert.notified` — one per page delivered (`pageId`, `alertId`, `firmId`, `condition`, `severity`, `level`, `ownerRole`, `episode`, `users`, `fallback`). This is the page: read the alert (`ops_alerts/{alertId}`, or `listAlerts` as a partner of the firm), act, then acknowledge or resolve it.
- `ops_alert.raise_failed` — an alert could not be written (`condition`, `firmId`, `subjectKey`, `code`). The condition is real and its durable record is missing, usually because Firestore itself is failing. The sweeper or the checker derives it again on its next run; if the line repeats, treat the Firestore outage as the incident.
- `ops_alert.pass_failed` — one pass of the escalator (`escalate`, `deliver`) or the checker (`jobs`, `sagas`, `reservations`) failed (`code`). A missing composite index is the usual first cause after a deploy: deploy `firestore.indexes.json` (`firebase deploy --only firestore:indexes`) and wait for the indexes to build. A page whose delivery failed stays pending and is retried on the next run.

## Runbook by condition

- `job.dead_lettered`: read the job (`getJob`), fix the cause, then `retryFailedJob` (up to 3 manual retries) or `cancelJob`. Resolve the alert once the job is done or cancelled.
- `job.dispatch_stalled`, `job.queue_age`: the job queue is not delivering. Check the Cloud Tasks queue for `jobWorker` (paused, IAM: the runtime account needs the Cloud Tasks Enqueuer role and the invoker binding on `jobWorker`), then the worker's errors. The rows recover on their own once dispatch works (the sweeper keeps re-dispatching); resolve the alert when `listJobs` shows them moving.
- `job.commit_failed`: the worker could not commit an outcome (Firestore unavailable or contended). The row stays `running`; lease recovery re-runs it. Repeated: treat Firestore as the incident.
- `saga.age`: an un-merge whose jobs are stuck. Look up the merge event (`ref`), then its two jobs (`d1.unmerge.links`, `d1.unmerge.checks`) in `listJobs`; a dead-lettered saga job needs a partner's retry.
- `ai.budget_threshold`: the firm has spent 70 or 90 percent of its monthly AI budget. A partner raises the budget (`setBudgetAlerts`) or accepts the stop at 100 percent.
- `ai.kill_switch_blocked`: AI calls are being refused by a kill switch. Confirm it is intended; acknowledge.
- `ai.reservation_failed`, `ai.reservation_unresolved`: AI spend could not be reserved, or reserved spend is not being settled. Check the reconciler (`p1.reconcile_*` lines) and the P1 README runbook for a quarantined reservation; the firm is refused `accounting_indeterminate` until it is settled.

## Not demonstrated here

A deployed Cloud Monitoring policy, the on-call email arriving, and any SMS or pager. The schedules running in Cloud Scheduler and the composite indexes built in a real project.
