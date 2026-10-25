import { createHash } from "node:crypto"
import { logger } from "firebase-functions"
import { describe, expect, it, vi } from "vitest"
import { AGENT_INSTRUCTIONS_SHA256 } from "@/platform/p1/agentInstructions"
import { MASK_POLICY_VERSION, REDACTION_KINDS, maskOutboundPII, type RedactionKind } from "@/platform/p1/maskOutboundPII"
import { PROMPT_HASH_ALGORITHM, PROMPT_TEMPLATE_PINS, promptHash, promptTemplateOf } from "@/platform/p1/promptTemplates"
import { SYSTEM_POLICIES, SYSTEM_POLICY_IDS, SYSTEM_POLICY_VERSION, systemPolicyText } from "@/platform/p1/systemPolicy"
import { FieldValue } from "firebase-admin/firestore"
import { IDEMPOTENCY_TTL_MS } from "../src/http/idempotency"
import {
  HASH_WITHHELD_NO_OUTPUT_ROW,
  PROMPT_HASH_WITHHOLD_AFTER_MS,
  TRACE_EXPORT_BACKOFF_MS,
  TRACE_EXPORT_MAX_ATTEMPTS,
  authorityFactsSha256,
  exportAfterCall,
  exportFields,
  joinDecision,
  nextExport,
  publicationFields,
  reconciledDecision,
  type DecisionParts,
} from "../src/p1/decisionRecord"
import { TRACE_TEXT_MAX_RANK, buildTrace, exportTrace, opikConfig, type TraceRecord } from "../src/p1/opik"
import { modelMatches } from "../src/p1/ops"

/**
 * Audit F34 units (spec docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md): the prompt hash
 * and the template pin (R3), the authority facts hash (R5), the export state machine (R11), the trace content rule (R10)
 * and the reconstruction join (R13). Pure: no emulator. The re-audit R1 follow-up (section 5) adds the hash export rule
 * (R15), the exported model name (R19), the disabled reason and the misconfiguration line (R23), the mask version (R25)
 * and the lease reconciler's record (R16, R21).
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

/** A trace record as a call builds it; tests override what they vary. */
const record = (over: Partial<TraceRecord> = {}): TraceRecord => ({
  traceId: "0199c3a0-0000-7000-8000-000000000001",
  startMs: 0,
  endMs: 1,
  taskType: "committee",
  classification: "internal",
  outcome: "ok",
  blockReason: null,
  model: "anthropic/claude-opus-5.5",
  provider: "ai-gateway",
  inputTokens: 1,
  outputTokens: 1,
  costMicroUsd: 24,
  firmId: "firm-1",
  matterId: "matter-1",
  usageLogId: "usage-1",
  maskedBody: "MASKED BODY",
  maskedResponse: "MASKED RESPONSE",
  promptHash: "a".repeat(64),
  promptTemplateId: "committee-brain",
  promptTemplateVersion: SYSTEM_POLICY_VERSION,
  modelReported: "claude-opus-5.5",
  ...over,
})
const SYSTEM = SYSTEM_POLICIES["committee-brain"].text
const MESSAGES = [
  { role: "system" as const, content: SYSTEM },
  { role: "user" as const, content: "Draft a reply to the notice." },
]

describe("F34 R3: the prompt hash", () => {
  it("is the SHA-256 of the canonical JSON of the messages as sent, role and content in order", () => {
    expect(PROMPT_HASH_ALGORITHM).toBe("sha256/p1-messages-v1")
    expect(promptHash(MESSAGES)).toBe(sha256(JSON.stringify([["system", SYSTEM], ["user", "Draft a reply to the notice."]])))
  })

  it("changes with any role, content or order, and never collides a split with a join", () => {
    const base = promptHash(MESSAGES)
    expect(promptHash([MESSAGES[0]!, { role: "assistant", content: MESSAGES[1]!.content }])).not.toBe(base)
    expect(promptHash([MESSAGES[0]!, { role: "user", content: "Draft a reply to the notice!" }])).not.toBe(base)
    expect(promptHash([MESSAGES[1]!, MESSAGES[0]!])).not.toBe(base)
    expect(promptHash([{ role: "user", content: "ab" }, { role: "user", content: "c" }])).not.toBe(promptHash([{ role: "user", content: "a" }, { role: "user", content: "bc" }]))
  })

  it("reads only role and content (an extra field on a message does not change it)", () => {
    expect(promptHash(MESSAGES.map((m) => ({ ...m, extra: "x" })) as never)).toBe(promptHash(MESSAGES))
  })
})

describe("F34 R3: the pinned template", () => {
  it("names every registry policy at the current version and at f16.1, with its pinned hash", () => {
    for (const id of SYSTEM_POLICY_IDS) {
      for (const version of [SYSTEM_POLICY_VERSION, "f16.1"]) {
        expect(promptTemplateOf({ policyId: id, version }), `${id}@${version}`).toEqual({
          templateId: id,
          templateVersion: version,
          templateSha256: sha256(systemPolicyText(id, version)!),
          agentInstructionsSha256: null,
        })
      }
    }
  })

  it("is null for an unknown policy, an unknown version, a malformed record, or a record with extra keys", () => {
    expect(promptTemplateOf({ policyId: "constructor", version: SYSTEM_POLICY_VERSION })).toBeNull()
    expect(promptTemplateOf({ policyId: "committee-brain", version: "f99.9" })).toBeNull()
    expect(promptTemplateOf(null)).toBeNull()
    expect(promptTemplateOf("committee-brain")).toBeNull()
    expect(promptTemplateOf({ policyId: "committee-brain", version: SYSTEM_POLICY_VERSION, text: SYSTEM })).toBeNull()
  })

  it("is null when the registry text does not hash to its pin (a text edited without a version bump)", () => {
    const pins = { ...PROMPT_TEMPLATE_PINS, [`committee-brain@${SYSTEM_POLICY_VERSION}`]: sha256(`${SYSTEM} `) }
    expect(promptTemplateOf({ policyId: "committee-brain", version: SYSTEM_POLICY_VERSION }, pins)).toBeNull()
    expect(promptTemplateOf({ policyId: "summarise", version: SYSTEM_POLICY_VERSION }, pins)).not.toBeNull()
    const unpinned: Record<string, string> = { ...PROMPT_TEMPLATE_PINS }
    delete unpinned[`summarise@${SYSTEM_POLICY_VERSION}`]
    expect(promptTemplateOf({ policyId: "summarise", version: SYSTEM_POLICY_VERSION }, unpinned)).toBeNull()
  })

  it("carries the eve bridge's pinned instructions digest, and refuses any other digest", () => {
    expect(promptTemplateOf({ policyId: "committee-brain", version: SYSTEM_POLICY_VERSION, agentInstructionsSha256: AGENT_INSTRUCTIONS_SHA256 })).toMatchObject({
      templateId: "committee-brain",
      agentInstructionsSha256: AGENT_INSTRUCTIONS_SHA256,
    })
    expect(promptTemplateOf({ policyId: "committee-brain", version: SYSTEM_POLICY_VERSION, agentInstructionsSha256: "0".repeat(64) })).toBeNull()
  })
})

describe("F34 R5: the authority facts hash", () => {
  const T1 = { kind: "followed", treatingJudgmentBench: "single" as const, recordedTreatingBench: "single" as const }
  const T2 = { kind: "overruled", treatingJudgmentBench: "larger" as const, recordedTreatingBench: "larger" as const }

  it("is a SHA-256 over the judgment id, its bench and its treatments, independent of their order", () => {
    const a = authorityFactsSha256("j-1", "division", [T1, T2])
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(authorityFactsSha256("j-1", "division", [T2, T1])).toBe(a)
  })

  it("changes with the judgment, the bench, any treatment's kind or benches, and an added treatment", () => {
    const a = authorityFactsSha256("j-1", "division", [T1])
    expect(authorityFactsSha256("j-2", "division", [T1])).not.toBe(a)
    expect(authorityFactsSha256("j-1", "full", [T1])).not.toBe(a)
    expect(authorityFactsSha256("j-1", "division", [{ ...T1, kind: "applied" }])).not.toBe(a)
    expect(authorityFactsSha256("j-1", "division", [{ ...T1, treatingJudgmentBench: null }])).not.toBe(a)
    expect(authorityFactsSha256("j-1", "division", [{ ...T1, recordedTreatingBench: "division" }])).not.toBe(a)
    expect(authorityFactsSha256("j-1", "division", [T1, T1])).not.toBe(a)
    expect(authorityFactsSha256("j-1", "division", [])).not.toBe(a)
  })
})

describe("F34 R11: the export state machine", () => {
  const NOW = Date.parse("2026-10-11T10:00:00.000Z")

  it("starts from the call's own export", () => {
    expect(exportAfterCall("exported", NOW)).toEqual({ state: "exported", attempts: 1, exportedAtMs: NOW })
    expect(exportAfterCall("disabled", NOW)).toEqual({ state: "disabled", attempts: 0 })
    expect(exportAfterCall("failed", NOW)).toEqual({ state: "pending", attempts: 1, lastCode: "export_failed", nextAttemptAtMs: NOW + TRACE_EXPORT_BACKOFF_MS })
  })

  it("backs off 5, 10, 20, 40 minutes and gives up at the fifth attempt", () => {
    expect(TRACE_EXPORT_MAX_ATTEMPTS).toBe(5)
    expect(TRACE_EXPORT_BACKOFF_MS).toBe(5 * 60_000)
    const delays: number[] = []
    let attempts = 1
    for (;;) {
      const next = nextExport({ attempts }, "failed", NOW)
      attempts = next.attempts
      if (next.state === "failed") {
        expect(next).toEqual({ state: "failed", attempts: 5, lastCode: "export_failed", abandonedAtMs: NOW })
        break
      }
      expect(next.state).toBe("pending")
      delays.push(next.nextAttemptAtMs! - NOW)
    }
    expect(delays).toEqual([10, 20, 40].map((m) => m * 60_000))
    expect(exportAfterCall("failed", NOW).nextAttemptAtMs! - NOW).toBe(5 * 60_000)
  })

  it("records a success with its attempt count, and tracing turned off as a failed attempt with its own code", () => {
    expect(nextExport({ attempts: 2 }, "exported", NOW)).toEqual({ state: "exported", attempts: 3, exportedAtMs: NOW })
    expect(nextExport({ attempts: 1 }, "disabled", NOW)).toEqual({ state: "pending", attempts: 2, lastCode: "export_disabled", nextAttemptAtMs: NOW + 10 * 60_000 })
    expect(nextExport({ attempts: 4 }, "disabled", NOW)).toEqual({ state: "failed", attempts: 5, lastCode: "export_disabled", abandonedAtMs: NOW })
  })

  it("treats an unreadable attempt count as zero and never exceeds the maximum", () => {
    expect(nextExport({ attempts: Number.NaN }, "failed", NOW)).toMatchObject({ state: "pending", attempts: 1 })
    expect(nextExport({ attempts: -3 }, "failed", NOW)).toMatchObject({ state: "pending", attempts: 1 })
    expect(nextExport({ attempts: 9 }, "failed", NOW)).toMatchObject({ state: "failed", attempts: 10 })
  })
})

describe("F34 R10: what a trace may carry", () => {
  it("text only at ranks 0 and 1", () => {
    expect(TRACE_TEXT_MAX_RANK).toBe(1)
    for (const c of ["public", "internal"] as const) {
      const t = buildTrace(record({ classification: c }), "p")
      expect(t.input, c).toEqual({ prompt: "MASKED BODY" })
      expect(t.output, c).toEqual({ text: "MASKED RESPONSE" })
    }
    for (const c of ["confidential", "privileged", "privileged-restricted"] as const) {
      const t = buildTrace(record({ classification: c }), "p")
      expect("input" in t, c).toBe(false)
      expect("output" in t, c).toBe(false)
      expect(JSON.stringify(t), c).not.toContain("MASKED")
    }
  })

  it("ids in the metadata at every rank; the prompt hash only where the text may ride (re-audit R1-001, R15)", () => {
    for (const c of ["public", "internal", "confidential", "privileged", "privileged-restricted"] as const) {
      expect(buildTrace(record({ classification: c }), "p").metadata, c).toMatchObject({
        promptTemplateId: "committee-brain",
        promptTemplateVersion: SYSTEM_POLICY_VERSION,
        modelReported: "claude-opus-5.5",
        decisionRecordVersion: "f34.3",
        usageLogId: "usage-1",
      })
    }
    for (const c of ["public", "internal"] as const) expect(buildTrace(record({ classification: c }), "p").metadata, c).toMatchObject({ promptHash: "a".repeat(64) })
    for (const c of ["confidential", "privileged", "privileged-restricted"] as const) {
      const t = buildTrace(record({ classification: c }), "p")
      expect(t.metadata, c).not.toHaveProperty("promptHash")
      expect(JSON.stringify(t), c).not.toContain("a".repeat(64))
    }
  })

  it("no prompt hash on a blocked call at any rank, and none on a failed or reconciled call above rank 1 (R15)", () => {
    for (const c of ["public", "internal", "privileged"] as const) {
      expect(buildTrace(record({ classification: c, outcome: "blocked", blockReason: "not_minimised", maskedResponse: null }), "p").metadata, c).not.toHaveProperty("promptHash")
    }
    expect(buildTrace(record({ classification: "internal", outcome: "failed" }), "p").metadata).toMatchObject({ promptHash: "a".repeat(64) })
    expect(buildTrace(record({ classification: "internal", outcome: "reconciled" }), "p").metadata).toMatchObject({ promptHash: "a".repeat(64) })
    for (const outcome of ["failed", "reconciled"] as const) expect(buildTrace(record({ classification: "confidential", outcome }), "p").metadata, outcome).not.toHaveProperty("promptHash")
  })

  it("the provider's model name is exported only when it is the configured model or its alias, as F17's modelMatches reads it (R1-005, R19)", () => {
    const cases: [string, string | null, string | null][] = [
      ["anthropic/claude-opus-5.5", "claude-opus-5.5", "claude-opus-5.5"],
      ["anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5"],
      ["anthropic/claude-opus-5.5", "zanzibar-quokka-restricted-strategy", "unrecognised"],
      ["anthropic/claude-opus-5.5", "claude-opus-5.4", "unrecognised"],
      ["anthropic/claude-opus-5.5", "opus-5.5", "unrecognised"],
      // Round 2 (FA-F34-R2-005, auditor mutant X25): a report that only starts with the configured id, or with its alias,
      // or that the configured id only starts with, is not recognised.
      ["anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5-zanzibar", "unrecognised"],
      ["anthropic/claude-opus-5.5", "claude-opus-5.5-zanzibar", "unrecognised"],
      ["anthropic/claude-opus-5.5", "anthropic/claude-opus-5", "unrecognised"],
      ["anthropic/claude-opus-5.5", "claude-opus-5", "unrecognised"],
      ["anthropic/claude-opus-5.5", null, null],
      ["openai/text-embedding-3-small", "text-embedding-3-small", "text-embedding-3-small"],
    ]
    for (const [model, reported, exported] of cases) {
      expect(buildTrace(record({ model, modelReported: reported }), "p").metadata, `${model} / ${String(reported)}`).toMatchObject({ modelReported: exported })
      expect(exported !== null && exported !== "unrecognised", `${model} / ${String(reported)}`).toBe(modelMatches(model, reported))
    }
    expect(buildTrace(record({ modelReported: undefined }), "p").metadata).not.toHaveProperty("modelReported")
  })
})

describe("F34 R1-009 (R23): Opik turned off is told apart from Opik misconfigured", () => {
  it("records the reason a disabled export was disabled", () => {
    expect(exportAfterCall("disabled", 0, "unset")).toEqual({ state: "disabled", attempts: 0, disabledReason: "unset" })
    expect(exportFields(exportAfterCall("disabled", 0, "invalid_url"))).toEqual({ state: "disabled", attempts: 0, disabledReason: "invalid_url" })
    expect(exportAfterCall("exported", 7, "unset")).toEqual({ state: "exported", attempts: 1, exportedAtMs: 7 })
    expect(exportAfterCall("failed", 7, "unset")).not.toHaveProperty("disabledReason")
  })

  it.each([
    ["unset", {}, null],
    ["invalid_url", { OPIK_BASE_URL: "http://opik.example.com" }, "invalid_url"],
    ["unconfirmed", { OPIK_BASE_URL: "https://opik.example.com" }, "unconfirmed"],
    ["third_party_host", { OPIK_BASE_URL: "https://www.comet.com/opik/api", OPIK_SELF_HOSTED_CONFIRMED: "true" }, "third_party_host"],
  ] as const)("an export under a config that is %s logs the misconfiguration at ERROR when the URL is set, never the URL", async (_name, env, reason) => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined)
    try {
      const cfg = opikConfig(env as NodeJS.ProcessEnv)
      expect(cfg.enabled).toBe(false)
      expect(await exportTrace(record(), cfg)).toBe("disabled")
      const lines = error.mock.calls.filter((c) => c[0] === "p1.opik_misconfigured")
      expect(lines).toEqual(reason === null ? [] : [["p1.opik_misconfigured", { reason }]])
      expect(JSON.stringify(error.mock.calls)).not.toContain("example.com")
      expect(JSON.stringify(error.mock.calls)).not.toContain("comet")
    } finally {
      error.mockRestore()
    }
  })
})

describe("F34 R1-011 (R25): the mask policy version", () => {
  // A golden set: if what the mask redacts changes, these outputs change, and MASK_POLICY_VERSION must be bumped with them.
  it("is f34.1, and the mask still gives the outputs that version named", () => {
    expect(MASK_POLICY_VERSION).toBe("f34.1")
    // Round 2 (FA-F34-R2-006, spec R39): one golden entry per RedactionKind at least, each tagged with the kinds it shows
    // and checked against the redaction counts, so a kind the set misses (iban, ntn and passport were) fails below.
    const golden: [RedactionKind[], string, string[], string][] = [
      [["cnic"], "CNIC 35202-1234567-1 on file.", [], "CNIC [CNIC] on file."],
      [["phone", "email"], "Call 0300-1234567 or write to a.b@example.com.", [], "Call [PHONE] or write to [EMAIL]."],
      [["party"], "Tariq Zarvani asks about bail.", ["Tariq Zarvani"], "[PARTY] asks about bail."],
      [["iban"], "Pay into IBAN PK36 SCBL 0000 0011 2345 6702 today.", [], "Pay into IBAN [IBAN] today."],
      [["ntn"], "Tax: NTN No. 1234567-8 issued.", [], "Tax: [NTN] issued."],
      [["passport"], "Passport No. AB1234567 issued.", [], "[PASSPORT] issued."],
      [[], "Draft a reply to the notice.", [], "Draft a reply to the notice."],
    ]
    for (const [kinds, text, partyNames, masked] of golden) {
      const result = maskOutboundPII(text, { partyNames })
      expect(result.masked, text).toBe(masked)
      expect(result.redactions.filter((r) => r.count > 0).map((r) => r.kind).sort(), text).toEqual([...kinds].sort())
    }
    expect([...new Set(golden.flatMap(([kinds]) => kinds))].sort()).toEqual([...REDACTION_KINDS].sort())
    expect(REDACTION_KINDS).toEqual(["cnic", "phone", "party", "email", "iban", "ntn", "passport"])
  })
})

const RECONCILED_RECORD = { firmId: "firm-1", monthKey: "2026-10", model: "openai/text-embedding-3-small", outcome: "reconciled", taskType: "embedding" }

describe("F34 R1-007 and R16: the lease reconciler's record", () => {
  const seed = {
    recordVersion: "f34.2",
    operationId: null,
    startedAtMs: 1,
    prompt: { templateId: null, hash: "b".repeat(64), hashAlgorithm: "sha256/p1-embedding-input-v1", messageCount: 1 },
    model: { configured: "openai/text-embedding-3-small", provider: "ai-gateway", transport: "ai-gateway-embeddings", gatewayVersion: "f34.1" },
    retrieval: { context: { state: "none", anchors: [] } },
    decisions: { killSwitch: { platform: "clear", firm: "clear" }, budget: { firstLook: "fits", reservation: "reserved" }, attemptRecord: "not_attempted" },
    phases: { firstReadsMs: 1, maskMs: 1 },
  }

  it("says the attempt was recorded and that its other verdicts are the seed's (R21)", () => {
    const d = reconciledDecision({ usageLogId: "u-1", traceId: "t-1", seed, attempt: { outcome: "returned", transportMs: 5 }, record: RECONCILED_RECORD, nowMs: 9, tracing: false })
    expect(d.decisions).toEqual({ ...seed.decisions, attemptRecord: "recorded", fromSeed: true })
    expect(d.prompt).toEqual(seed.prompt)
    expect(d.export).toEqual({ state: "disabled", attempts: 0 })
  })

  // Round 2 (FA-F34-R2-005, auditor mutant X14): with no provider attempt on the reservation, the record keeps the seed's
  // attemptRecord; it never says "recorded".
  it("keeps the seed's attemptRecord when the reservation holds no provider attempt (R21)", () => {
    const d = reconciledDecision({ usageLogId: "u-1", traceId: "t-1", seed, attempt: null, record: RECONCILED_RECORD, nowMs: 9, tracing: false })
    expect(d.decisions).toEqual({ ...seed.decisions, attemptRecord: "not_attempted", fromSeed: true })
    expect((d.decisions as Record<string, unknown>).attemptRecord).not.toBe("recorded")
    expect((d.phases as Record<string, unknown>).transportMs).toBeNull()
  })

  // PR #132 review, Codex P1 (spec R42): a seed whose hash was withheld gives a record that says so, and the
  // reconstruction reads it as not checkable, never as a mismatch.
  it("a seed whose hash was withheld gives a record with the hash withheld, which the join reads as not checkable (R42)", () => {
    const withheldSeed = { ...seed, prompt: { ...seed.prompt, hash: null, hashWithheld: "no_output_row" } }
    const d = reconciledDecision({ usageLogId: "u-1", traceId: "t-1", seed: withheldSeed, attempt: { outcome: "returned" }, record: RECONCILED_RECORD, nowMs: 9, tracing: false })
    expect(d.prompt).toEqual({ ...seed.prompt, hash: null, hashWithheld: "no_output_row" })
    const joined = joinDecision({
      usageLogId: "u-1",
      decision: d,
      usage: null,
      reservation: { traceId: "t-1", state: "settled", decisionSeed: withheldSeed },
      output: { id: "o-1", usageLogId: "u-1", traceId: "t-1", outbound: { body: "Draft a reply.", system: { policyId: "committee-brain", version: SYSTEM_POLICY_VERSION } } },
      eventNames: [],
    })
    expect(joined.checks.promptHashMatchesOutput).toBeNull()
    expect(JSON.stringify(joined)).not.toContain("b".repeat(64))
  })

  it("carries the embedding's caller and corpus operation, and the reason tracing was off (R16, R23)", () => {
    const d = reconciledDecision({
      usageLogId: "u-1",
      traceId: "t-1",
      seed,
      attempt: { outcome: "pending" },
      record: { ...RECONCILED_RECORD, caller: "corpus@example.iam.gserviceaccount.com", corpusOperationId: "c".repeat(64) },
      nowMs: 9,
      tracing: false,
      disabledReason: "unset",
    })
    expect(d).toMatchObject({ caller: "corpus@example.iam.gserviceaccount.com", corpusOperationId: "c".repeat(64), recordVersion: "f34.3", export: { state: "disabled", disabledReason: "unset" } })
    const chat = reconciledDecision({ usageLogId: "u-2", traceId: "t-2", seed, attempt: {}, record: { ...RECONCILED_RECORD, taskType: "committee" }, nowMs: 9, tracing: true })
    expect(chat).not.toHaveProperty("caller")
    expect(chat).not.toHaveProperty("corpusOperationId")
  })
})

describe("F34 R13: the reconstruction join", () => {
  const TEMPLATE_SHA = PROMPT_TEMPLATE_PINS[`committee-brain@${SYSTEM_POLICY_VERSION}`]!
  const BODY = "Draft a reply to the notice."
  const parts = (over: Partial<DecisionParts> = {}): DecisionParts => ({
    usageLogId: "u-1",
    decision: {
      traceId: "t-1",
      usageLogId: "u-1",
      prompt: { templateId: "committee-brain", templateVersion: SYSTEM_POLICY_VERSION, templateSha256: TEMPLATE_SHA, hash: promptHash(MESSAGES) },
      export: { state: "exported", attempts: 1 },
    },
    usage: { trace: { id: "t-1", status: "exported" }, costMicroUsd: 24 },
    reservation: { traceId: "t-1", state: "settled" },
    output: { id: "o-1", usageLogId: "u-1", traceId: "t-1", text: "SECRET ANSWER", outbound: { body: BODY, system: { policyId: "committee-brain", version: SYSTEM_POLICY_VERSION } }, grounding: { status: "grounded" }, advisory: false },
    eventNames: ["ai.call.completed"],
    ...over,
  })

  it("joins every record and checks the template pin and the prompt hash against the stored output", () => {
    const r = joinDecision(parts())
    expect(r.key).toEqual({ usageLogId: "u-1", traceId: "t-1" })
    expect(r.checks).toEqual({ decisionPresent: true, usageJoined: true, reservationJoined: true, outputJoined: true, templatePinned: true, promptHashMatchesOutput: true, exportState: "exported" })
    expect(r.output).toEqual({ outputId: "o-1", groundingStatus: "grounded", advisory: false, system: { policyId: "committee-brain", version: SYSTEM_POLICY_VERSION } })
    expect(JSON.stringify(r)).not.toContain("SECRET ANSWER")
    expect(JSON.stringify(r)).not.toContain(BODY)
  })

  // Round 2 (FA-F34-R2-003, spec R37): a hash the export reconciler withheld cannot be checked, which is not a mismatch.
  it("reads a withheld hash as not checkable (null), never as a mismatch (R37)", () => {
    const base = parts()
    const withheld = { ...base.decision!, prompt: { ...base.decision!.prompt, hash: null, hashWithheld: "no_output_row" } }
    expect(joinDecision({ ...base, decision: withheld }).checks.promptHashMatchesOutput).toBeNull()
    expect(joinDecision({ ...base, decision: { ...withheld, prompt: { ...withheld.prompt, hashWithheld: undefined } } }).checks.promptHashMatchesOutput).toBe(false)
  })

  it("flags a stored body that does not hash to the record, a template hash that is not the pin, and records that do not join", () => {
    const base = parts()
    expect(joinDecision({ ...base, output: { ...base.output!, outbound: { body: `${BODY}!`, system: base.output!.outbound.system } } }).checks.promptHashMatchesOutput).toBe(false)
    expect(joinDecision({ ...base, decision: { ...base.decision!, prompt: { ...base.decision!.prompt, templateSha256: "0".repeat(64) } } }).checks.templatePinned).toBe(false)
    expect(joinDecision({ ...base, usage: { trace: { id: "t-2" } } }).checks.usageJoined).toBe(false)
    expect(joinDecision({ ...base, reservation: { traceId: "t-2" } }).checks.reservationJoined).toBe(false)
    expect(joinDecision({ ...base, output: { ...base.output!, usageLogId: "u-2" } }).checks).toMatchObject({ outputJoined: false, promptHashMatchesOutput: null })
    expect(joinDecision({ ...base, output: null }).checks).toMatchObject({ outputJoined: false, promptHashMatchesOutput: null })
    expect(joinDecision({ ...base, decision: null }).checks).toMatchObject({ decisionPresent: false, templatePinned: false, promptHashMatchesOutput: null, exportState: null })
  })
})

describe("F34 R2-003 (R37): when a prompt hash with no output row is withheld", () => {
  it("is the idempotency marker's TTL after the call started, so the masked body is gone from the marker too", () => {
    expect(PROMPT_HASH_WITHHOLD_AFTER_MS).toBe(IDEMPOTENCY_TTL_MS)
    expect(HASH_WITHHELD_NO_OUTPUT_ROW).toBe("no_output_row")
  })

  it("the publication removes the time: the output row then stores the masked body beside the hash", () => {
    const fields = publicationFields({ usageLogId: "u-1", traceId: "t-1", firmId: "firm-1", outputId: "o-1", advisory: false, grounding: { status: "grounded", rules: "r", omitted: 0 }, anchors: [] })
    const prompt = fields.prompt as Record<string, unknown>
    expect(Object.keys(prompt)).toEqual(["hashWithholdAtMs"])
    expect((prompt.hashWithholdAtMs as FieldValue).isEqual(FieldValue.delete())).toBe(true)
  })
})
