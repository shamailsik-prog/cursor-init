# F34: a durable, redacted decision record for every P1 attempt

Date: 2026-10-24. Base: `origin/main` f39d007. Branch: `claude/remediate-f34`.
Status: approved by the remediation builder under the owner's standing autonomy instruction. The brainstorming is self-approved; every decision is a numbered ruling with its reason, and the adversarial review (steelman, devil's advocate, bias check) sits beside the ruling it tests.

## 0. Audit source and what this PR can prove

- `docs/audit/2026-10-13-forensic-audit.md:720`, F34 (HIGH): "AI and workflow traces cannot establish decision reproducibility". P1 usage metadata records model, task and classification, but no prompt-template version, no provider or model revision and no set of retrieved sources and their versions; the Opik export may be disabled or lost fail-open; the eve bridge reports undefined usage; no joined per-stage decision trace is demonstrated. Correction asked for: persist redacted operation and attempt metadata (prompt hash and template version, model and provider revision, retrieval anchors, tool decisions, phase timings, cost, user approval), keep restricted text out of third-party traces, reconcile missing trace exports.
- v2 status: "opik.ts / gateway.ts / committeeBrainModel.ts unchanged". Since then F07, F08, F09, F15, F16, F17 and F18 changed `functions/src/p1/**` and `platform/p1/**`. This spec is written against f39d007.

Proven here, because it runs in this repository: the Functions P1 path over the Auth and Firestore emulators, through the real HTTP router (`committeeBrain`), with the provider faked at the transport boundary and Opik faked at its `fetch`; the lease reconciler and the new export reconciler over the emulator; pure units. NOT DEMONSTRATED: a live Opik server (its handling of a re-posted trace id), the deployed scheduler, the Firestore composite index in a real project, and alert delivery for the new ERROR line (alert delivery is F43).

## 1. Root cause on main

1. **No template identity on the durable record.** `callP1` builds the request from the F16 registry (`platform/p1/systemPolicy.ts`: policy id and version) and returns `outbound.system`, and `committee_outputs` stores it, but the usage row (`ai_usage_logs`, P3-63) does not, a blocked call's output row is the only place it lands, and nothing pins the registry text to its version: an edit of a text without a version bump changes what every later record "names" without anyone noticing.
2. **No prompt hash, no transport identity, no phase timings, no policy verdicts** anywhere durable. The reported model (F17) is on the usage row; whether it was reported is implicit.
3. **No retrieval record.** `committeeBrain` sends no retrieved context (documents are refused, `documents_not_supported`), but F17 grounding consults the corpus to grade the answer; the judgments it read and what they said are not recorded beside the decision, only their ids inside the output row's grounding.
4. **Trace content.** `buildTrace` sends the masked body and response at ranks 0 to 3 (P3-67), so confidential (2) and privileged (3) text reaches the trace store. Masking removes identifiers, not the substance of a privileged question.
5. **Lost exports.** A failed export is a WARN line (`p1.trace_export_failed`) and `trace.status: "failed"` on the usage row. Nothing retries it; O-55 lists re-export as open.
6. **The eve bridge** (`platform/p1/committeeBrainModel.ts`) returns `EMPTY_USAGE` (every count `undefined`) on every path, including the paths where nothing was sent and the true usage is zero.
7. **No reconstruction query.** An operator has to join the usage row, the reservation, the output row and the logs by hand.

## 2. Rulings

### R1. Storage: a sibling collection `p1_decisions/{usageLogId}`
- One document per P1 attempt (each `callP1` is one attempt with its own usage row id and trace id). The id is the usage row's id, so the usage row, the reservation (`ai_reservations/{usageLogId}`), the event (`events/{usageLogId}_*`) and the decision join by id; `traceId` is a field (single-field index), and `operationId` (F09 effect marker) joins the attempts of one HTTP operation.
- *Why not the usage row:* P3-63 fixes its field set (tests pin it exactly), it is written once with `tx.create` and never updated, and it is the spend ledger. The decision record takes later merges (grounding anchors and the output link after the call returns, the export state from the reconciler) and needs a composite index on its export state.
- *Why not the reservation:* a blocked call has none.
- Server-only. `firestore.rules` already denied it through its catch-all `match /{document=**}`; one explicit line, `match /p1_decisions/{id} { allow read, write: if false; }`, is added beside `ai_reservations` because P3-72's convention, which `tests/firestore.rules.p1-phase3d.test.ts` enforces, names every P1 collection with its own deny block. Behaviour is unchanged. The file is otherwise in Cursor's F32 follow-up lane (TTL rules); this one line sits in the P1 block, away from those rules. No TTL: the record is as durable as the usage row it explains; retention is F42's.

### R2. Write path, with no new time-budget phase
- The call's own record is staged in the commit transaction (`stage` in gateway.ts takes an optional `decision`), so it commits atomically with the usage row, the month total, the audit row and the event. `CALL_WORST_CASE_MS` (99 s) and `assertOperationTimeBudget` are unchanged.
- A call whose commit fails for good leaves its reservation holding the worst case (F08). The reservation now also carries `decisionSeed` (everything known before dispatch) and the attempt carries `transportMs`, so the lease reconciler stages the decision record when it settles the reservation (`settledBy: "reconciler"`). A blocked call whose commit fails for good leaves neither a usage row nor a decision record: the ERROR line `p1.usage_log_failed` is its record, as today (residual). A reservation the lease reconciler releases (nothing was sent) gets no decision record either: no usage row is written, and the released reservation is its record (residual).
- `committeeBrain`'s publication transaction (F09) merges the retrieval verification anchors, the grounding summary, the output link and the approval state into the same document. Every write is `set(..., { merge: true })` on disjoint fields, so the order of the gateway's, the publisher's and the reconciler's writes does not matter.

### R3. Prompt identity: a registered template, a pinned hash, a prompt hash
- The template of a P1 request is its system message: the registry policy (`policyId`, `version`) and, on the eve bridge, the pinned agent instructions' SHA-256. The user body is data, not a template.
- `platform/p1/promptTemplates.ts` holds `PROMPT_TEMPLATE_PINS`: for every `id@version` in the registry's history, the SHA-256 of its text. `promptTemplateOf(system)` returns `{ templateId, templateVersion, templateSha256 }` only when the registry text hashes to its pin; otherwise null.
- `callP1` refuses a request whose template has no pin or a mismatched pin with the existing reason `system_unverified` (fail closed, nothing sent), so a text edited without a version bump stops every call that would name it until the pin and the version are dealt with, and the pin test fails in CI first. A test seam (`p1TestSeam.templatePins`, inert in production) replaces the table so the refusal itself is tested.
- Tests (`tests/f34-prompt-template-pins.test.ts`): every registry entry has a pin and every pin names a registry entry; each text hashes to its pin (a second, literal copy of the table in the test, so an edit has to change two tables to pass, both visible in review); the f17.1 committee text is unchanged.
- Call sites (`functions/test/f34-template-callsites.test.ts`): in `functions/src` only `gateway.ts` (`callP1`) and `evalSet.ts` (the offline evaluation) call a `P1Transport.send`, and both build their messages with `buildOutbound` (the registry); at run time every purpose `committeeBrain` accepts, and an unknown purpose, sends a system message whose SHA-256 is a pin; a registry text that no longer hashes to its pin is refused; and an ad-hoc system text (`p1TestSeam.systemOverride`) is refused.
- `prompt.hash`: SHA-256 over the canonical JSON of the masked messages as sent, `[[role, content], ...]` (`PROMPT_HASH_ALGORITHM = "sha256/p1-messages-v1"`). Never the text. Because the output row stores the masked body and the system reference, the reconstruction re-derives the messages and checks the hash (R13).
- *Steelman against R3:* "a pinned hash table is theatre: whoever edits the text edits the pin." *Answer:* the pin is keyed by version and duplicated in a test, so an edit without a bump has to rewrite two pins of an already released version, which review sees; and every decision record carries the template hash it was sent with, so a silent edit is visible afterwards as two records naming one version with two hashes. *Devil's advocate:* "refusing at run time turns a typo into an outage." *Answer:* the pin test fails in CI before any deploy; the run-time check only ever fires on a build that skipped CI, where refusing is right (F16 R3a: the system message is verified or nothing is sent).

### R4. Model, provider and transport identity
- `model.configured` (the routed model), `model.reported` (the provider's `model` field when it is a model id, F17) and `model.revisionStatus`: `reported`, or `unreported` when the provider named none.
- `model.provider` (`ai-gateway`), `model.transport` (`P1Transport.id`: `ai-gateway-chat-completions` for the Gateway transport; a transport without an id, such as a test double, records `unidentified`), `model.gatewayVersion` (`P1_GATEWAY_VERSION`, bumped with any change to the pipeline's decisions), and the provider's own `responseId` / `requestId` when the answer carried plain ids (F08).

### R5. Retrieval anchors
- `retrieval.context`: what the caller put into the prompt. `P1Request.retrieval?: { anchors }` lets a caller pass the sources it retrieved; `committeeBrain` sends none (documents are refused), so its records say `context: { state: "none", anchors: [] }`.
- `retrieval.verification`: what graded the answer. F17 grounding (`functions/src/p1/grounding.ts`) wraps the authority store it is given and records, for each judgment it found, `{ sourceId: "judgment:<id>", ref (canonical citation, masked), status, factsSha256 }`, where `factsSha256` is the SHA-256 of the canonical JSON of what the verdict read: the judgment id, its bench and every treatment (kind, treating bench, recorded bench, sorted). A later change in the corpus (a new overruling) changes the hash, so an operator can tell which corpus state graded the answer. `factsSha256` is null when the treatments could not be listed.
- The corpus port (`functions/src/d4/authority.ts`) is not changed: the corpus publication stamp (`corpus_metadata.last_refresh`) is not exposed through it; the facts hash stands in (residual).
- D4 draft gating and D5 research do not call P1 (verified: no `callP1` outside `ops.ts`; `services/d5-1/research.ts` is a search; `functions/src/d4/gate.ts` resolves citations without a model). They have no P1 decision to anchor. Listed as residuals: when either gains a model call, it passes `retrieval` (the field exists).

### R6. Policy decisions
`decisions`: the kill-switch verdicts (`platform`, `firm`: `clear` or `blocks`), `systemVerified` (null when an earlier refusal stopped the call before the check), the classification route (`classification`, its rank, the provider, `allowed`, whether minimisation was required and held), the mask (redaction and residual counts by kind, the number of party names), the budget (`firstLook`: `fits`, `exhausted`, `not_set`, `unpriced` or `not_reached`; the worst case in micro-USD; the reservation's verdict: `reserved`, a block reason, `failed` or `not_attempted`), `credentials` (`present`, `absent` or `not_checked`) and `attemptRecord` (`recorded`, `failed` or `not_attempted`). Fixed tokens and counts only.

### R7. Phase timings
`phases` in milliseconds on the process's monotonic clock (`performance.now()`, independent of the call's injected clock): `firstReads`, `mask`, `reserve`, `attemptRecord`, `transport`, `attemptOutcome`, `trace`, each null when the call did not reach it; `settleStartedAtMs` (epoch) and `settledAt` (the commit's server timestamp), from which the reconstruction derives `settleMs`.

### R8. Cost
`cost`: input and output tokens, `tokensEstimated`, `costMicroUsd`, `monthKey`, and the paths of the spend records (`ai_usage_months/{firmId}_{monthKey}`, `ai_reservations/{usageLogId}` when reserved).

### R9. Approval
No P1 output feeds a human approval step today: committee outputs are advisory or grounded (F17) and stored, and D4 approval acts on drafts that no P1 output writes. The record says `approval: { state: "no_approval_path", ref: null }`, written by the publisher, and the residual names the path that must write a reference when one exists.

### R10. Third-party trace hygiene
- The masked body and response ride in a trace only at ranks 0 and 1 (`public`, `internal`) and never on a blocked call (`TRACE_TEXT_MAX_RANK = 1`). Ranks 2 to 4 export ids, hashes and metrics only. This supersedes P3-67's "ranks 0 to 3" (E-49 resolved full capture against scrubbed traces; F34 resolves it further: masking removes identifiers, not the substance of a confidential or privileged question, and the trace store is a second system with its own access).
- Trace metadata gains `promptHash`, `promptTemplateId`, `promptTemplateVersion`, `modelReported` and `decisionRecordVersion`: ids and hashes, never text.
- A re-export (R11) is built from the decision record, which holds no text, so a retried trace never carries text at any rank.
- *Steelman:* "internal text is still firm text." *Answer:* `internal` is the firm's own label for material that is not confidential; the trace store is self-hosted (P3-67 refuses `comet.com` and plain http to public hosts). The rule is a constant with a test, so tightening it to rank 0 is one line. *Bias check:* committee calls are never `public` (the `internal` floor), so in practice only internal-labelled matters export text.

### R11. Export reconciliation
- The decision record's `export`: `{ state, attempts, ... }`. `exported` (with `exportedAt`), `disabled` (tracing off: nothing to retry; the decision record is the durable trace), `pending` (an attempt failed or never ran: `nextAttemptAt`, `lastCode`), `failed` (gave up: `abandonedAt`).
- The call's export at step 10: `exported` → `exported`, `disabled` → `disabled`, `failed` → `pending` with `attempts: 1`. A reconciler-built record (R2) is `pending` with `attempts: 0` (the lost call may or may not have exported).
- `p1TraceExportReconciler` (scheduled every 5 minutes, one instance, 45 s timeout, internal ingress) reads `export.state == "pending" and export.nextAttemptAt <= now` by `nextAttemptAt` (composite index added), at most 100 per run under a 30 s budget. Each record is claimed in a transaction that sets a lease (`export.leaseUntil`, `export.leaseToken`, 60 s), exported as a metadata-only trace with the same trace id, and finished in a second transaction that writes only if it still holds the lease token (the fence). A success is `exported`. A failure (any non-2xx, a timeout, or tracing now disabled) counts an attempt: below `TRACE_EXPORT_MAX_ATTEMPTS` (5) it is rescheduled (5, 10, 20, 40 minutes); at 5 it is `failed` with `abandonedAt` and the ERROR line `p1.trace_export_abandoned` (alert policy in the deploy manifest). A failed query is the ERROR line `p1.trace_export_reconcile_failed` (alert policy too); a store failure on one record, and a run that lost its lease, are WARN lines (`p1.trace_export_retry_failed`, `p1.trace_export_fence_lost`) and leave the record as it was. `p1.trace_export_failed` stays a WARN.
- *Devil's advocate:* "Opik may reject a second post of a trace id." *Answer:* unknown without a live server (NOT DEMONSTRATED); a rejection is a non-2xx, which the state machine counts and ends in `failed`, never silent.

### R12. The eve bridge's usage
- A call refused before P1 or blocked by P1 sent nothing: its usage is reported as zero, the real figure, with `raw: { status: "none_sent" }`.
- A call P1 answered: the counts the transport reported, when both are non-negative integers (`Transport.send` may now return `inputTokens` / `outputTokens`, passed through `callCommitteeBrain` as `usage`); otherwise every count stays `undefined` and `raw` says `{ status: "usage_unreported", reason: "transport_reported_no_usage" }`. `providerMetadata.sikander` carries the same status on the result and on the stream's finish part.
- The bridge is blocked in every deployment (F18: no provider transport in Next or eve), so in production every bridge result reports zero usage with `none_sent`.

### R13. Reconstruction
- `reconstructP1Decision(db, { traceId } | { usageLogId })` (`functions/src/p1/decisionRecord.ts`) reads only durable data: the decision record, the usage row, the reservation and its provider attempt, the committee output row (its id, grounding status, advisory flag and the outbound reference; never its text) and the event. It returns the joined record and `checks`: `templatePinned` (the record's template hash equals the pin), `promptHashMatchesOutput` (the messages re-derived from the output row's system reference and masked body hash to the record's `prompt.hash`; null without an output row), `usageJoined`, `reservationJoined`, `exportState`.
- Operator CLI: `functions/src/cli/p1Decision.ts` (`npm --prefix functions run p1:decision -- --trace <id>` or `--usage <id>`), built by `functions/build.mjs` beside the other operator CLIs. Admin-only by construction: it runs with the operator's own service-account credentials and is neither deployed nor routed. Chosen over an HTTP route because a route would put a cross-firm read behind the tenant entry point, and the platform-admin claim is the only control there.

### R14. Lane
- Changed: `functions/src/p1/**`, `platform/p1/**` (`promptTemplates.ts`, `committeeBrainModel.ts`, `internalAICaller.ts`), `functions/src/index.ts` (one export), `functions/src/cli/p1Decision.ts`, `functions/build.mjs` (one CLI name; reason: the CLI must be built like its siblings), `functions/package.json` (one script), `infra/deploy-manifest.json` (the function and two alert policies) and `infra/terraform/alerts.tf` (re-rendered from it by `infra/render_terraform.py --write`), `firestore.indexes.json` (the export index), `firestore.rules` (one deny line, R1), tests and docs.
- Not changed: `functions/src/d4/**`, `functions/src/health.ts`, `services/**`, `app/**`, `ci_gates/**`. `gateway.ts` is shared with F43: edits stay in metadata and trace code.

## 3. Tests (RED on main, GREEN here)

- `functions/test/f34-decision-trace.e2e.emu.test.ts` (Auth and Firestore emulators, `committeeBrain` through the router, fake transport, in-memory corpus, fake Opik fetch): the durable decision record and the reconstruction carry the template id, version and pinned hash, the prompt hash (matching the output row), the reported model and its status, the transport and gateway identity, the verification anchors with facts hashes, the policy verdicts, the phase timings, the cost and the export state; a blocked call is recorded too; a confidential and a privileged call with a planted marker export no text; an export failure is `pending`, the export reconciler retries it (fenced) and records `exported`, or `failed` after the last attempt with the ERROR line; a reservation settled by the lease reconciler gets its decision record.
- `tests/f34-prompt-template-pins.test.ts`, `functions/test/f34-template-callsites.test.ts`: R3.
- `functions/test/f34-decision-units.test.ts`: the prompt hash, the facts hash, the export state machine, the trace content rule, the join.
- The operator CLI (R13) is exercised in the e2e file: the same join as JSON, a usage error (64) and an unknown attempt (2).
- `tests/firestore.rules.p1-phase3d.test.ts`: `p1_decisions` has its own deny block and is server-only for every role.
- `tests/f34-eve-usage.test.ts`: R12.
- Changed expectations: `functions/test/p1.units.test.ts` "carries content at ranks 0 to 3" becomes ranks 0 to 1 (R10), and the payload example moves to rank 1 with `decisionRecordVersion`. The export lists pinned by `functions/test/runtime-options.test.ts` (F32), `p2.boot.test.ts` and `p5.identity.test.ts` gain `p1TraceExportReconciler`, `p2.boot.test.ts` pins its schedule, timeout and trigger kind, and the G-2 suite's non-tenant export map names it.

## 4. Residuals

1. D4 draft gating and D5 research do not call P1; they have nothing to anchor until they do (R5).
2. The corpus publication stamp is not exposed by the authority port; `factsSha256` stands in (R5).
3. No human approval step exists for P1 output (R9).
4. A blocked call whose commit fails for good leaves no decision record, as it leaves no usage row (R2).
5. OCR (`ocrCall.ts`) sends bytes, not a prompt: it has no template and is outside this record (its `p1_ocr_operations` row is its record).
6. A reservation released by the lease reconciler gets no decision record (R2).
7. The mask has no version constant; its effect is recorded as counts by kind (R6).
8. The eve bridge is blocked everywhere; the `reported` and `usage_unreported` branches run only with a test transport (R12).
9. Live Opik behaviour (a re-posted trace id), the deployed scheduler and index, and alert delivery: NOT DEMONSTRATED.
