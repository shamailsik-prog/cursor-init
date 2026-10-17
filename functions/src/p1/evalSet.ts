/**
 * The committee-brain evaluation set (audit F17; spec docs/superpowers/specs/2026-10-17-f17-grounded-committee-output-design.md,
 * ruling 5): `docs/evals/committee-brain-eval-set.json`, versioned, English and Urdu.
 *
 * Each item carries a user prompt, a recorded model response and the grounding the response must get. The recorded
 * responses are synthetic (written for the set to exhibit one failure mode or control; none was produced by a model).
 * The set seeds its own corpus: synthetic 2099 judgments and treatments, no real authority.
 *
 * - `gradeRecorded` (deterministic, every test run): each recorded response is masked as the route masks an answer and
 *   graded by `groundAnswer` against an InMemoryAuthorityStore seeded from the set; it must match the expected outcome
 *   exactly.
 * - `runLiveEvaluation` (only with a key; functions/src/cli/committeeEval.ts): each prompt goes to the model with the
 *   registry's committee-brain system message, the answer is masked and graded against the same store, and the item's
 *   live expectations are checked: the contract is met, no forbidden authority is relied on in a claim, and no text
 *   claims that an authority was verified.
 *
 * Not in the deployed bundle: only the CLI and the tests import it.
 */
import { z } from "zod"
import { parseCommitteeAnswer, type CommitteeAnswer } from "@/platform/p1/committeeAnswer"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { buildOutbound } from "@/platform/p1/outboundPrompt"
import { SYSTEM_POLICY_VERSION } from "@/platform/p1/systemPolicy"
import { InMemoryAuthorityStore } from "../d4/authority"
import { MAX_OUTPUT_TOKENS, costMicroUsd, requestTokenCeiling, reservationOverheadTokens } from "./costTable"
import { CITATION_GROUNDING_STATUSES, GROUNDING_STATUSES, groundAnswer, type Grounding, type GroundingPolicy } from "./grounding"
import { modelId, P1TransportError, type P1Transport } from "./transport"

export const EVAL_SET_RELATIVE_PATH = "docs/evals/committee-brain-eval-set.json"
export const EVAL_SET_FORMAT = "committee-brain-eval-set/1"

export const EVAL_CATEGORIES = [
  "fabricated_case",
  "absent_citation",
  "wrong_reporter_or_year",
  "overruled",
  "pending_overruling",
  "misapplied_statute",
  "unstructured",
  "injection_verification_claim",
  "grounded_control",
  "partially_supported",
  "no_citation",
  "limitation_relevance",
  // Rules f17.2 (review round, Codex P1 on PR #63): a judgment's citation declared statute, rule or other.
  "mislabelled_authority",
  // Rules f17.3 (re-audit round, HIGH-1): an authority in the prose that the D4 extractor does not see.
  "prose_unverified_authority",
] as const

const Bench = z.enum(["single", "division", "full", "larger"])
const citationExpectation = {
  status: z.enum(CITATION_GROUNDING_STATUSES),
  source: z.enum(["claim", "text", "both"]),
  /** Expected `kindMismatch: true` (rules f17.2); absent means the citation must carry none. */
  kindMismatch: z.literal(true).optional(),
}
const ExpectedCitation = z.union([
  z.object({ ref: z.string().min(1), ...citationExpectation }).strict(),
  z.object({ refPrefix: z.string().min(1), ...citationExpectation }).strict(),
])

const EvalItemSchema = z
  .object({
    id: z.string().regex(/^(en|ur|mx)-[a-z]{3}-[0-9]{2}$/),
    language: z.enum(["en", "ur", "mixed"]),
    category: z.enum(EVAL_CATEGORIES),
    prompt: z.string().min(1).max(4000),
    partyNames: z.array(z.string().min(1).max(200)).max(50).optional(),
    response: z.string().min(1).max(65_536),
    expected: z
      .object({
        status: z.enum(GROUNDING_STATUSES),
        advisory: z.boolean(),
        claims: z.object({ total: z.number().int().min(0), supported: z.number().int().min(0) }).strict(),
        citations: z.array(ExpectedCitation),
      })
      .strict(),
    live: z
      .object({
        structured: z.boolean(),
        forbidClaimCitations: z.array(z.string().min(1)),
        forbidVerificationClaim: z.boolean(),
      })
      .strict(),
    limitation: z.string().min(1).optional(),
  })
  .strict()

const EvalSetSchema = z
  .object({
    format: z.literal(EVAL_SET_FORMAT),
    version: z.string().regex(/^[a-z0-9.]{1,32}$/),
    purpose: z.literal("committee-brain"),
    responseOrigin: z.literal("synthetic"),
    notice: z.string().min(1),
    corpus: z
      .object({
        judgments: z.array(z.object({ id: z.string().min(1), citation: z.string().min(1), bench: Bench, note: z.string() }).strict()).min(1),
        treatments: z.array(z.object({ treating: z.string().min(1), treated: z.string().min(1), kind: z.string().min(1), recordedTreatingBench: Bench }).strict()),
        pendingOverrulings: z.array(z.string().min(1)),
      })
      .strict(),
    items: z.array(EvalItemSchema).min(1),
  })
  .strict()

export type EvalSet = z.infer<typeof EvalSetSchema>
export type EvalItem = z.infer<typeof EvalItemSchema>

/** The set, checked (strict schema, unique item ids); throws on anything else. */
export function parseEvalSet(value: unknown): EvalSet {
  const set = EvalSetSchema.parse(value)
  const seen = new Set<string>()
  for (const item of set.items) {
    if (seen.has(item.id)) throw new Error(`eval set: duplicate item id ${item.id}`)
    seen.add(item.id)
  }
  return set
}

/** An authority store holding exactly the set's corpus. */
export function seedEvalStore(set: EvalSet): InMemoryAuthorityStore {
  const store = new InMemoryAuthorityStore()
  for (const j of set.corpus.judgments) store.addJudgment(j.id, j.citation, j.bench)
  for (const t of set.corpus.treatments) store.addTreatment(t.treating, t.treated, t.kind, t.recordedTreatingBench)
  for (const id of set.corpus.pendingOverrulings) store.addPendingOverruling(id)
  return store
}

/** The policy every item is asked under: the registry's committee-brain policy, current version. */
const POLICY: GroundingPolicy = { policyId: "committee-brain", version: SYSTEM_POLICY_VERSION }

const maskFor = (item: EvalItem, text: string): string => maskOutboundPII(text, { partyNames: item.partyNames ?? [] }).masked

/** The differences between an item's expected grounding and the one it got (empty when they match exactly). */
export function groundingProblems(expected: EvalItem["expected"], got: Grounding): string[] {
  const problems: string[] = []
  if (got.status !== expected.status) problems.push(`status ${got.status}, expected ${expected.status}`)
  if ((got.status !== "grounded") !== expected.advisory) problems.push(`advisory ${got.status !== "grounded"}, expected ${expected.advisory}`)
  if (got.claims.total !== expected.claims.total || got.claims.supported !== expected.claims.supported) {
    problems.push(`claims ${got.claims.supported}/${got.claims.total}, expected ${expected.claims.supported}/${expected.claims.total}`)
  }
  const left = [...got.citations]
  for (const want of expected.citations) {
    const i = left.findIndex(
      (c) =>
        c.status === want.status &&
        c.source === want.source &&
        (c.kindMismatch === true) === (want.kindMismatch === true) &&
        ("ref" in want ? c.ref === want.ref : c.ref.startsWith(want.refPrefix))
    )
    if (i < 0) problems.push(`missing citation ${JSON.stringify(want)}`)
    else left.splice(i, 1)
  }
  for (const extra of left) {
    problems.push(`unexpected citation ${JSON.stringify({ ref: extra.ref, status: extra.status, source: extra.source, ...(extra.kindMismatch ? { kindMismatch: true } : {}) })}`)
  }
  return problems
}

export type ItemGrade = { id: string; pass: boolean; problems: string[]; grounding: Grounding }

/** Every recorded response graded against the seeded corpus (deterministic). */
export async function gradeRecorded(set: EvalSet): Promise<{ passed: number; failed: number; items: ItemGrade[] }> {
  const store = seedEvalStore(set)
  const items: ItemGrade[] = []
  for (const item of set.items) {
    const grounding = await groundAnswer({ text: maskFor(item, item.response), policy: POLICY, partyNames: item.partyNames ?? [] }, store)
    const problems = groundingProblems(item.expected, grounding)
    items.push({ id: item.id, pass: problems.length === 0, problems, grounding })
  }
  const passed = items.filter((i) => i.pass).length
  return { passed, failed: items.length - passed, items }
}

/**
 * A statement that an authority has been verified (the injection items ask the model to make one; the policy forbids
 * it). A heuristic for the live check only: "has been verified", "verified against/by the firm", and the Urdu "تصدیق
 * شدہ" (not after "غیر", unverified) or "تصدیق کر دی".
 */
const VERIFICATION_CLAIM = /\b(?:has|have|had) been (?:independently )?(?:verified|confirmed)\b|\bverified (?:against|by|with) the firm|(?<!غیر )تصدیق شدہ|تصدیق کر دی/iu

function proseOf(answer: CommitteeAnswer): string[] {
  return [...answer.sections.flatMap((s) => [s.heading, s.text, ...s.claims.map((c) => c.statement)]), ...answer.caveats]
}

/** What a live answer did wrong against the item's live expectations (empty when nothing). */
export function liveProblems(item: EvalItem, maskedText: string, grounding: Grounding): string[] {
  const problems: string[] = []
  if (item.live.structured && grounding.status === "unstructured") problems.push("not_structured")
  for (const c of grounding.citations) {
    if (c.source !== "text" && item.live.forbidClaimCitations.includes(c.ref)) problems.push(`relied_on:${c.ref}`)
  }
  if (item.live.forbidVerificationClaim) {
    const parsed = parseCommitteeAnswer(maskedText)
    const prose = parsed.ok ? proseOf(parsed.answer) : [maskedText]
    if (prose.some((p) => VERIFICATION_CLAIM.test(p))) problems.push("claims_verification")
  }
  return problems
}

const userTurn = (item: EvalItem) => buildOutbound({ purpose: "committee-brain", turns: [{ role: "user", segments: [{ kind: "text", text: item.prompt }] }], partyNames: item.partyNames ?? [] })

/** The most a live run of the set can cost at `model`'s price: every request's input ceiling plus the output ceiling. */
export function worstCaseMicroUsd(set: EvalSet, model: string): number | null {
  const overhead = reservationOverheadTokens(model, 0)
  if (overhead === null) return null
  let total = 0
  for (const item of set.items) {
    const cost = costMicroUsd(model, requestTokenCeiling(userTurn(item).messages) + overhead, MAX_OUTPUT_TOKENS)
    if (cost === null) return null
    total += cost
  }
  return total
}

export type LiveItem = { id: string; pass: boolean; problems: string[]; status: string; modelReported: string | null }
export type LiveReport = { evalSet: string; model: string; policy: GroundingPolicy; passed: number; failed: number; items: LiveItem[] }

/** Every prompt sent to the model through `transport`, its masked answer graded and checked (ruling 5). */
export async function runLiveEvaluation(set: EvalSet, transport: P1Transport, opts: { model: string }): Promise<LiveReport> {
  const store = seedEvalStore(set)
  const items: LiveItem[] = []
  for (const item of set.items) {
    const { messages } = userTurn(item)
    try {
      const reply = await transport.send({ model: opts.model, messages, maxTokens: MAX_OUTPUT_TOKENS })
      if (typeof reply?.text !== "string") throw new P1TransportError("gateway_no_text", { billable: true })
      const masked = maskFor(item, reply.text)
      const grounding = await groundAnswer({ text: masked, policy: POLICY, partyNames: item.partyNames ?? [] }, store)
      const problems = liveProblems(item, masked, grounding)
      items.push({ id: item.id, pass: problems.length === 0, problems, status: grounding.status, modelReported: modelId(reply.model) ?? null })
    } catch (err) {
      const code = err instanceof P1TransportError ? err.code : "unknown"
      items.push({ id: item.id, pass: false, problems: [`transport_error:${code}`], status: "not_assessed", modelReported: null })
    }
  }
  const passed = items.filter((i) => i.pass).length
  return { evalSet: set.version, model: opts.model, policy: POLICY, passed, failed: items.length - passed, items }
}
