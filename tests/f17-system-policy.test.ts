import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { SYSTEM_POLICIES, SYSTEM_POLICY_IDS, SYSTEM_POLICY_VERSION, isKnownSystemPolicy, systemPolicyText } from "@/platform/p1/systemPolicy"

/**
 * Audit F17, spec ruling 1 and refinement R1a: the committee-brain policy asks for the structured answer contract,
 * under a new registry version `f17.1` that is now current. No existing version's text is edited: the `f16.1` texts
 * stay in the registry's history byte for byte (their SHA-256 values below were computed on main b48f79d), so every
 * stored `{ policyId, version }` record still resolves to what was sent.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

/** The f16.1 texts as shipped (main b48f79d). */
const F16_1: Readonly<Record<string, string>> = {
  "committee-brain": "f92d9956aaab36f386802f25e133ed03fcd212ecbd6b40fb738e82018a249ef3",
  summarise: "a42ca346f176befc5c3bebf53f999912229a3e9689a699cfa8c837d41b1385ed",
  research: "bbcc04d0717726122f8ef7259b22f3f765c03e1db8e7753eb7b60bb60b8f45bc",
  translate: "6d871584988fca8c0fdb17f50c0180d5df1800c534b2fb23ebffeb2023d3d279",
  "ops-audit": "8ebfb430733e62f284300fd7b62615d40befe48ec619fc0d187a9d3dd4f4219b",
}

describe("audit F17: registry version f17.1 (spec ruling 1, R1a)", () => {
  it("f17.1 is current, for every policy", () => {
    expect(SYSTEM_POLICY_VERSION).toBe("f17.1")
    for (const id of SYSTEM_POLICY_IDS) expect(SYSTEM_POLICIES[id].version, id).toBe("f17.1")
  })

  it("every f16.1 text is still in the registry, unchanged", () => {
    for (const id of SYSTEM_POLICY_IDS) {
      expect(isKnownSystemPolicy(id, "f16.1"), id).toBe(true)
      expect(sha256(systemPolicyText(id, "f16.1") ?? ""), id).toBe(F16_1[id])
    }
  })

  it("only the committee-brain text changed; the four others are re-issued as they were", () => {
    expect(sha256(SYSTEM_POLICIES["committee-brain"].text)).not.toBe(F16_1["committee-brain"])
    for (const id of SYSTEM_POLICY_IDS.filter((p) => p !== "committee-brain")) {
      expect(SYSTEM_POLICIES[id].text, id).toBe(systemPolicyText(id, "f16.1"))
    }
  })

  it("the committee-brain text keeps its remit and asks for one JSON object of the contract's shape and nothing else", () => {
    const text = SYSTEM_POLICIES["committee-brain"].text
    expect(text.startsWith("You are a legal assistant to the lawyers of a law firm.")).toBe(true)
    for (const phrase of [
      "Reply with one JSON object and nothing else",
      "no code fence",
      '"kind" is "judgment", "statute", "rule" or "other"',
      "Never invent a citation",
      "Never state that an authority has been verified",
      "no backslash-u escapes",
    ]) {
      expect(text, phrase).toContain(phrase)
    }
  })

  it("the shape the policy shows is itself accepted by the contract", async () => {
    const { parseCommitteeAnswer } = await import("@/platform/p1/committeeAnswer")
    const shape = SYSTEM_POLICIES["committee-brain"].text.split("\n").find((line) => line.startsWith('{"sections"'))
    expect(shape, "the shape line").toBeDefined()
    expect(parseCommitteeAnswer(shape!).ok).toBe(true)
  })
})
