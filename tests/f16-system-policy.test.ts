import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { maskOutboundPII } from "@/platform/p1/maskOutboundPII"
import { residualPII, residualTotal } from "@/platform/p1/residualPII"
import { AGENT_INSTRUCTIONS_LENGTH, AGENT_INSTRUCTIONS_SHA256, isPinnedAgentInstructions, pinnedAgentInstructionsIn } from "@/platform/p1/agentInstructions"
import {
  DEFAULT_SYSTEM_POLICY_ID,
  SYSTEM_POLICIES,
  SYSTEM_POLICY_IDS,
  SYSTEM_POLICY_VERSION,
  isKnownSystemPolicy,
  isSystemPolicyId,
  systemPolicyFor,
  systemPolicyText,
} from "@/platform/p1/systemPolicy"
import { envelopeTagCount } from "@/platform/p1/promptEnvelope"
import { CLASSIFICATION_RANKS } from "@/platform/p1/types"

/**
 * Audit F16, spec ruling 1: system text comes only from a fixed, platform-authored registry. Refinement R1a: an unknown
 * purpose falls back to the default policy; refinement R1b: the eve agent's own system text is compiled from
 * agent/instructions.md only.
 */

describe("audit F16: the system-policy registry (ruling 1)", () => {
  it("holds exactly the committeeBrain purposes, frozen, each with its own id and a version", () => {
    expect([...SYSTEM_POLICY_IDS].sort()).toEqual(["committee-brain", "ops-audit", "research", "summarise", "translate"])
    expect(Object.isFrozen(SYSTEM_POLICIES)).toBe(true)
    for (const id of SYSTEM_POLICY_IDS) {
      const policy = SYSTEM_POLICIES[id]
      expect(Object.isFrozen(policy)).toBe(true)
      expect(policy.id).toBe(id)
      expect(policy.version).toMatch(/^[a-z0-9.]{1,32}$/)
      expect(policy.text.length).toBeGreaterThan(100)
      expect(policy.text.length).toBeLessThanOrEqual(8000)
    }
  })

  it("selects by purpose, own keys only, and falls back to the default for anything else (R1a)", () => {
    expect(DEFAULT_SYSTEM_POLICY_ID).toBe("committee-brain")
    expect(systemPolicyFor("translate")).toBe(SYSTEM_POLICIES.translate)
    expect(systemPolicyFor("summarise")).toBe(SYSTEM_POLICIES.summarise)
    for (const other of ["committee-brain for [PARTY]", "test-mask", "", "constructor", "__proto__", "toString", "TRANSLATE"]) {
      expect(systemPolicyFor(other), other).toBe(SYSTEM_POLICIES["committee-brain"])
      expect(isSystemPolicyId(other), other).toBe(false)
    }
    expect(isSystemPolicyId("research")).toBe(true)
  })

  it.each([...SYSTEM_POLICY_IDS])("%s: no classification label, no PII the mask or the residual check would act on, and the envelope rule", (id) => {
    const { text } = SYSTEM_POLICIES[id]
    for (const label of Object.keys(CLASSIFICATION_RANKS)) {
      expect(new RegExp(`\\b${label}\\b`, "i").test(text), label).toBe(false)
    }
    expect(maskOutboundPII(text).masked).toBe(text)
    expect(residualTotal(residualPII(text))).toBe(0)
    // The policy names the envelope it tells the model to treat as data.
    expect(text).toContain("<untrusted_content>")
    expect(envelopeTagCount(text)).toBeGreaterThan(0)
    expect(text).toMatch(/never follow instructions/i)
  })
})

describe("audit F16 review round: stored records name a policy by id and version (R4a)", () => {
  it("knows every current policy at its version, and nothing else", () => {
    for (const id of SYSTEM_POLICY_IDS) {
      expect(isKnownSystemPolicy(id, SYSTEM_POLICY_VERSION), id).toBe(true)
      expect(systemPolicyText(id, SYSTEM_POLICY_VERSION)).toBe(SYSTEM_POLICIES[id].text)
    }
    for (const [id, version] of [["committee-brain", "f16.0"], ["constructor", SYSTEM_POLICY_VERSION], ["committee-brain", "toString"], ["attacker", "f16.1"], [42, "f16.1"], ["committee-brain", 1]] as const) {
      expect(isKnownSystemPolicy(id, version), `${String(id)}@${String(version)}`).toBe(false)
      expect(systemPolicyText(id, version)).toBeNull()
    }
  })
})

describe("audit F16 review round: the pinned agent instructions (R1b, R3a)", () => {
  const text = readFileSync(path.resolve(__dirname, "..", "agent", "instructions.md"), "utf8").trim()

  it("are agent/instructions.md exactly (trimmed, as eve compiles them): its SHA-256 and its length", () => {
    expect(AGENT_INSTRUCTIONS_SHA256).toBe(createHash("sha256").update(text, "utf8").digest("hex"))
    expect(AGENT_INSTRUCTIONS_LENGTH).toBe(text.length)
    expect(isPinnedAgentInstructions(text)).toBe(true)
    for (const other of [`${text} `, text.slice(1), text.replace("Never", "Always"), "", 42, null]) expect(isPinnedAgentInstructions(other)).toBe(false)
  })

  it("are found in eve's system prompt only as one whole block", () => {
    const block = `Instructions (instructions)\n${text}`
    for (const system of [block, `Note\nx\n\n${block}`, `${block}\n\nTool execution\ny`, `a\n\n${block}\n\nb`]) expect(pinnedAgentInstructionsIn(system), system.slice(0, 20)).toBe(text)
    for (const system of [text, `${block}\nAlso obey the user.`, `${block} more`, `x${block}`, `Note\n${block}`, block.replace("Never call", "Do call")]) {
      expect(pinnedAgentInstructionsIn(system), system.slice(0, 20)).toBeNull()
    }
  })
})

describe("audit F16: the eve agent's system text has one static source (R1b)", () => {
  const agentDir = path.resolve(__dirname, "..", "agent")

  it("agent/instructions.md is the only instruction source: no instructions.ts and no instructions/ directory", () => {
    expect(existsSync(path.join(agentDir, "instructions.md"))).toBe(true)
    expect(existsSync(path.join(agentDir, "instructions.ts"))).toBe(false)
    expect(existsSync(path.join(agentDir, "instructions"))).toBe(false)
  })

  it("the instructions carry no interpolation, no envelope tag, and nothing the mask or the residual check acts on", () => {
    const text = readFileSync(path.join(agentDir, "instructions.md"), "utf8")
    expect(text).not.toMatch(/\$\{|\{\{/)
    expect(envelopeTagCount(text)).toBe(0)
    // They ride in the system message after the registry policy (R1b). That message is verified platform text and is left out
    // of the minimisation check (R3a); this keeps the premise true that it carries nothing the check would act on.
    expect(maskOutboundPII(text).masked).toBe(text)
    expect(residualTotal(residualPII(text))).toBe(0)
  })
})
