import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { AGENT_INSTRUCTIONS_SHA256 } from "@/platform/p1/agentInstructions"
import { PROMPT_HASH_ALGORITHM, PROMPT_TEMPLATE_PINS, promptHash, promptTemplateOf } from "@/platform/p1/promptTemplates"
import { SYSTEM_POLICIES, SYSTEM_POLICY_IDS, SYSTEM_POLICY_VERSION, systemPolicyText } from "@/platform/p1/systemPolicy"
import {
  TRACE_EXPORT_BACKOFF_MS,
  TRACE_EXPORT_MAX_ATTEMPTS,
  authorityFactsSha256,
  exportAfterCall,
  joinDecision,
  nextExport,
  type DecisionParts,
} from "../src/p1/decisionRecord"
import { TRACE_TEXT_MAX_RANK, buildTrace, type TraceRecord } from "../src/p1/opik"

/**
 * Audit F34 units (spec docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md): the prompt hash
 * and the template pin (R3), the authority facts hash (R5), the export state machine (R11), the trace content rule (R10)
 * and the reconstruction join (R13). Pure: no emulator.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
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

  it("ids and hashes in the metadata at every rank", () => {
    for (const c of ["internal", "privileged-restricted"] as const) {
      expect(buildTrace(record({ classification: c }), "p").metadata, c).toMatchObject({
        promptHash: "a".repeat(64),
        promptTemplateId: "committee-brain",
        promptTemplateVersion: SYSTEM_POLICY_VERSION,
        modelReported: "claude-opus-5.5",
        decisionRecordVersion: "f34.1",
      })
    }
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
