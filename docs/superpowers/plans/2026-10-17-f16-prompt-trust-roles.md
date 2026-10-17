# F16 Prompt Trust Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every P1 request reaches the provider as role-separated messages (one platform-authored system message from a fixed registry, then user and assistant turns), untrusted content travels in an envelope that cannot be closed from inside, every part is masked, minimised and budgeted, the stored record keeps the roles, and the eve tools have strict input and output contracts.

**Architecture:**
- `platform/p1/systemPolicy.ts`: frozen registry of system policies keyed by purpose, default `committee-brain`.
- `platform/p1/promptEnvelope.ts`: the `<untrusted_content source="...">` envelope, tag look-alike neutralisation on F15's name view, and an integrity check.
- `platform/p1/outboundPrompt.ts`: `buildOutbound` masks every part, envelopes untrusted segments, neutralises, merges adjacent turns, and returns the messages, the system record and the summed counts.
- Functions: `callP1` builds `[system, user]`, reserves `requestTokenCeiling(messages)`, the transport posts `messages`, the output row, receipt and trace record `system` beside `body`; `receiptOf` validates `system` strictly.
- Next: `callCommitteeBrain` takes `body` or `turns` (+ the eve agent's own system text), the transport sends `messages`; the eve bridge converts the AI SDK prompt into turns, envelopes tool parts and fails closed on parts it cannot carry.
- Tools: `platform/p1/eveToolContracts.ts` strict zod input and output schemas run around every enabled tool.

**Tech Stack:** TypeScript, zod 4, vitest, AI SDK provider v3 types, eve, firebase-admin, the Auth and Firestore emulators.

**Spec:** `docs/superpowers/specs/2026-10-17-f16-prompt-trust-roles-design.md`

## Global Constraints

- Do not edit `platform/http/withSession.ts`, `platform/p5/session.ts`, `platform/persistence/adminFirestore.ts`, `platform/persistence/firestoreSpineRepositories.ts`, `platform/p5/committeeScope.ts`, `platform/p5/insecureDevAuth.ts`; no `app/api/**`.
- Never skip or weaken a test; never rename a test the G-4 gate selects by name. Every changed expectation is listed in the ledger below with its reason.
- Invented names only (Qalvo, Nura, Tariq Zarvani, Haris Qalbani, Omer Daryani); synthetic numbers.
- Invisible, bidi and private-use characters are written as `\u` escapes in source.
- Emulators on private ports (a scratch copy of `firebase.json`, never committed).
- No model name added anywhere in the repo.

## Review Focus

- No caller can put text in the system role: the HTTP inputs have no field for it; the turn type has no system role; the bridge's only system source is the AI SDK prompt's system messages (eve's compiled instructions), pinned by the instruction-source test.
- No envelope can be closed early: neutralisation on the name view, markers on their own lines, `envelopeIntegrity` re-check, the corpus table.
- The reservation never under-reserves: `requestTokenCeiling` >= the old body ceiling for the same text, and a system message raises it.
- A pre-F16 receipt resumes; a malformed `system` fails closed 409.

---

### Task 1: Spec and plan

- [x] Write the spec (rulings 1-7, refinements R1a, R1b, R2a, residual risk) and this plan.

### Task 2: RED tests on main's sources

**Files:** create `tests/f16-prompt-roles.test.ts`, `tests/f16-next-transport.test.ts`, `functions/test/f16-prompt-roles.e2e.emu.test.ts`, `tests/f16-envelope.test.ts`, `tests/f16-system-policy.test.ts`, `tests/f16-outbound-prompt.test.ts`, `tests/f16-agent-tools.test.ts`, `tests/f16-tool-contracts.test.ts`, `tests/f16-injection-structure.test.ts`, `tests/fixtures/f16-injection-corpus.ts`, `functions/test/f16-request-ceiling.test.ts` (a new file instead of extending `p1.units.test.ts`, so the gate's named-test list is untouched).

- [x] Write the closing tests so they load on main (new modules imported dynamically): their assertions, not their imports, fail on main.
- [x] Run each new test against main's sources and record each failure line and the counts (ledger).

### Task 3: Registry, envelope, builder

**Files:** create `platform/p1/systemPolicy.ts`, `platform/p1/promptEnvelope.ts`, `platform/p1/outboundPrompt.ts`; modify `platform/p1/providerPolicy.ts` (`assertMinimised` over messages).

- [x] Registry with the five policies, `systemPolicyFor`, `isSystemPolicyId`.
- [x] Envelope: source grammar, neutralisation on the name view (whitespace and controls squeezed within a line; a `<`/`</` before and a `>` after the name taken with it), `envelopeTagCount`, `envelopeIntegrity`.
- [x] Builder: mask every part, envelope untrusted segments, neutralise, merge adjacent same-role turns, system first; summed counts; residual counts over messages; a 100,000-character bound test.
- [x] `tests/f16-envelope.test.ts`, `tests/f16-system-policy.test.ts`, `tests/f16-outbound-prompt.test.ts`: GREEN.

### Task 4: Functions path

**Files:** modify `functions/src/p1/costTable.ts`, `transport.ts`, `gateway.ts`, `opik.ts`, `ops.ts`, `README.md`; create `functions/test/sent.ts`.

- [x] `MESSAGE_OVERHEAD_TOKENS`, `requestTokenCeiling`, `estimateRequestTokens`.
- [x] Transport `send({ model, messages, maxTokens })` posting `messages` as given.
- [x] `callP1`: build `[system, user]`; outbound gains `system`; reserve and estimate on the messages; `assertMinimised` over the messages; trace `{ system, prompt }`.
- [x] `outputRow` records `outbound.system`; `receiptOf` validates it strictly; pre-F16 receipts resume.
- [x] Changed expectations in `p1.gateway.emu.test.ts`, `p1.transport.test.ts`, `p1.api.emu.test.ts`, `f07-f08-ai-spend.e2e.emu.test.ts`, `f09-atomic-idempotency.e2e.emu.test.ts`, `f15-pii-mask.e2e.emu.test.ts` (spec §3).

### Task 5: Next path and the eve bridge

**Files:** modify `platform/p1/internalAICaller.ts`, `gatewayTransport.ts`, `promptText.ts`, `committeeBrainModel.ts`, `platform/spine/store.ts`.

- [x] `callCommitteeBrain` takes `body` or `turns` (+ `agentInstructions` from the bridge only); outbound `{ body, system, messages, metadata }`.
- [x] Next transport sends `messages`. Deviation R7a: the boundary test fakes `generateText`/`createGateway` instead of injecting `fetch` (the Gateway provider's wire format is the SDK's own protocol).
- [x] `promptToTurns`: leading system messages to agent instructions, user text, assistant text, tool calls and tool results enveloped, every other part (and a system message after the conversation starts) fails closed with a reason.
- [x] `tests/p1.eve-committee-brain.test.ts` needed no change (its `captured.body` is the final user message). `tests/p1.provider-policy.table.test.ts`: type annotation only.

### Task 6: Tools

**Files:** create `platform/p1/eveToolContracts.ts`; modify `agent/tools/mask_preview.ts`, `classification_policy.ts`, `normalise_case_number.ts`, `platform/p1/eveTools.ts`.

- [x] Strict input schemas, output schemas, `runContractTool`, `ToolContractError`.
- [x] Own-key court lookup.
- [x] `tests/f16-agent-tools.test.ts`, `tests/f16-tool-contracts.test.ts`: GREEN.

### Task 7: Corpus and harness

- [x] 54 cases (42 English, 12 Urdu), six categories, canaries; structure test GREEN; live suite skipped and reported NOT RUN without a key.

### Task 8: Verification

- [x] `npm run test:unit`; the `test:rules` set; the Functions P1/F07-F08/F09/F15/F16 files and one full Functions emulator run (hard timeout); `npm run typecheck`, `npm run typecheck:tests`, functions typecheck and build; `npm run lint`; `BASE=origin/main bash ci_gates/gate_g0.sh`; adversarial re-read of the diff.

## Ledger

### Decisions

- R1a: an unknown purpose falls back to the default registry policy (free-text purposes exist in callers and tests; the fallback is fixed platform text).
- R1b: the eve agent's leading system messages (compiled `agent/instructions.md`) follow the registry text in the system message; a system message after the conversation has started fails closed (added after the adversarial re-read; its test row was added then and its RED recorded on main's exported tree).
- R2a: the conversation's assistant text keeps the assistant role and is neutralised, not enveloped.
- Ruling 4: Functions stores system + body (no `messages` copy of a body of up to 100,000 units in three documents); Next stores `system` and `messages` beside `body`.
- R7a: the Next transport test fakes the SDK call instead of injecting `fetch`.
- The Write tool turns `\uXXXX` in content into raw characters; every new file was passed through an escaper so invisible, bidi, combining, private-use, full-width, mathematical and Greek/Cyrillic look-alike characters are `\u` escapes in source (scan clean; the only raw mark in a touched file is a pre-existing fatha in `f15-pii-mask.e2e.emu.test.ts`).

### RED (new tests against main 403200c's exact tree, `git archive origin/main` with the new test files copied in)

- Root, 8 files: 185 failed, 9 passed, 54 skipped (the live corpus). `role-separated messages: expected undefined to be defined` x109; `the shared builder: expected null not to be null` x54; `expected true to be false` x12 (strictness and bound rows, `assertMinimised` over messages); `expected undefined to be defined` x3 (output schemas); `expected [ { body: ... } ] to have a length of +0 but got 1` x5 (fail-closed rows); `promise resolved ... instead of rejecting` x1; `expected { …(2) } to not have property "prompt"` x1; `Cannot find module` for the four new-module unit files. The 9 passes are guards (corpus shape; `defaultTools: false`; privileged defaults disabled; valid inputs accepted; valid outputs).
- Functions (emulators, private ports): `f16-prompt-roles.e2e.emu.test.ts` 11 failed, 1 passed. (a), (b), (c) `role-separated messages: expected undefined to deeply equal [ 'system', 'user' ]`; (d) `system record on the resumed row: expected undefined to deeply equal { policyId: 'committee-brain', …(2) }` and six malformed rows `expected an ApiError, the call succeeded`; (e) `expected 50 to be +0`. The pre-F16 receipt row is a guard and passes on main. `f16-request-ceiling.test.ts`: `Cannot find module '@/platform/p1/systemPolicy'`.

### GREEN

- `npm run test:unit`: 191 files passed; 5477 passed, 54 skipped (the live corpus: NOT RUN, no `AI_GATEWAY_API_KEY`). One earlier full run missed a timing budget by 5 ms in `tests/citations.time-budget.test.ts` (3005 ms against 3000 ms, `services/d4-2`, which F16 does not touch); the file alone passed 44/44 and the next full run passed.
- `test:rules` file set (Firestore emulator, private ports): 13 files, 680 passed.
- Functions, one full emulator run (hard timeout): 68 of 69 files, 1704 of 1708 tests. The four failures are `p2.jobs-scheduled.emu.test.ts` 15 s timeouts after `p2.jobs-load`; main 403200c's exact tree gives the same four (66 of 67 files, 1677 of 1681), and the file alone on this branch passes 6/6. Within that run the P1 files all pass: f07-f08 35, p1.api 142, p1.gateway 72, f09-atomic-idempotency 43, f09-effect-marker-guard 5, f15-pii-mask 56, p1.transport 42, p1.units 39, f16-prompt-roles e2e 12, f16-request-ceiling 15.
- `npm run typecheck`, `npm run typecheck:tests`, functions typecheck, functions build and `npm run build` (Next): exit 0.
- `npm run lint`: 0 errors, 89 warnings, none in a touched file; `npx eslint --max-warnings 0 functions`: exit 0.
- `BASE=origin/main bash ci_gates/gate_g0.sh`: Gate G-0 PASSED.
- Not run here: the live corpus evaluation (no key) and `eve info` (the eve CLI needs Node 24; this host has Node 22). The agent and its tools load and execute in vitest, and the root typecheck covers `agent/tools/*`.
