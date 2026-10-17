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

**Files:** create `tests/f16-prompt-roles.test.ts`, `functions/test/f16-prompt-roles.e2e.emu.test.ts`, `tests/f16-envelope.test.ts`, `tests/f16-system-policy.test.ts`, `tests/f16-agent-tools.test.ts`, `tests/f16-injection-structure.test.ts`, `tests/fixtures/f16-injection-corpus.ts`; extend `functions/test/p1.units.test.ts` with the ceiling tests.

- [ ] Write the two closing tests so they load on main (no static import of a new module): their assertions, not their imports, fail on main.
- [ ] Run each new test against main's sources (implementation files at `origin/main`), record each failure line and the counts in the ledger.

### Task 3: Registry, envelope, builder

**Files:** create `platform/p1/systemPolicy.ts`, `platform/p1/promptEnvelope.ts`, `platform/p1/outboundPrompt.ts`; modify `platform/p1/providerPolicy.ts` (`assertMinimised` over messages).

- [ ] Registry with the five policies, `systemPolicyFor`, `isSystemPolicyId`.
- [ ] Envelope: source grammar, neutralisation on the name view (horizontal whitespace squeezed per line), `envelopeTagCount`, `envelopeIntegrity`.
- [ ] Builder: mask every part, envelope untrusted segments, neutralise, merge adjacent same-role turns, system first; summed counts; residual counts over messages.
- [ ] Run `tests/f16-envelope.test.ts`, `tests/f16-system-policy.test.ts`: GREEN.

### Task 4: Functions path

**Files:** modify `functions/src/p1/costTable.ts`, `transport.ts`, `gateway.ts`, `opik.ts`, `ops.ts`, `README.md`.

- [ ] `MESSAGE_OVERHEAD_TOKENS`, `requestTokenCeiling`, `estimateRequestTokens`.
- [ ] Transport `send({ model, messages, maxTokens })` posting `messages` as given.
- [ ] `callP1`: build `[system, user]`; outbound gains `system`; reserve and estimate on the messages; `assertMinimised` over the messages; trace `{ system, prompt }`.
- [ ] `outputRow` records `outbound.system`; `receiptOf` validates it strictly; pre-F16 receipts resume.
- [ ] Update the changed expectations in `p1.gateway.emu.test.ts`, `p1.transport.test.ts`, `p1.api.emu.test.ts`, `f07-f08-ai-spend.e2e.emu.test.ts`, `f09-atomic-idempotency.e2e.emu.test.ts`, `f15-pii-mask.e2e.emu.test.ts` as the runs show; record each.

### Task 5: Next path and the eve bridge

**Files:** modify `platform/p1/internalAICaller.ts`, `gatewayTransport.ts`, `promptText.ts`, `committeeBrainModel.ts`, `platform/spine/store.ts`.

- [ ] `callCommitteeBrain` takes `body` or `turns` (+ `agentInstructions` from the bridge only); outbound `{ body, system, messages, metadata }`.
- [ ] Next transport sends `messages`; accepts an injected `fetch` for the boundary test.
- [ ] `promptToTurns`: system to agent instructions, user text, assistant text, tool calls and tool results enveloped, every other part fails closed with a reason.
- [ ] Update `tests/p1.eve-committee-brain.test.ts` expectations if needed; record.

### Task 6: Tools

**Files:** create `platform/p1/eveToolContracts.ts`; modify `agent/tools/mask_preview.ts`, `classification_policy.ts`, `normalise_case_number.ts`, `platform/p1/eveTools.ts`.

- [ ] Strict input schemas, output schemas, `runContractTool`, `ToolContractError`.
- [ ] Own-key court lookup.
- [ ] Run `tests/f16-agent-tools.test.ts`: GREEN.

### Task 7: Corpus and harness

- [ ] 54 cases (42 English, 12 Urdu), six categories, English and Urdu, canaries; structure test GREEN; live suite skipped and reported NOT RUN without a key.

### Task 8: Verification

- [ ] `npm run test:unit`; the `test:rules` set; the Functions P1/F07-F08/F09/F15/F16 files and one full Functions emulator run (hard timeout); `npm run typecheck`, `npm run typecheck:tests`, functions typecheck and build; `npm run lint`; `BASE=origin/main bash ci_gates/gate_g0.sh`; adversarial re-read of the diff.

## Ledger

Filled in as the work runs: RED evidence, GREEN evidence, changed test expectations, decisions.
