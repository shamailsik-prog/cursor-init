/**
 * The prompt templates of the P1 path and their pinned hashes (audit F34; spec
 * docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md, ruling R3).
 *
 * A P1 request's template is its system message: the registry policy (platform/p1/systemPolicy.ts, by id and version)
 * and, on the eve bridge only, agent/instructions.md as pinned by its digest (platform/p1/agentInstructions.ts). The user
 * body is data, never a template. Every registry entry, the current version and every earlier one the registry keeps, has
 * its SHA-256 pinned here, keyed `id@version`, so a text changed without a version bump no longer names a template:
 * `promptTemplateOf` returns null for it and `callP1` refuses the request (`system_unverified`, nothing is sent), and
 * tests/f34-prompt-template-pins.test.ts, which holds a second literal copy of this table, fails first.
 *
 * Bumping SYSTEM_POLICY_VERSION means adding a pin for every policy at the new version; the pins of a released version
 * never change. Nothing here holds or returns a template's text.
 *
 * `promptHash` is the hash a decision record keeps of what was sent: the SHA-256 of the canonical JSON of the masked
 * messages, `[[role, content], ...]`, in order. Never the text.
 */

import { createHash } from "node:crypto"
import { AGENT_INSTRUCTIONS_SHA256 } from "@/platform/p1/agentInstructions"
import { systemPolicyText, type SystemPolicyId } from "@/platform/p1/systemPolicy"

/** The algorithm `promptHash` implements; a decision record names it beside the hash. */
export const PROMPT_HASH_ALGORITHM = "sha256/p1-messages-v1"

/** SHA-256 of each registry text, keyed `policyId@version`. Computed on main f39d007; f16.1 matches tests/f17-system-policy.test.ts. */
export const PROMPT_TEMPLATE_PINS: Readonly<Record<string, string>> = Object.freeze({
  "committee-brain@f16.1": "f92d9956aaab36f386802f25e133ed03fcd212ecbd6b40fb738e82018a249ef3",
  "summarise@f16.1": "a42ca346f176befc5c3bebf53f999912229a3e9689a699cfa8c837d41b1385ed",
  "research@f16.1": "bbcc04d0717726122f8ef7259b22f3f765c03e1db8e7753eb7b60bb60b8f45bc",
  "translate@f16.1": "6d871584988fca8c0fdb17f50c0180d5df1800c534b2fb23ebffeb2023d3d279",
  "ops-audit@f16.1": "8ebfb430733e62f284300fd7b62615d40befe48ec619fc0d187a9d3dd4f4219b",
  "committee-brain@f17.1": "ba19970fc72a1925c0bcccbce770895393fcf0e7104c1b490d751b41a25c7baf",
  "summarise@f17.1": "a42ca346f176befc5c3bebf53f999912229a3e9689a699cfa8c837d41b1385ed",
  "research@f17.1": "bbcc04d0717726122f8ef7259b22f3f765c03e1db8e7753eb7b60bb60b8f45bc",
  "translate@f17.1": "6d871584988fca8c0fdb17f50c0180d5df1800c534b2fb23ebffeb2023d3d279",
  "ops-audit@f17.1": "8ebfb430733e62f284300fd7b62615d40befe48ec619fc0d187a9d3dd4f4219b",
})

/** A registered template as a record names it: its id, its version, its pinned hash and, on the eve bridge, the instructions' digest. */
export type PromptTemplateRef = {
  templateId: SystemPolicyId
  templateVersion: string
  templateSha256: string
  agentInstructionsSha256: string | null
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

const RECORD_KEYS: ReadonlySet<string> = new Set(["policyId", "version", "agentInstructionsSha256"])

/**
 * The template a system record names (`{ policyId, version, agentInstructionsSha256? }`, outboundPrompt.ts SystemRecord),
 * when the registry knows it, its text hashes to its pin in `pins`, and any instructions digest is the pinned one; null
 * otherwise (an unknown or extra key, an unknown policy or version, an unpinned or mismatched text, another digest).
 */
export function promptTemplateOf(system: unknown, pins: Readonly<Record<string, string>> = PROMPT_TEMPLATE_PINS): PromptTemplateRef | null {
  if (system === null || typeof system !== "object" || Array.isArray(system)) return null
  const r = system as Record<string, unknown>
  if (Object.keys(r).some((key) => !RECORD_KEYS.has(key))) return null
  const text = systemPolicyText(r.policyId, r.version)
  if (text === null) return null
  const key = `${r.policyId as string}@${r.version as string}`
  if (!Object.hasOwn(pins, key) || pins[key] !== sha256Hex(text)) return null
  let agentInstructionsSha256: string | null = null
  if (Object.hasOwn(r, "agentInstructionsSha256")) {
    if (r.agentInstructionsSha256 !== AGENT_INSTRUCTIONS_SHA256) return null
    agentInstructionsSha256 = AGENT_INSTRUCTIONS_SHA256
  }
  return { templateId: r.policyId as SystemPolicyId, templateVersion: r.version as string, templateSha256: pins[key]!, agentInstructionsSha256 }
}

/** SHA-256 of the canonical JSON of the messages as sent, `[[role, content], ...]` (PROMPT_HASH_ALGORITHM). */
export function promptHash(messages: readonly { role: string; content: string }[]): string {
  return sha256Hex(JSON.stringify(messages.map((m) => [m.role, m.content])))
}
