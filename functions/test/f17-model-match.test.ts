import { describe, expect, it } from "vitest"
import { modelMatches } from "../src/p1/ops"

/**
 * Audit F17 re-audit L4 (ruling 4): `modelMatch` is the configured model id, or the same id without its `provider/`
 * prefix, exactly. A reported id that only starts or ends with it, or carries another provider, is not a match.
 */
describe("audit F17 re-audit L4: modelMatch refuses prefix and suffix abuse", () => {
  const OPUS = "anthropic/claude-opus-5.5"

  it.each([OPUS, "claude-opus-5.5"])("matches %s", (reported) => {
    expect(modelMatches(OPUS, reported)).toBe(true)
  })

  it.each([
    "claude-opus-5.5-evil",
    "xclaude-opus-5.5",
    "anthropic/claude-opus-5.5-evil",
    "xanthropic/claude-opus-5.5",
    "evil/claude-opus-5.5",
    "anthropic/claude-opus-5.5/extra",
    "Anthropic/Claude-Opus-5.5",
    "claude-opus-5",
    "opus-5.5",
    "anthropic/",
    "/claude-opus-5.5",
    "",
  ])("does not match %j", (reported) => {
    expect(modelMatches(OPUS, reported)).toBe(false)
  })

  it("does not match when no model was reported", () => {
    expect(modelMatches(OPUS, null)).toBe(false)
  })

  it("a configured id without a provider matches only itself", () => {
    expect(modelMatches("claude-opus-5.5", "claude-opus-5.5")).toBe(true)
    expect(modelMatches("claude-opus-5.5", "anthropic/claude-opus-5.5")).toBe(false)
  })
})
