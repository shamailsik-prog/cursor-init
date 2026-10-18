import { describe, expect, it } from "vitest"
import { runBackfill } from "../src/cli/jobsBackfill"
import { SCHEDULED_JOBS, periodKey, periodRange, scheduledJobFunction } from "../src/p2/scheduled"
import { T0 } from "./jobs"

describe("P2 scheduled jobs: period keys and range (P3-16)", () => {
  it("periodKey is computed in PKT", () => {
    expect(periodKey("hour", Date.parse("2026-10-08T09:30:00Z"))).toBe("2026-10-08T14")
    expect(periodKey("day", Date.parse("2026-10-08T18:59:59.999Z"))).toBe("2026-10-08")
    expect(periodKey("day", Date.parse("2026-10-08T19:00:00Z"))).toBe("2026-10-09")
    expect(periodKey("week", Date.parse("2026-10-08T09:00:00Z"))).toBe("2026-W41")
    expect(periodKey("week", Date.parse("2026-12-31T09:00:00Z"))).toBe("2026-W53")
    expect(periodKey("week", Date.parse("2027-01-03T18:59:59Z"))).toBe("2026-W53")
    expect(periodKey("week", Date.parse("2027-01-03T19:00:00Z"))).toBe("2027-W01")
    expect(periodKey("month", Date.parse("2026-10-31T18:59:59Z"))).toBe("2026-10")
    expect(periodKey("month", Date.parse("2026-10-31T19:00:00Z"))).toBe("2026-11")
  })

  it("periodRange is inclusive, crosses month and ISO-year ends, and caps at 366", () => {
    expect(periodRange("day", "2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"])
    expect(periodRange("week", "2026-W52", "2027-W02")).toEqual(["2026-W52", "2026-W53", "2027-W01", "2027-W02"])
    expect(periodRange("month", "2026-11", "2027-01")).toEqual(["2026-11", "2026-12", "2027-01"])
    expect(periodRange("day", "2026-01-01", "2027-01-01")).toHaveLength(366)
    expect(() => periodRange("day", "2026-01-01", "2027-01-02")).toThrow(/at most 366/)
    expect(() => periodRange("day", "2026-03-01", "2026-02-27")).toThrow(/from after to/)
    expect(() => periodRange("week", "2026-W54", "2026-W54")).toThrow(/invalid period key/)
  })

  it("periodRange rejects malformed and overflowing keys, and covers hours and a leap day", () => {
    expect(() => periodRange("day", "2026-02-30", "2026-03-01")).toThrow(/invalid period key/)
    expect(() => periodRange("day", "2026-2-3", "2026-03-01")).toThrow(/invalid period key/)
    expect(() => periodRange("hour", "2026-10-08T24", "2026-10-09T01")).toThrow(/invalid period key/)
    expect(() => periodRange("month", "2026-13", "2027-01")).toThrow(/invalid period key/)
    expect(() => periodRange("week", "2027-W53", "2027-W53")).toThrow(/invalid period key/)
    expect(periodRange("hour", "2026-10-08T23", "2026-10-09T01")).toEqual(["2026-10-08T23", "2026-10-09T00", "2026-10-09T01"])
    expect(periodRange("day", "2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"])
    expect(periodRange("day", "2026-10-08", "2026-10-08")).toEqual(["2026-10-08"])
  })

  it("period keys at the PKT midnight edges of a month and a year", () => {
    expect(periodKey("day", Date.parse("2026-12-31T19:00:00Z"))).toBe("2027-01-01")
    expect(periodKey("month", Date.parse("2026-12-31T18:59:59.999Z"))).toBe("2026-12")
    expect(periodKey("month", Date.parse("2026-12-31T19:00:00Z"))).toBe("2027-01")
    expect(periodKey("hour", Date.parse("2026-10-08T18:59:59.999Z"))).toBe("2026-10-08T23")
    expect(periodKey("hour", Date.parse("2026-10-08T19:00:00Z"))).toBe("2026-10-09T00")
  })

  it("the backfill CLI refuses a type with no schedule", async () => {
    const lines: string[] = []
    const deps = { schedules: [], now: () => T0, out: (l: string) => void lines.push(l) }
    expect(await runBackfill(["platform.diagnostic", "2026-10-01", "2026-10-02"], deps)).toBe(2)
    expect(lines).toContain("no schedule for platform.diagnostic")
    expect(await runBackfill(["x"], deps)).toBe(64)
    expect(lines.some((l) => l.startsWith("usage:"))).toBe(true)
  })

  it("the backfill CLI reports a range error before touching the store", async () => {
    const lines: string[] = []
    const schedules = [{ jobType: "test.scheduled", cron: "0 2 * * *", period: "day" as const }]
    const deps = { schedules, now: () => T0, out: (l: string) => void lines.push(l) }
    expect(await runBackfill(["test.scheduled", "2026-03-01", "2026-02-27"], deps)).toBe(2)
    expect(await runBackfill(["test.scheduled", "nope", "2026-02-27"], deps)).toBe(2)
    expect(await runBackfill(["test.scheduled", "2026-01-01", "2027-01-02"], deps)).toBe(2)
    expect(lines).toEqual(["from after to", "invalid period key", "range spans at most 366 periods"])
  })

  it("scheduledJobFunction carries the cron and Asia/Karachi", () => {
    expect(scheduledJobFunction({ jobType: "test.scheduled", cron: "0 2 * * *", period: "day" }).__endpoint).toMatchObject({
      region: ["asia-south1"],
      scheduleTrigger: { schedule: "0 2 * * *", timeZone: "Asia/Karachi" },
    })
    expect(SCHEDULED_JOBS).toEqual([
      { jobType: "d1.autoconfirm", cron: "15 2 * * *", period: "day" },
      { jobType: "d1.conflict.reindex", cron: "35 2 * * *", period: "day" },
    ])
  })
})
