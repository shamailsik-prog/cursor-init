import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// /design-review of /ops (2026-10-10): pins the accessibility and layout fixes so a later
// generated batch of fields or buttons cannot quietly reintroduce them.
describe("/ops design review: labels, landmark, readable actions", () => {
  const source = readFileSync("app/ops/operator-audit-console.tsx", "utf8")

  it("every fixture field caption is a <label>, never a bare <p> caption", () => {
    expect(source).not.toContain('<p className="mb-1 text-xs tracking-wide uppercase">')
    const labels = source.match(/<label className="block">/g) ?? []
    expect(labels.length).toBe(19)
  })

  it("id field labels keep their camelCase (no uppercase transform)", () => {
    for (const id of ["matterId", "documentId", "draftId", "packageId", "attestationId", "disputeId"]) {
      expect(source).toContain(`<span className="mb-1 block font-mono text-xs">${id}</span>`)
    }
  })

  it("the page content sits in a <main> landmark", () => {
    expect(source).toContain('<main className="mx-auto flex w-full max-w-6xl')
    expect(source.trimEnd().endsWith("</main>\n  )\n}")).toBe(true)
  })

  it("every audited action button wraps instead of clipping its label", () => {
    const actionButtons = source.match(/<Button\s+(?:variant="secondary"\s+)?className="[^"]*"\s+disabled=\{busy\}/g) ?? []
    expect(actionButtons.length).toBe(39)
    for (const button of actionButtons) {
      expect(button).toContain("whitespace-normal")
      expect(button).toContain("[overflow-wrap:anywhere]")
      expect(button).toContain("h-auto")
    }
  })

  it("the eyebrow uses the AA-contrast brass token and the call log stays in view", () => {
    expect(source).toContain("text-[color:var(--brass-ink)] uppercase\">Legal OS")
    expect(source).toContain('className="rounded-none lg:sticky lg:top-4 lg:self-start"')
  })

  it("audited steps run 1-39 in order with no repeated or out-of-order number", () => {
    const flow = source.slice(source.indexOf("<CardTitle>Audited flow actions</CardTitle>"), source.indexOf("<CardTitle>API call logs</CardTitle>"))
    const numbers = [...flow.matchAll(/^\s+(\d+)\) /gm)].map((m) => Number(m[1]))
    expect(numbers).toEqual(Array.from({ length: 39 }, (_, i) => i + 1))
  })

  it("steps are grouped under section headings, and read-only steps use the secondary variant", () => {
    const headings = source.match(/<h2 id="ops-steps-[a-z0-9-]+"/g) ?? []
    expect(headings.length).toBe(6)
    const sections = source.match(/<section aria-labelledby="ops-steps-[a-z0-9-]+"/g) ?? []
    expect(sections.length).toBe(6)
    const secondary = source.match(/<Button\s+variant="secondary"/g) ?? []
    expect(secondary.length).toBe(19)
  })

  it("controls are at least 44px tall on small screens and compact from md up", () => {
    const actionButtons = source.match(/<Button\s+(?:variant="secondary"\s+)?className="[^"]*"\s+disabled=\{busy\}/g) ?? []
    expect(actionButtons.length).toBe(39)
    for (const button of actionButtons) expect(button).toContain("min-h-11 w-full md:min-h-9")
    const inputs = source.match(/<Input className="[^"]*"/g) ?? []
    expect(inputs.length).toBe(17)
    for (const input of inputs) expect(input).toContain("h-11 rounded-none md:h-8")
    expect(source).toContain("inline-flex h-11 items-center justify-center rounded-none border border-border px-2.5 text-sm md:h-8")
  })
})
