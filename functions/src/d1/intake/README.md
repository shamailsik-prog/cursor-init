# Module 5 — Client Intake

Firm-scoped intake records in `intakes` and `intake_messages`. Both are registered in `infra/retention/inventory.json` with `pending` removed. Every row carries `firmId`. `matterId` is null until promotion, so a matter deletion does not reach an unpromoted row. This module does not add routes or a flag-registry entry. There are no staging objects.

## Flag

`SIKANDER_FLAG_D1_INTAKE`. Unset, blank, or any value other than a trimmed `true` is off. With the flag off every operation refuses `404 feature_disabled` before any store read.

## Operations

`createIntake`, `listIntakes`, `getIntakeThread`, `classifyIntake`, `routeIntake`, `closeIntake`, `promoteToClient`.

A row above the caller's clearance is not found, including on the list. The thread is not read. An anonymised row is skipped on the list and is not found on a direct read. One anonymised row does not fail the firm's list.

`getConflictResult` enforces the check's classification before it returns anything. A confidential-cleared partner who learns the check id from `audit_log` receives `403 exceeds_own_clearance` and does not receive the prospect's name or phone, or the opponent's name or CNIC. `discloseFor` redacts those subject fields for every callable that returns a check when the reader is below the check's label. The intake's label is not lowered by classify, route, close or promotion.

`classifyIntake` takes an `IntakeClassifier`. The default is keyword rules for practice area and urgency. Court prefixes are judged only against `data/courts.json`. An ambiguous prefix (Supreme Court `CP`) or a prefix that is not seeded is a follow-up. It is not turned into a practice area. A name that is not clearly a person or a company stays an unknown entity and is a follow-up. `routeIntake` applies the caller's rule list in order. An unknown practice area, a follow-up, or a rule whose assignee is not an active lawyer of the firm goes to the follow-up queue.

## Promotion

`promoteToClient` refuses unless `confirmedBy` is the caller and that caller is an active partner or associate of the firm. It then runs `runConflictCheck` on the prospect and the opposing parties **before** `registerClient` or `openMatter`. A result that is not CLEAR, and a FLAG without a recorded waiver, refuses `409 conflict_blocked` and writes no client and no matter. The check id is kept on the intake so a later `resolveReviewItem` / `recordPartnerWaiver` on that same check can be replayed.

`openMatter` binds only a check whose client subject already has a `clientId`. The pre-registration check does not have one. After the check is cleared, the client is registered and that id is added to the subject. The hits, the result and the waiver are not rewritten. The matter's `conflictCheckId` is that check, so a waiver stays the waiver the partner recorded. A second call returns the same client and matter.

The client and the matter are classified at `max(intake, check)`. The check is raised to that floor when it is created. A reader cleared below that floor cannot read the check through `getConflictResult` or through `discloseFor`'s subjects.

A promotion claims the intake in a transaction before it creates a check or a client. A second caller waits and then sees the same client and matter. `classifyIntake`, `routeIntake` and `closeIntake` write in a transaction that re-reads the row. A promoted row is not rewritten. A live promotion claim blocks classify and route. A close during that claim is stored. Promotion re-reads the intake before it registers a client. It re-reads the intake again inside the matter-creation transaction. If that read shows the intake is closed, the transaction writes nothing and promotion returns 409 `intake_closed`. The intake stays closed, its `matterId` stays null, and no matter is opened. A check created for that attempt stays unbound. The conflict check is created at `max(intake classification, screened classification)` in that one create; promotion does not raise the label with a later write.

A cached check that is stale, or older than the open-matter window, is replaced with a new check. A client already stored on the intake is kept.

`anonymiseUnpromotedIntakes` (`functions/src/retention/unpromotedIntake.ts`) clears the named PII fields on rows whose `matterId` is still null. A promoted row is left in place. A dotted anonymise key is already applied when either the literal field or the nested path holds the anonymised value, so a later sweep does not rewrite the row. The sweep has a guard for the class-wide legal hold (`retentionTestSeam.honourUnpromotedLegalHold`). The hold is not wired into the shipped retain policy yet; when the seam is on, a class with `legalHold: true` is not anonymised.

`registerClientOp` and `openMatterOp` are already exported. `client/ops.ts` and `matter/ops.ts` are not edited.

## Out of scope

HTTP routes and actions, the WhatsApp intake agent, email intake, the P1 classifier, and conflict backfill of firm data.
