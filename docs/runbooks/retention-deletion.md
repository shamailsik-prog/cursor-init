# Runbook: matter deletion, legal holds and retention (audit F42)

Spec: `docs/superpowers/specs/2026-10-24-f42-retention-deletion-design.md`. Policy: `infra/retention/policy.json`
(**PROPOSED, owner ratification required**). Inventory: `infra/retention/inventory.json` (gated by
`ci_gates/check_data_inventory.py`, G-0 step 21).

## What the shipped policy does

Nothing is deleted. Every retention class is `retain`, and matter content is under legal hold, so every deletion
request is refused with `legal_hold_policy` (the refusal is recorded on the request and in the audit log), and the
daily `retention.apply` run deletes nothing. No retention period is adopted and no statute or rule is cited as the
source of any period: every proposed value in the policy file is inert and its legal basis is
**[REQUIRES VERIFICATION]**. Changing the policy is the owner's decision; record it in the policy file
(`ratifiedBy`, `ratifiedAt`, a new `policyVersion`) through a reviewed pull request.

## Deleting a matter (once the owner has ratified a deleting policy)

1. A partner whose clearance reaches the matter's label calls
   `POST /api/platform/retention/requestMatterDeletion { matterId, reasonCode }` (`reasonCode`: a short code such as
   `client_instruction`, never free text). The answer is `pending_approval`, or `refused` with the hold that refused it.
2. A **different** partner calls `POST /api/platform/retention/approveMatterDeletion { requestId }` within the approval
   window (PROPOSED 72 h). Past the window the request ends instead: the answer is `expired` (`approval_expired`),
   and a partner opens a new request (a new request also ends a lapsed one it finds, recorded as
   `retention.request_expired` in the audit log). There is no cancel: an unwanted request lapses unless a second
   partner approves it. One transaction writes the tombstone `matter_tombstones/{matterId}`, deletes every
   membership of the matter, fixes the plan on the request and enqueues the saga. From that commit on, both API
   stacks refuse the matter (`403 matter_deleted`) and omit it from every list, and no P2 job of the matter runs
   (engine code `matter_deleted`).
3. The saga (`retention.matter.prepare`, then `retention.store.purge` jobs) purges, anonymises or acknowledges every
   inventoried store. Follow it with `GET /api/platform/retention/getDeletionRequest?requestId=`: `status` becomes
   `completed` when every expected store has an acknowledgement (`acks[]`: outcome, count, SHA-256 of the ids).

Acknowledgement outcomes: `purged`, `anonymised` (the matter row keeps its id and client for the conflict screen;
P1 spend rows keep their cost), `retained` (conflict register, audit trail), `not_applicable` (no matter key),
`expiry` (TTL stores and F33 backups: `detail.windowEndsAt`), `lock_pending` (vault objects: a
`vault_object_tombstones` row each, deletion after the COMPLIANCE lock by a lifecycle rule that is **NOT DEMONSTRATED**),
`external_requested` (Opik: `deletion_external_requests/{requestId}_opik` is the summary for the operator: `count`,
`parts`, the SHA-256 of every id; the ids are in `{requestId}_opik_p0` … `_p{parts-1}`, at most 5,000 each. They are
every usage row whose call exported its trace, and every F34 decision record whose export is `exported` or still
`pending`, all recorded before the purge jobs anonymise those rows. More than 120,000 ids fails the prepare job with
`external_ids_over_limit` before anything is anonymised: the alert below fires, and the request needs an engineer.
The Opik deletion call is **NOT DEMONSTRATED**).

## Legal holds

- Place: `POST /api/platform/retention/placeLegalHold { matterId, reasonCode }` (any partner cleared for the matter).
  A hold refuses new requests and approvals (`legal_hold_matter`) and, placed while a saga runs, halts it: the next
  purge step fails permanently with `legal_hold_active`, the request records `halted`, and the job dead-letters
  (`job.deadLettered`).
- Release: `POST /api/platform/retention/releaseLegalHold { matterId }` by a partner **other than** the one who placed
  it. Releasing clears `halted`; a partner then retries the dead-lettered saga jobs (`retryFailedJob`, P3-12).

## Alert: retention.deletion_unacknowledged

`retentionDeletionWatch` (every 15 minutes) raises the F43 durable alert `retention.deletion_unacknowledged` once per
`in_progress` request whose stores are not all acknowledged by `ackDeadlineAt` (approval + PROPOSED 24 h), in the
transaction that stamps the request's `alertedAt`. The alert is an `ops_alerts` row: subject
`deletionRequest:<requestId>`, ref `deletion_requests/<requestId>`, severity `high`, detail `expected`, `acked`,
`missing` (counts only, no matter id). It pages the operator at once and escalates (partner, then firm admin) if no
one acknowledges it within F43's window; acknowledge and resolve it through F43's routes
(`functions/src/alerts/README.md`).

To act on it:

1. `GET /api/platform/retention/getDeletionRequest?requestId=` and compare `expected` with `acked`.
2. If `halted` is set, a legal hold stopped the saga: leave it, or release the hold (two partners) and retry.
3. Otherwise list the firm's jobs (`GET /api/platform/jobs/listJobs`) for `retention.store.purge` rows that are
   `dead_lettered` or stuck `queued`; fix the cause (`lastError.code`: `purge_incomplete` means rows kept arriving for
   the matter, `store_unavailable` a Firestore outage) and retry them. Every step is fenced, so a retry resumes and
   never repeats an effect. A large store spreads over continuation jobs (`part` `g0`, `g0c1`, `g0c2`, …); each
   acknowledges the stores it finished before handing over.

Once every store has acknowledged (or the hold is released and the saga finishes), resolve the alert.

## Retention execution

`retentionApplyTick` enqueues `retention.apply` for every firm daily at 01:00 PKT. For a class with `periodDays` and a
deleting `periodicAction`, and no class-wide legal hold, it deletes or anonymises rows older than the period in the
class's stores that declare an `ageField`, sparing rows of matters under a hold, and writes
`retention_runs/{firmId}_{day}` (counts only). Backfill a day: `npm --prefix functions run jobs:backfill -- retention.apply <from> <to>`.

## Adding a store

A new Firestore collection, object key prefix (`${firmId}/<segment>/`), Postgres table or Postgres view fails G-0 step 21 until it is
in `infra/retention/inventory.json` with a profile (classification, retention class, who deletes, how deletion is
acknowledged) and a key. A store another finding is adding may be registered with `"pending": "Fxx"`; the gate prints
a note once it lands, and the flag is then dropped (F34's `p1_decisions` was registered so and is now inventoried for
real: class `ai_record`, anonymised on deletion by nulling `matterId`, aged by `settledAt`).

## Residuals

- Client-SDK reads that the rules do not gate on membership (the search index rows, a client reading its own matter)
  end when the saga purges them, not at the tombstone.
- A write that passed its checks before the tombstone and lands after its store's acknowledgement stays until found.
- Vault objects stay until their lock ends (up to 2555 days, `infra/backup/document-vault.json`); backups keep deleted
  rows until they expire (Firestore 14 weeks, Postgres 14 days).
- Client-record erasure is not part of matter deletion.
