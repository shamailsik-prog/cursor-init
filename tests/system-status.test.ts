import { describe, expect, it } from "vitest"
import { buildSystemStatus, formatDuration } from "@/lib/system-status"

describe("system monitor", () => {
  it("reports Phase 0 location, last gate timings, and current processing", () => {
    const status = buildSystemStatus(new Date("2026-09-15T23:58:00.000Z"))

    expect(status.location.phase).toBe("Phase 0 foundations")
    expect(status.location.firm).toBe("NHS Legal, Karachi")
    expect(status.location.layers316).toBe("not started")
    expect(status.location.gateG0).toBe("PASS")
    expect(status.location.gateG1).toBe("PASS")
    expect(status.inventory.documentTypes).toBe(159)
    expect(status.inventory.openItems).toBe(6)
    expect(status.processingNow).toMatch(/running|waiting/)
    expect(status.processing.some((item) => item.state === "running")).toBe(
      true
    )
    expect(status.timings.map((item) => item.id)).toEqual(["g0", "g1", "unit"])
    expect(status.backends.every((item) => item.state === "not_connected")).toBe(
      true
    )
    expect(status.generatedAt).toBe("2026-09-15T23:58:00.000Z")
  })

  it("formats elapsed time for the Update view", () => {
    expect(formatDuration(null)).toBe("—")
    expect(formatDuration(644)).toBe("644 ms")
    expect(formatDuration(2856)).toBe("2.9 s")
    expect(formatDuration(95_000)).toBe("1m 35s")
  })
})
