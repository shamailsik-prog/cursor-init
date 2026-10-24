import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { PROMPT_TEMPLATE_PINS, promptTemplateOf } from "@/platform/p1/promptTemplates"
import { SYSTEM_POLICIES, SYSTEM_POLICY_IDS, SYSTEM_POLICY_VERSION, systemPolicyText } from "@/platform/p1/systemPolicy"

/**
 * Audit F34, spec ruling R3: a template's text cannot change without its version changing. Every registry entry
 * (`id@version`, the current version and every earlier one kept in the history) has a pinned SHA-256, and the registry
 * text must hash to it. The table below is a second, literal copy of `PROMPT_TEMPLATE_PINS`: editing a released text
 * means rewriting a pin in both places, which review sees; bumping the version means adding new pins, which this test
 * requires. Computed on main f39d007.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

const PINNED: Readonly<Record<string, string>> = {
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
}

describe("audit F34 R3: the template pin table", () => {
  const registry = SYSTEM_POLICY_IDS.flatMap((id) => [SYSTEM_POLICY_VERSION, "f16.1"].map((version) => `${id}@${version}`)).sort()

  it("pins every registry entry, current and historical, and nothing else", () => {
    expect(Object.keys(PROMPT_TEMPLATE_PINS).sort()).toEqual(registry)
    expect(Object.keys(PINNED).sort()).toEqual(registry)
  })

  it("every registry text hashes to its pin, in both copies of the table", () => {
    for (const key of registry) {
      const [id, version] = key.split("@") as [string, string]
      const hash = sha256(systemPolicyText(id, version)!)
      expect(PROMPT_TEMPLATE_PINS[key], key).toBe(hash)
      expect(PINNED[key], key).toBe(hash)
    }
  })

  it("a text changed without a version bump no longer names a template", () => {
    const edited = { ...PROMPT_TEMPLATE_PINS, [`committee-brain@${SYSTEM_POLICY_VERSION}`]: sha256(`${SYSTEM_POLICIES["committee-brain"].text}\n`) }
    expect(promptTemplateOf({ policyId: "committee-brain", version: SYSTEM_POLICY_VERSION }, edited)).toBeNull()
    expect(promptTemplateOf({ policyId: "committee-brain", version: SYSTEM_POLICY_VERSION })).not.toBeNull()
  })

  it("the pin table cannot be changed at run time", () => {
    expect(Object.isFrozen(PROMPT_TEMPLATE_PINS)).toBe(true)
  })
})
