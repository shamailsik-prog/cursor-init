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
    const actionButtons = source.match(/<Button\s+className="[^"]*"\s+disabled=\{busy\}/g) ?? []
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
})
