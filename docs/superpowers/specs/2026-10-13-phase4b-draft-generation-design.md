# Phase 4b: draft generation through P1 and the 4a gate (D4-1 `startDraft`, `generateOutline`, `approveOutline`, `generateDraft`)

Date: 2026-10-13. Status: rulings made under the owner's standing autonomy instruction (7 October 2026); pending the partner's signature with Erratum Set No. 2 ("Not governing until signed", ES2:7).

Branch: `claude/superpowers-installation-5u3208`, from `main` at `e7e18e6` (Phase 4a, PR #25).

Sources:
- `docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt` (`L<n>`), which binds;
- `docs/architecture/ERRATUM_SET_2_PROPOSED.md` (`ES2:<n>`; precedence once signed, ES2:9-10);
- the Phase 3d spec (P3-nn) and the Phase 4a spec (P4-nn), with their execution rulings (3d R1-R13, 4a R1-R12) in `docs/superpowers/plans/2026-09-30-phase1-foundation-rulings.md`;
- the Phase 4b research note of 13 October 2026 (not committed; its citations were checked against the set and are carried here);
- the code at `e7e18e6` (`file:line`).

## Why

- Module 12 names the four steps and nothing more:
  - `startDraft POST Begin a draft from facts/dictation` (L1364);
  - `generateOutline internal Produce a strategy outline for approval` (L1365);
  - `approveOutline POST Advocate approves before full draft` (L1366);
  - `generateDraft internal Draft via Committee Brain (Claude Opus)` (L1367).
- The order is "facts → strategy outline (advocate approves) → full draft → citation gate → DOCX/PDF export" (L1356-1357). The output is "A complete, properly structured pleading in the firm's voice, nothing reaching paper without human sign-off" (L1371-1372).
- The set gives no schema, no states, no outline collection and no outline event (L1960, L8287, L8189-8191). This spec supplies them.
- 4a deferred generation for three reasons (P4-1): the policy blocks privileged matters, the gate had to come first, and generation needs "a sectioned design under the 4,096-token cap". The gate, the partner override and the approval stand-in now exist.
- P4-15 put the citation guardrail "in the D4 caller after `callP1` returns".
- G-1 needs "a draft produced, gated and approved, end to end" (L7385-7386).

## Observe: what exists

- **P1 entry point.** `callP1` (`functions/src/p1/gateway.ts:147`) has one task type, `committee` (`types.ts:4`). That type is routed in the frozen `TASK_MODEL` (`costTable.ts:4`) to `anthropic/claude-opus-5.5`, the only priced model: input 4,000 and output 20,000 nano-USD per token, from the Gateway list fetched 2026-10-11. Every call sends `max_tokens: 4096`.
- **Transport.** It reads only `choices[0].message.content` and `usage` (`transport.ts:104-108`). A length-truncated answer therefore looks complete.
- **Mask.** `platform/p1/maskOutboundPII.ts` is lossy and unindexed (`[PARTY]`, `[CNIC]`, `[PHONE]`, `[EMAIL]`, `[IBAN]`, `[NTN]`, `[PASSPORT]`; `:85-93`). It runs on the body, the purpose and the response (`gateway.ts:168-173`, `:207`), and it has no address rule (the O-13 recorded gap).
  - P3-62 (R13): "the raw text is used for the count only and never returned, stored, traced or logged".
- **Policy.** `data/provider_dpa.json` is `{}`, so only ranks 0 and 1 reach a provider (O-57). Rank 4's deterministic path and partner exception are "not built yet" (`providerPolicy.ts:118-120`).
- **Precedent.** `committeeBrain` is synchronous, with rate kind `p1` and action `ai.call`. O-58: a failed output write after a billed call answers 500, and a same-key retry re-bills.
- **D4.**
  - `runGate` is pure (`d4/gate.ts:68-76`).
  - `gateDraftOp` gates a stored version only (`gateOps.ts:513-555`).
  - `createDraftOp` writes the draft, version 1, `draft.autosaved` and the audit row in one transaction (`drafts.ts:322-386`).
  - `stageDraftEvent` lacks `draft.generated` (`drafts.ts:179`).
  - `classifyForMatter` (`drafts.ts:296`) and the result helpers of `gateOps.ts` are not exported.
  - `requireStillPermitted` (`drafts.ts:143`) is R12.
  - Production runs on `EMPTY_AUTHORITY_STORE` (O-59).
- **Templates.** No seed `templateId` resolves to any text; the repository holds no template, clause or Drafting DNA. The seed supplies structure only: `name`, `firstGroundRule`, `requiredFields`, `annexureRule` and `checklist`.
- **P2** has no provider-calling job type (O-56).
- **Issue #26** (2026-10-12, relayed by an agent, unconfirmed) asks to withdraw the DPA and in-region requirements. Nothing acts on it.

## Rulings

| ID | Ruling | Grounds | Cost if wrong |
| --- | --- | --- | --- |
| P4B-1 | **Scope.**<br>• `startDraft` → `generateOutline` → `approveOutline` → `generateDraft` as synchronous POST routes under `/api/d4/drafting/`, sectioned.<br>• Every model call goes through `callP1`, and every stored draft through the 4a gate.<br>• Three `draft.read` GETs: `getGeneration`, `getOutline` and `listGenerations`. The last lets a run whose id the client lost be found and resumed.<br>• New drafts only. From version 1 on, override and approval are 4a's, unchanged.<br>• Deferred: "Out of scope". | L1356-1357, L1364-1367, P4-1, P4-15, L7385-7386. | Dictation, documents, templates and style wait; a regeneration is a new draft. |
| P4B-2 | **Synchronous, one P1 call per request.**<br>• This departs from L8142-8144 (`internal` is "A P2 Cloud Task … for anything that calls an external provider").<br>• It also departs from "'Every AI action is a Job' is a system non-negotiable" (L988, L1970) and from L5538 (async by default).<br>• The departure is recorded in E-52(d), as `committeeBrain` already departs. | P2 has no provider-calling job type. Its 16 KiB payload, re-billing retries and kill-switch and budget retry semantics are open (O-56). One section call fits the 120 s timeout (P4B-17). | A move to P2 changes the client from driving steps to polling a job. The store, guardrails and gate are unchanged (O-79). |
| P4B-3 | **Sectioned.**<br>• One P1 call per section of the approved outline, at most 25 sections, each still capped at `max_tokens: 4096`.<br>• In order: section i needs i − 1 stored (409 `previous_section_missing`).<br>• Input: the facts, the verbatim fields, the approved outline and section i − 1's text. | P4-1. A complete pleading (L1371) may exceed one answer. Latency is unmeasured (O-57). A truncated single pass cannot be stored under the no-placeholder standard. | More calls per draft: illustratively USD 0.05 a call at 5,000 input and 1,500 output tokens (arithmetic on assumed counts). Continuity across sections is weaker, bounded by passing the preceding section. |
| P4B-4 | **P1 task type `drafting`.**<br>• Routed to `anthropic/claude-opus-5.5`: L953's "Claude Opus", already priced.<br>• L953's fallback, GPT-4o, is unpriced and failover is unbuilt (L956-957, O-56). It is not routed, and no price is invented (O-77).<br>• Outline and section calls both use `drafting`, with the fixed purposes `draft-outline` and `draft-section`.<br>• The trace name follows: `p1.drafting`. | L953, L1367 (Committee Brain is P1, L944-945), P3-62. | As P3-62: Opus's price, bounded by the 70/90 alerts and the budget stop. |
| P4B-5 | **P1 truncation flag.**<br>• The transport reads `choices[0].finish_reason`.<br>• `P1Result.truncated` is true when the outcome is `ok` and the value is anything but `"stop"`, absent included.<br>• Rows, events and traces are unchanged; `committeeBrain` ignores the flag.<br>• D4 refuses a truncated answer (`output_truncated`): billed, nothing stored. | `transport.ts:104-108`; L1371-1372; fails closed. | If the Gateway reports another value for a complete answer, every generation is refused until corrected. G-1 shows it (O-84). |
| P4B-6 | **P1 indexed pseudonymiser; re-hydration in process.**<br>• Beside the mask, with the same kinds and patterns, one indexed token per distinct value (`⟦PARTY_1⟧`, `⟦CNIC_1⟧`, …). One map serves the request and the response.<br>• `callP1` returns the map to the in-process caller only. It is never stored, traced, logged, or put in a row, event, audit row, error or response, by P1 or D4.<br>• D4 re-hydrates. The trace and the rows carry tokens only (E-49 unchanged).<br>• Details: "P1 changes". | One masking chokepoint: L947-951; "The masked text is what leaves the application" (L9538-9539); L9631; Job F (L9370-9371). The set never specifies re-hydration. With the shared map, a party name the model writes re-hydrates instead of becoming `[PARTY]`. | An erratum on R13's "never returned" (E-52(c)). The map holds the caller's own inputs, returned to it in process. |
| P4B-7 | **Verbatim fields and reserved tokens.**<br>• `verbatim` entries name one of the type's `requiredFields` (for example `exactLandDescription`). Their text becomes `⟦VERBATIM_n⟧`: never sent, never paraphrased, re-hydrated from source.<br>• Caller text containing `⟦`, `⟧`, a lossy mask token or a bare token (`PARTY_1`, `CNIC_2`, …) is 422 `reserved_tokens`, so no input forges a token and none can make every answer a billed `rehydration_failed` (engineering review, plan D26). | The owner's standard ("Copy the land description exactly from the source"); L1648 (facts from source documents). | One more token kind. The assembled body still takes 4a's normalisation (P4-4). |
| P4B-8 | **Generation store.**<br>• `draft_generations` (the brief), `draft_outlines` and `draft_sections`, with deterministic ids keyed by `(generationId, outlineVersion[, section])`.<br>• Stages: `facts`, `outlined`, `approved`, `drafting`, `assembled`.<br>• The `drafts` row is created only at assembly. | Keeps 4a's invariants (every draft has version 1; gate, override and approval unchanged). The set has no outline collection (L1960, L8287). | The client tracks `generationId`, then `draftId`. |
| P4B-9 | **Deterministic-first with an empty port.**<br>• `TemplateStore` (`functions/src/d4/templates.ts`) follows the `AuthorityStore` pattern: `EMPTY_TEMPLATE_STORE` in production; `setTemplateStoreForTests` throws in production.<br>• `deterministicFirstCheck` runs before every P1 call and records `path: "ai"` on the brief, the outline or section and version 1.<br>• If a template is found, the route makes no P1 call (L5497: "skip the model entirely") and answers 501 `deterministic_not_built`.<br>• For drafting the check lives in D4; P1 keeps model selection (E-52(e)). | L5495-5499, L5510-5511. L16.1 is P1's (L7989-7992, L8659), yet it "Calls / triggers Committee Brain (P1); Citation-Safety Gate (33)" (L5517); P4-15's layering puts it in D4. Templates are P6's alone (L7053, L7058-7061); the seed corpus is "not rebuilt by engineering" (L2029-2030). | None until P6 (O-80). `getGeneration` shows path and cost (L5498), standing in for `showPathAndCost`. |
| P4B-10 | **Outline approval.**<br>• `draft.outline.approve` is for a partner or associate who is a member of the matter. A clerk gets 403 `role_not_permitted`. The author may approve their own outline.<br>• The approval is bound to the current version and its SHA-256 (409 `outline_changed`), the R6/R9 pattern.<br>• An edited outline is stored as n + 1 (kind `edited`) and approved in the same transaction.<br>• Every `missingFacts` entry must be acknowledged (422 `missing_facts_not_acknowledged`), and the acknowledgement is recorded.<br>• A later outline voids the approval. | "advocate approves" (L1356, L1366). P5 has no advocate role; partners and associates plead. R-2. The set has no four-eyes rule. | A clerk-run matter needs an associate. The final draft still needs a partner (P4-8). Role reading: O-86. |
| P4B-11 | **Assembly in one transaction; gating never refuses storage.**<br>• When every section is stored, the request builds the body, runs `checkedText` and `runGate` (no temporal checks: 4c, O-64), then writes in **one transaction**:<br>  – `drafts`, and `draft_versions/{draftId}_1` (`kind: "generate"`, provenance);<br>  – `draft_gate_results/{draftId}_1` (`gateRuns: 1`), the summary and `lastGatedVersion: 1`;<br>  – the events `draft.generated`, `draft.autosaved` and `draft.gated` `_gated_1`;<br>  – the brief's `assembled` stage and `draftId`;<br>  – the assembly audit row.<br>• An UNVERIFIED or OVERRULED citation stores and blocks approval as in 4a. | E-51(i) and P4-15: the version and its gate result commit together, so no ungated generated version exists (sections and outlines are not versions). R-3 (L6713-6715); E-22; E-31. Refusing on UNVERIFIED would make every cited draft unstorable while O-59 is open. | A partner may need an override before approving, as for every 4a draft. |
| P4B-12 | **Guardrails in the D4 caller, fail-closed.**<br>• The checks run in order; the first failure wins.<br>• A failure stores nothing, records the outcome and cost on the brief and answers 200 `outcome: "refused"`:<br>  1. `output_truncated`;<br>  2. `output_unparseable`: the outline JSON is invalid or outside its limits, or a section is empty;<br>  3. re-hydration, then `rehydration_failed` if a `⟦`, a `⟧`, a lossy token or a bare `/\b(?:PARTY\|CNIC\|PHONE\|EMAIL\|IBAN\|NTN\|PASSPORT\|VERBATIM)_\d+\b/` remains;<br>  4. `output_too_large`: over 200,000 characters after re-hydration;<br>  5. `output_unsupported_characters`: refused by the draft charset rule;<br>  6. `unsupported_authority`: an authority not in the advocate's own text.<br>• For step 6:<br>  – the advocate's own text is the title, the facts and the verbatim text, plus, for a section, the approved outline (its edits are the advocate's, and a generated outline has passed this check);<br>  – comparison is by `normaliseCitation` canonical form, and an `UNRECOGNISED:` suspect or a ref that does not normalise always counts as new;<br>  – up to 50 new refs are recorded on the brief, never in a response.<br>• Placeholder detection beyond mask tokens is 4d (O-65). | L960-961 ("no AI output may carry a fabricated or unverified authority"); L1006; the F-8 output validator (L9688-9689, "otherwise refused"); P4-15. Without step 6, E-31's override could pass a fabricated citation on a good-faith reason. | A paid answer is sometimes discarded; the advocate supplies the authority and regenerates. An oddly written citation that the model repeats is refused. Statutes are not extracted, so an invented provision passes until 4c (O-83). |
| P4B-13 | **Classification.**<br>• The brief takes `classifyForMatter`'s label: the strictest of the matter's label, `internal` and the requested label. A label below the matter's is 422 `classification_below_matter`; one above the caller's clearance is 403 `clearance`.<br>• Each later step uses the strictest of the brief's label and the matter's current label. That label is written back (never falls), carried by the outline, the section, the draft and its rows and events, and passed as the P1 call's `classification`.<br>• The label is never in the prompt. | L6979-6981 (max of the sources; P1 gets the aggregate); L17.3 #20; R3; PROBE-5; L7005. | A `public` matter's generation is labelled `internal`: stricter, and harmless. |
| P4B-14 | **No text in POST responses; billed once.**<br>• POSTs return ids, stage, outcome, path, model, usage and cost, never text. The idempotency store (E-48(j)) therefore never holds re-hydrated text, and text is read through the GETs.<br>• A step returns its stored deterministic document before calling P1 (`called: false`).<br>• A 180 s lease on the brief (`inFlight`) serialises a generation's calls and outline changes; a concurrent request gets 409 `generation_in_progress`.<br>• The outcome write retries to the D4 deadline, and a lost commit answer is confirmed by the brief's `lastAttempt.usageLogId` (3d R10). | Research gap 13 (re-hydrated text in an unlabelled store); the O-58 analogue; `withOutputWriteRetry` and `outputCommitted` (`ops.ts`). | An outcome write that fails for good answers 500, and a retry after the lease expires re-bills (O-85). |
| P4B-15 | **Events and audit.**<br>• No outline events: the catalogue has none (L8189-8191), and outline steps write audit rows only.<br>• At assembly: `draft.generated` (`<draftId>_1_generated`), `draft.autosaved` (`_1_autosaved`: a stored version, E-50(h)) and `draft.gated` (`_1_gated_1`: born gated).<br>• Each payload is `{ draftId, matterId, documentTypeId, version: 1, gateResult: <assembly status>, masterVersion: null }`, with the draft's label. | L8189-8191, L8148, L8293; E-50(h) ("`draft.generated` is 4b", ES2:67); the E-40 precedent. | A subscriber that needs outline events gets a catalogue erratum. |
| P4B-16 | **Permissions.**<br>• New matter-level actions: `draft.generate` (partner, associate, clerk) and `draft.outline.approve` (partner, associate). Interns, clients and accounts are refused, as for every draft action.<br>• Every write transaction re-decides the permission (`requireStillPermitted`, R12): the brief, the lease, the outcome, the approval and the assembly.<br>• A refusal there stores nothing; P1's usage row still records any spend. | R-2; R12; L1366. | Two reads per write transaction. |
| P4B-17 | **Time budget.**<br>• P1's worst case is 102 s (60 transport, 2 trace, 30 commit, 10 slack) of the 120 s timeout.<br>• D4 gets `D4_PRECALL_BUDGET_MS` = 5,000 up to the lease commit, or 503 `generation_busy` with no call made.<br>• It gets `D4_WRITE_DEADLINE_MS` = 10,000 after the call for the outcome write and assembly. Its last `D4_ATTEMPT_SLACK_MS` = 4,000 is for the attempt in flight, as P1's `COMMIT_ATTEMPT_SLACK_MS` is: no attempt starts more than 6,000 after the call. An assembly that cannot start is `assembly: "pending"`.<br>• Both budgets run on the op's own clock from its entry; the 3 s left of the timeout cover the router's work around the handler.<br>• A throw between the lease and the outcome write releases the lease (plan D27).<br>• An import-time check asserts 117 s < 120 s.<br>• `GENERATION_LEASE_MS` = 180,000 exceeds the timeout. | `health.ts:12`; P3-63; 3d R10; O-57. | A slow round answers 503 or `pending`, and the client retries. Nothing bills twice. |
| P4B-18 | **Rules.**<br>• No client writes to any of the three collections.<br>• `draft_generations` and `draft_outlines` are readable as `drafts` are (P4-11).<br>• `draft_sections` is server-only. | A brief is the advocate's own text, and the outline must be read to be approved (L1356). Sections are court-facing text not yet gated; they become readable only as the gated version 1 (L6713-6715). | No reading sections before assembly. `getGeneration` shows progress. |
| P4B-19 | **Rank 4.**<br>• 4b adds no deterministic alternative and no partner exception.<br>• A rank-4 generation reaches a provider only where P1's policy allows it (a DPA and in-region, L8171).<br>• Otherwise P1 blocks it (`policy_denied`) and nothing is stored. | L8171-8172's "deterministic-only or partner-authorised exception" is unbuilt (`providerPolicy.ts:118-120`), and there is no template. The exception is the partner's privilege decision. | Rank-4 matters wait for O-81 or O-21. |
| P4B-20 | **O-21 and issue #26: policy-agnostic.**<br>• **Position A** (the set and ES2 as written): ranks 2-4 are blocked until a DPA (and, for rank 4, residency) is recorded. Production generation works only on `public` and `internal` matters.<br>• **Position B** (issue #26, if confirmed): a signed erratum over L8169-8172, L6982, L8442, L9446-9447, L9631-9632 and test 7 (L8505-8506), plus a `providerPolicy.ts` change. Masking stays on every call either way (P3-61 step 4; `maskOutboundPII.ts:3`).<br>• 4b changes neither `providerPolicy.ts` nor `data/provider_dpa.json`, and is tested at ranks 0-4 through `setProviderConfigForTests`. | The issue is unconfirmed. The requirement is the set's text, and O-21 records only missing facts (ES2:120). | Under Position A, real (privileged, L7005) matters wait for the partner (O-82). |
| P4B-21 | **Fixtures.**<br>• Citations use the year 2099 (P4-13).<br>• CNICs and phones are all-nines (`99999-9999999-9`, `0399-9999999`).<br>• Party names are fictitious, one of them a multi-word institutional name in the "Federation of Pakistan" form. | Behaviour standard §5. | None. |
| P4B-22 | **Gate and CI.**<br>• `ci_gates/gate_g4_phase4b.sh` (`npm run gate:g4:phase4b`): route coverage (15 `/api/d4/drafting` and 4 `/api/d4/intelligence` routes), named tests by exact full name counted from their arrays, `functions` lint at zero warnings, and G-2.<br>• One CI step runs after the Phase 4a gate. | Gate discipline as 2a to 4a. | None. |

## Out of scope (deferred, with reasons)

- **The P2 asynchronous path and silent failover** (L5536-5538, L956-957): O-56 and O-79. The per-section sync design fits the timeout, and the departure is recorded.
- **Real deterministic assembly and the Advanced picker** (L5492-5497, L5508-5512). Assembly needs P6 templates and the Drafting DNA (L2029-2030), and the picker has one priced model. 4b ships the check, the empty port, the path and the cost (O-80).
- **Dictation** (L1354): speech-to-text through P1 is not built (E-20).
- **The client-document working set** (L16.4): documents are not in Functions.
- **The style profile and the Drafting DNA voice** (L1355): not built. `firstGroundRule` is the only house-style input.
- **`openNoteFromDraft` pausing the outline** (L9500-9502): D5-1 notes do not exist.
- **Statute insertion with as-at stamps** (L6893-6894): 4c (O-64).
- **4d (O-65):** `[CITATION REQUIRED — PARTNER REVIEW]` marking, the L5.4 checklist, and placeholder detection beyond mask tokens.
- **Regenerating into an existing draft** (kind `generate` through `storeVersion`): a follow-up once the provenance shape settles.
- **Other modules:** the counter-argument mode and counter-memo (L1358), export (L1369), and FACT / ANALYSIS / HYPOTHESIS placement (L7025-7026; propositions are not built).
- **The O-21 / issue #26 change:** a separate erratum and P1 PR (O-82).

## Data model

All three collections are top-level with `firmId` (E-50(a)), and Cloud Functions writes them in transactions.

**`draft_generations/{generationId}`** (auto id):

| Field | Meaning |
| --- | --- |
| `firmId`, `matterId`, `documentTypeId`, `title` | as `drafts` |
| `facts` | 1-100,000 characters (the `committeeBrain` cap), in the charset rule's normalised form |
| `verbatim` | ≤ 20 `{ field, text }`: `field` a distinct `requiredFields` name; `text` 1-10,000 characters; ≤ 50,000 characters in total |
| `partyNames` | ≤ 50 supplied names, each 1-200 characters, added at every call to the matter's `matter_parties` names |
| `classification` | the generation label (P4B-13) |
| `stage`, `outlineVersion` | the stage; the current outline version (0 = none) |
| `approvedOutline` | null, or `{ version, sha256, by, at, acknowledgedMissingFacts: number[] }` |
| `sectionCount`, `sectionsStored` | the approved outline's section count (null before approval) and how many of its sections are stored |
| `templateId`, `path`, `model`, `promptVersion` | the type's `templateId`; `"ai"` once called (null before); the routed model; the prompt version |
| `calls`, `costMicroUsd` | P1 decisions for this generation and their total cost, billed refusals included |
| `lastAttempt` | null, or `{ step: "outline" \| "section", outlineVersion, section, outcome, reason, unsupportedRefs, usageLogId, traceId, costMicroUsd, at, by }` |
| `inFlight` | null, or the lease `{ claimId, step, outlineVersion, section, by, leaseUntil }` |
| `draftId`, `createdBy`, `createdAt`, `updatedAt` | `draftId` is null until assembly |

**Stages.**

| From | Step | To | Notes |
| --- | --- | --- | --- |
| (none) | `startDraft` | `facts` | |
| any but `assembled` | `generateOutline` | `outlined` | voids any approval |
| `outlined`, `approved`, `drafting` | `approveOutline` | `approved` | |
| `approved` | `generateDraft` (first section stored) | `drafting` | |
| `drafting` | assembly | `assembled` | `draftId` set |

- `generateDraft` is allowed in `approved` and `drafting` only.
- In `assembled`, every step except a replay is 409 `generation_closed`.
- Sections of a superseded outline stay stored and unused.

**`draft_outlines/{generationId}_{n}`** (immutable, n dense from 1):
- `firmId`, `matterId`, `generationId`, `version`, `kind` (`generated` or `edited`);
- `sections`: 1-25 `{ heading (one line, 1-200 characters), purpose (1-2,000) }`;
- `missingFacts`: 0-50 `{ field (one line, 1-100), note (1-500) }`;
- `sha256`: lowercase hex SHA-256 of UTF-8 `JSON.stringify({ sections: [{ heading, purpose }], missingFacts: [{ field, note }] })`, keys in that order, over the stored strings;
- `classification`; `editedFrom` (null for generated);
- `path`, `model`, `promptVersion`, `traceId`, `inputTokens`, `outputTokens`, `costMicroUsd` (null or 0 for an edit);
- `usageLogId` (an edit carries its source's);
- `createdBy`, `createdAt`.

**`draft_sections/{generationId}_{v}_{i}`** (immutable):
- `firmId`, `matterId`, `generationId`, `outlineVersion`, `section`, `heading`;
- `text` (re-hydrated, normalised), `textSha256`, `classification`;
- `path`, `model`, `promptVersion`, `usageLogId`, `traceId`, `inputTokens`, `outputTokens`, `costMicroUsd`;
- `createdBy`, `createdAt`.

**Changes to 4a.**
- `drafts` gains `generationId` on a generated draft (`DraftView` returns it).
- `draft_versions.kind` gains `"generate"`. Version 1 of a generated draft carries `generation: { generationId, outlineVersion, outlineSha256, path, model, promptVersion, usageLogIds, costMicroUsd, masterVersion: null }`. `usageLogIds` is the approved outline's `usageLogId` (when not null), then each section's (L1970-1971; L7063, O-62).
- `createdBy` on the draft and on version 1 is the assembling caller.
- The assembled body is each section's heading, a blank line and its text, with a blank line between sections. The title is the brief's.
- 4a's `classifyForMatter` and the `gateOps.ts` helpers `resultDocument`, `summaryOf`, `requireStorable` and `normaliseEvaluation` are exported, unchanged.

**Indexes** (`firestore.indexes.json`):
- `draft_generations` by `firmId`, `matterId`, `updatedAt` descending.
- Exempt from single-field indexing: `draft_generations.facts`, `.verbatim` and `.partyNames`; `draft_outlines.sections` and `.missingFacts`; `draft_sections.text`.
- O-63 (retention) extends to the three collections.

## Prompt contract

The fixed text lives in `functions/src/d4/generationPrompt.ts` under `promptVersion` `"4b.1"`. It is sent as P1's one user message (P3-68). The body never carries the classification, the matter id or a party list. Party names reach P1 only as `partyNames`: the matter's `matter_parties` `name` and `names` plus the brief's, longest first, read fresh for each call. `partyNamesFor` in `p1/ops.ts` is exported for this.

**Outline call** (`draft-outline`). The fixed instructions say:
- return only `{ "sections": [{ "heading", "purpose" }], "missingFacts": [{ "field", "note" }] }`, optionally in one ```` ```json ```` fence;
- order the sections by the type's architecture (facts as numbered paragraphs, grounds, prayer; L3840-3843);
- list each required field the facts lack;
- split any part that would need more than about 1,000 words into further sections, within 25;
- use no fact, and introduce no authority, that is not in the facts, and copy any authority used exactly;
- write no placeholder, bracketed note or ellipsis;
- copy every `⟦…⟧` token exactly and invent none.

The instructions are followed by the type's `name`, `firstGroundRule` and `requiredFields`, the verbatim fields (`<field>: <text>`, which P1 tokenises), and the facts.

**Section call** (`draft-section`). The fixed instructions say:
- write the body of section i of k as plain text, without its heading, following its purpose, in at most about 1,000 words (so an answer ends well inside the 60 s transport timeout; plan D25);
- the same fact, authority, placeholder and token rules apply;
- leave a missing point out rather than mark a gap;
- apply `firstGroundRule` to the first ground.

The instructions are followed by the type's `name` and `firstGroundRule`, the verbatim fields, the facts, the numbered approved outline, and section i − 1's text.

## P1 changes (E-52(a)-(c))

1. **Route.** `TaskType = "committee" | "drafting"`, and `TASK_MODEL.drafting = "anthropic/claude-opus-5.5"`. Prices are unchanged. `functions/test/p1.units.test.ts` pins both routes.
2. **Truncation.** `P1Transport.send` also returns `finishReason: string | null`, and `P1Result.truncated = outcome === "ok" && finishReason !== "stop"`. Charging, rows, events and traces are unchanged.
3. **Pseudonymiser.** It lives in `platform/p1/pseudonymiseOutboundPII.ts`. The pattern constants are exported from `maskOutboundPII.ts`, with no behaviour change.
   - **`pseudonymise(text, { partyNames, verbatim })`** returns `{ text, map, redactionCounts }`. It replaces, in this order:
     - each verbatim string (exact, longest first) with `⟦VERBATIM_n⟧`;
     - each distinct match of the mask's patterns, in the mask's order, with `⟦CNIC_n⟧`, `⟦PHONE_n⟧`, `⟦EMAIL_n⟧`, `⟦IBAN_n⟧`, `⟦NTN_n⟧` or `⟦PASSPORT_n⟧`;
     - each supplied party name (longest first, case-insensitive) with `⟦PARTY_n⟧`, one token per supplied name.

     n counts from 1 per kind. The map is a frozen list of `{ token, kind, value }` and holds every supplied name and verbatim string.
   - **`applyMap(text, map, { partyNames })`** handles the response. A mapped value becomes its token. Any other pattern match becomes the lossy token, which D4 refuses.
   - **`rehydrate(text, map)`** replaces each token with its value. A party name comes back as supplied.
4. **Request.** `P1Request.pseudonymise?: { verbatim: readonly string[] }`. When present:
   - step 4 pseudonymises the body, and the purpose keeps the lossy mask (it is never sent);
   - `assertMinimised` runs unchanged on the pseudonymised body;
   - step 9 applies `applyMap`;
   - an `ok` result carries `pseudonyms`.

   `text`, `outbound`, the trace and every row carry tokens only, and `redactionCounts` gains `verbatim`. `committeeBrain` does not set the field and is unchanged.

## Routes

All routes are under `/api/d4/drafting/` (L8041-8047; E-37). Every POST needs an `Idempotency-Key`. `generateOutline` and `generateDraft` are rate kind `p1` (10 per minute, L8157); the rest are `general`. Lists paginate as in 4a.

| Route | Method | Action | Input | Returns |
| --- | --- | --- | --- | --- |
| `startDraft` | POST | `draft.create` | `{ matterId, documentTypeId, title, facts, verbatim?, partyNames?, classification? }` | `{ generationId, stage, classification, outlineVersion }` |
| `generateOutline` | POST | `draft.generate` | `{ generationId, baseOutlineVersion }` (the current version; the new one is base + 1) | `OutlineStepResult` |
| `approveOutline` | POST | `draft.outline.approve` | `{ generationId, outlineVersion, outlineSha256, outline?, acknowledgedMissingFacts }` | `{ generationId, stage, outlineVersion, outlineSha256, sectionCount }` |
| `generateDraft` | POST | `draft.generate` | `{ generationId, outlineVersion, section }` | `SectionStepResult` |
| `getGeneration` | GET | `draft.read` | `?generationId=` | the brief, with `inFlight` shown as `inProgress: boolean` |
| `getOutline` | GET | `draft.read` | `?generationId=&version=` (default current) | the outline with `approved: boolean` |
| `listGenerations` | GET | `draft.read` | `?matterId=&limit=&cursor=` | cleared briefs, newest `updatedAt` first, without `facts`, `verbatim`, `partyNames` or `unsupportedRefs` |

- **`OutlineStepResult`** is `{ generationId, stage, step, outlineVersion, called, outcome, reason, path, model, usage: { inputTokens, outputTokens, costMicroUsd }, usageLogId, traceId }`. `usage`, `usageLogId` and `traceId` are this request's, and are zero or null when `called` is false.
- **`SectionStepResult`** adds `section`, `assembly` (`none`, `assembled`, `refused` or `pending`), `assemblyReason` and `draftId`.
- **Loading.** A brief is loaded as `loadDraftForCaller` loads a draft: an unusable id, an absent brief, another firm's brief and one above the caller's clearance are all 404 `not_found`. The action is checked on its matter.
- **`startDraft`.** One transaction writes the brief (stage `facts`) and the audit row. A closed matter is 409 `matter_closed` (R4), and the type must admit the court (422 `court_mismatch`).

**Order in the P1 routes:**
1. Parse (400).
2. Load the brief and check the permission.
3. A closed matter: 409 `matter_closed`.
4. A stored result for this key: return it (`called: false`), assembling if due.
5. `generation_closed`.
6. The approval and version checks (`outline_changed`, `outline_not_approved`, `section_not_found`, `previous_section_missing`).
7. A live lease: 409 `generation_in_progress`.
8. `deterministicFirstCheck` (501).
9. The lease transaction.
10. `callP1`.
11. The guardrails.
12. The outcome transaction: totals, `lastAttempt`, lease release, and the outline or section on acceptance.
13. Assembly when due.

**`approveOutline` with no edit** of a version already approved under the same hash writes only its audit row.

## Outcomes and errors

A request that reaches a P1 decision answers **200** with its outcome, as `committeeBrain` does (P3-70). An error body carries only `{ error: { code } }` (R1) and could not report the usage and cost.

| `outcome` | `reason` |
| --- | --- |
| `stored` | null |
| `blocked` | P1's: `kill_switch_platform`, `kill_switch_firm`, `policy_denied`, `not_minimised`, `model_unpriced`, `budget_not_set`, `budget_exhausted`, `no_credentials` |
| `failed` | `transport_error` |
| `refused` | `output_truncated`, `output_unparseable`, `rehydration_failed`, `output_too_large`, `output_unsupported_characters`, `unsupported_authority` |

`assembly: "refused"` carries an `assemblyReason`: `draft_too_large`, `gate_result_too_large`, `matter_closed` or `court_mismatch`. The section stays stored.

| Status | Codes |
| --- | --- |
| 400 | `matter_required`, `invalid_document_type`, `invalid_title`, `invalid_facts`, `invalid_verbatim`, `invalid_party_names`, `invalid_classification`, `invalid_generation_id`, `invalid_version`, `invalid_outline_hash`, `invalid_outline`, `invalid_acknowledgement`, `invalid_section`, `invalid_cursor`, `invalid_limit` |
| 403 | `clearance`; as `requirePermission` maps them: `not_member`, `role_not_permitted`, `intern_channel_denied`, `client_denied`, `accounts_register_only` |
| 404 | `not_found`, `document_type_not_found`, `outline_not_found`, `section_not_found` |
| 409 | `matter_closed`, `generation_closed`, `outline_changed`, `outline_not_approved`, `previous_section_missing`, `generation_in_progress`, `generation_changed` (the lease is not this request's at the outcome write; nothing stored) |
| 422 | `court_mismatch`, `classification_below_matter`, `unsupported_characters`, `title_too_long`, `reserved_tokens`, `missing_facts_not_acknowledged` |
| 501 | `deterministic_not_built` |
| 503 | `generation_busy`, `audit_unavailable` |

- **The 400 checks** run before the permission, in field order. `baseOutlineVersion` is an integer ≥ 0, and the other versions and `section` are integers ≥ 1. `outlineSha256` is 64 lowercase hex characters. `acknowledgedMissingFacts` holds distinct integers from 0 to 49.
- **The 422 text rules** apply after the permission (no oracle).
- **Replay.** None of the new 409s joins `STORED_409_CODES`.

## Events, audit, permissions and rules

- **Events.** As P4B-15; `stageDraftEvent`'s union gains `draft.generated`.
- **Audit actions.** `draft.create` (target `draft_generations/{id}`); `draft.generate` (the two P1 routes, plus the assembly row: reason `assembled`, target `drafts/{draftId}`); `draft.outline.approve`; `draft.read`. A refusal is a deny through `runAudited`. P1 adds its own `ai.call.*` event and `ai.gateway.decision` row per call.
- **Permissions.** `platform/p5/permissionDecision.ts`: `DRAFT_ACTIONS` and `DRAFT_ROLES` gain `draft.generate: ["partner", "associate", "clerk"]` and `draft.outline.approve: ["partner", "associate"]`, matter-level through `matterGate`.
- **Rules.** In `firestore.rules`, `draft_generations` and `draft_outlines` take the `drafts` read expression (`sameFirm() && isAuthor() && isMember(…matterId) && cleared(own label) && cleared(the matter's current label)`) and deny create, update and delete. `draft_sections` is `allow read, write: if false`.

## Stress test

- **For jobs.** L988 makes "Every AI action is a Job" non-negotiable, and a 25-section draft is 25 client round trips.
  - Answer: progress is durable (stored sections; `listGenerations` resumes), P2 cannot carry a provider call yet (O-56), and the departure is recorded (E-52(d)).
- **Against refusing model authorities.** The model writes only with the advocate's authorities.
  - That is L960-961 and F-8 (L9688-9689). With an empty corpus nothing the model cites could be verified anyway.
- **Against the guardrail.** It sees case citations only. An invented section of an Act passes it and the gate until 4c (O-83); 4b relies on the instruction and the partner's reading.
- **Leak paths for the map.** It exists only in a local variable between `callP1` and the outcome write. Errors carry fixed codes and logs carry ids. Test 1 scans every row, event, audit row, trace, idempotency row and captured log line.
- **Masking gaps.** Addresses, partial names and aliases go out in clear (the O-13 gap, though L9538 lists addresses). Verbatim fields keep land descriptions out. The gap matters more under Position B (O-78).
- **Untested premises.**
  - A section fits 4,096 tokens and 60 s (O-57).
  - The Gateway reports `"stop"` (O-84).
  - Opus returns strict JSON (a failure costs one call).

## Testing

**Required named tests.** All run under the Auth and Firestore emulators with a stub transport.
1. **Mask round trip.** The facts carry a CNIC and two party names, one institutional. The transport and the trace receive neither. The stored outline, sections and draft hold the real text. No row, event, audit row, idempotency row or log line holds a fixture value outside those texts (the analogue of L9638).
2. **Bad tokens.** `⟦PARTY_9⟧`, a bare `PARTY_1` and `[CNIC]` in an answer are each refused `rehydration_failed`, with nothing stored.
3. **Introduced authority.**
   - A section citing `2099 SCMR 7`, absent from the facts, is refused `unsupported_authority`, with the ref recorded on the brief only.
   - A section citing only the advocate's `PLD 2099 SC 101` is stored, assembled and gated UNVERIFIED.
   - Approval is 409 `gate_blocked` until a member partner overrides; then it succeeds (the test 4 analogue, L8497).
4. **Privileged, no DPA.** `policy_denied`, `ai.call.blocked`, recorded on the brief, and no outline stored (the test 7 analogue, L8505-8506).
5. **Truncation.** A `"length"` and an absent `finish_reason` are each refused `output_truncated`. The call is billed on the brief and the usage row, and no section is stored.
6. **Approval binding.**
   - A clerk gets 403 `role_not_permitted`.
   - A wrong hash or version gets 409 `outline_changed`.
   - Unacknowledged missing facts get 422.
   - `generateDraft` is 409 `outline_not_approved` before approval and 409 `outline_changed` after a newer outline.
   - An edit stores n + 1 (kind `edited`) and approves it.
7. **Stop between sections.** A firm kill switch after section 1 leaves section 2 `blocked` and section 1 stored. Once cleared, section 2 (new key) is stored with no second call for section 1. The same holds for `budget_exhausted`.
8. **Rank 4.** `privileged-restricted` is `policy_denied` with an empty config and with a DPA but not in-region. No deterministic path is offered.
9. **Replay.**
   - A same-key replay has no text field.
   - A new-key request for a stored section makes no transport call (`called: false`).
   - Two concurrent requests for one section make one call; the other gets 409 `generation_in_progress`.
10. **One assembly transaction.** A seam failure in assembly leaves no draft, version, gate result or event, and a retry assembles. Afterwards `draft_versions/{id}_1` and `draft_gate_results/{id}_1` share `bodySha256`, and no generated version is ever observable without its result.

**Also required:**
- **Deterministic-first.** A test template gives 501 with no transport call.
- **Ranks 0-4.** Through `setProviderConfigForTests`: `{}` lets ranks 0-1 through, a DPA adds ranks 2-3, and a DPA in-region adds rank 4.
- **Verbatim.** The text is stored exactly and never sent.
- **Reserved tokens.** Refused at `startDraft` and in an outline edit.
- **Classification.** A label raised mid-run raises the next section, the draft and the P1 label.
- **R12.** A member removed during the call gets 403 at the outcome write, with nothing stored and the usage row present.
- **Lease on error.** A throw after the lease and before the outcome write releases the lease, and a retry runs at once.
- **Events and audit.** Rows written at assembly; none at the outline steps.
- **Boot and timing.** The time-budget import check, and the boot test (19 D4 routes, `EMPTY_TEMPLATE_STORE`, the exemptions).
- **P1 units** (`p1.units.test.ts`, `p1.transport.test.ts`, `tests/p1.pseudonymise.test.ts`): the `drafting` route, the `finish_reason` mapping, the pseudonymiser, and `committeeBrain` unchanged.
- **Permissions** (`tests/p5.permission-draft-actions.test.ts`), for every role.
- **Rules** (`tests/firestore.rules.d4-phase4b.test.ts`), with intern and cross-label denial.
- **G-2.** One cross-firm probe for each of the seven routes in `functions/test/g2.cross-firm.test.ts`. Each answers 404 `not_found` or the cross-firm refusal and leaks no existence.

**Files and seams.** New: `functions/test/d4.generation.emu.test.ts` and `d4.generation.test.ts` (the parser, the guardrails, the assembly body). Seams:
- `setTemplateStoreForTests`;
- `d4GenerationTestSeam` (`failAssembly`, `outcomeWriteFailures`, `lostCommitAnswers`, `wallClock`, `beforeOutcomeWrite`), inert in production;
- the existing transport, provider-config and authority-store seams.

## Errata and open items

The implementation adds these errata to `docs/architecture/ERRATUM_SET_2_PROPOSED.md` and a "Phase 4b rulings" entry to the rulings ledger.

- **E-52: P1 and the sync departure.**
  - (a) `drafting` → `anthropic/claude-opus-5.5`; the GPT-4o fallback is neither priced nor routed.
  - (b) `truncated` from `finish_reason`; anything but `"stop"` counts.
  - (c) The indexed pseudonymiser. Its map is returned in process only, which amends R13's "never returned" for the caller's own inputs.
  - (d) `generateOutline` and `generateDraft` are sync HTTP routes, one call each, departing from L8142-8144, L988, L1970 and L5538 until O-56 / O-79.
  - (e) For drafting, L16.1's deterministic-first check is in D4 (against L7989-7992 and L8659; per L5517). P1 keeps model selection.
- **E-53: the generation store, events and guardrails.**
  - (a) The three collections and their stages; `drafts` only at assembly.
  - (b) The seven routes, `draft.generate` and `draft.outline.approve`.
  - (c) Kind `generate` with provenance, and `drafts.generationId`.
  - (d) The three assembly events; no outline events.
  - (e) The guardrails, which make L960-961 mechanical (only a human introduces an authority). Gating never refuses storage.
  - (f) The rules.
  - (g) Outcomes in a 200 body; no text in POSTs.

| ID | Item | Owner |
| --- | --- | --- |
| O-77 | L953's GPT-4o fallback has no price in `costTable.ts`. Price it from the Gateway's list (never invented) before O-56's failover routes `drafting` to it. | Engineering |
| O-78 | Addresses (the O-13 recorded gap; L9538), partial names and aliases (L17.2 `entity_aliases`) are not pseudonymised. Until this closes, addresses and land descriptions belong in verbatim fields. | Engineering; partner (address forms) |
| O-79 | Move `generateOutline` and `generateDraft` to the provider-calling P2 job type when O-56 builds it; E-52(d) then ends. | Engineering |
| O-80 | A production `TemplateStore` over P6 templates, the clause library and the Drafting DNA (L2026-2027, L2029-2030, L7053); `routeOrAssemble` (L5511); the Advanced picker (L5492-5494); the style profile (L1355). | Engineering, with P6; partner |
| O-81 | The rank-4 "partner-authorised exception with recorded reason" (L8171-8172; `providerPolicy.ts:118-120`). | Partner, then engineering |
| O-82 | Issue #26 awaits the owner's confirmation. If confirmed: a signed erratum over L8169-8172, L6982, L8442, L9446-9447, L9631-9632 and test 7 (L8505-8506), and a P1 PR. 4b's code does not change, and masking stays. | Partner |
| O-83 | Guardrail 6 sees case citations only. A model-introduced statutory provision is neither refused nor gated until 4c; extend it with 4c's extractor (O-64). | Engineering |
| O-84 | Verify at G-1, with O-57, that the Gateway reports `"stop"` for a complete Anthropic answer and `"length"` at `max_tokens` [REQUIRES VERIFICATION]. | Engineering |
| O-85 | The O-58 analogue: an outcome write that fails for good after a billed call answers 500, and a retry after the lease expires re-bills. Fix with O-58. | Engineering |
| O-86 | Confirm that "advocate" (L1356, L1366) means partner or associate, with clerks refused and self-approval allowed, or add a four-eyes rule. | Partner |
