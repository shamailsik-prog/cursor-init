import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { runBackfill } from "../src/cli/jobsBackfill"
import { backfillScheduledRuns, enqueueScheduledRuns, ScheduledRunsFailedError, type ScheduledJobSpec } from "../src/p2/scheduled"
import { jobIdFor } from "../src/p2/enqueue"
import { EMULATORS } from "./emu"
import { T0, diagSpec, enqueueAt, installTestHandlers, newFirm, readJob, removeTestHandlers } from "./jobs"

describe.skipIf(!EMULATORS)("P2 scheduled jobs (P3-16)", () => {
  const spec: ScheduledJobSpec = { jobType: "test.scheduled", cron: "0 2 * * *", period: "day" }
  let firms: string[]

  beforeAll(async () => {
    installTestHandlers()
    firms = [await newFirm(), await newFirm(), await newFirm()]
  })
  afterAll(() => removeTestHandlers())

  it("one run per firm per period; a repeated tick reuses it", async () => {
    const first = await enqueueScheduledRuns(spec, T0, { pageSize: 2 })
    expect(first.firms).toBeGreaterThanOrEqual(3)
    for (const f of firms) {
      expect(await readJob(jobIdFor(f, "test.scheduled", "test.scheduled:2026-10-08"))).toMatchObject({
        runKey: "test.scheduled:2026-10-08",
        matterId: null,
        classification: "internal",
        createdBy: "system",
        payload: { period: "2026-10-08" },
      })
    }
    const before = await Promise.all(firms.map((f) => readJob(jobIdFor(f, "test.scheduled", "test.scheduled:2026-10-08"))))
    const second = await enqueueScheduledRuns(spec, T0 + 60_000)
    expect(second.created).toBe(0)
    expect(second.reused).toBe(second.firms)
    const after = await Promise.all(firms.map((f) => readJob(jobIdFor(f, "test.scheduled", "test.scheduled:2026-10-08"))))
    after.forEach((row, i) => expect(row.updateTime.isEqual(before[i].updateTime)).toBe(true))
  })

  // The backfill commits one transaction per firm per period over every firm in the shared emulator
  // (and the second run reads them all again), so its cost is O(firms). The firm count is whatever
  // the files that ran earlier left behind, and vitest orders files from its results cache, so this
  // test ran in 0.8 s early and exceeded the 15 s default when its file ran last. The timeout bounds
  // the worst case; the assertions are unchanged.
  it("backfill enqueues every period of the range per firm, and a second run creates nothing", { timeout: 120_000 }, async () => {
    const run = await backfillScheduledRuns(spec, "2026-10-05", "2026-10-07", T0)
    expect(run.created).toBeGreaterThanOrEqual(9)
    for (const f of firms) {
      for (const day of ["05", "06", "07"]) {
        expect(await readJob(jobIdFor(f, "test.scheduled", `test.scheduled:2026-10-${day}`))).toMatchObject({
          runKey: `test.scheduled:2026-10-${day}`,
          payload: { period: `2026-10-${day}` },
        })
      }
    }
    const again = await backfillScheduledRuns(spec, "2026-10-05", "2026-10-07", T0 + 1000)
    expect(again.created).toBe(0)
  })

  it("a range error enqueues nothing", async () => {
    await expect(backfillScheduledRuns(spec, "2026-10-07", "2026-10-05", T0)).rejects.toThrow(/from after to/)
  })

  /** A firm whose run for `key` already exists with a different payload, so its enqueue throws a key conflict. */
  async function poison(firmId: string, key: string): Promise<void> {
    const runKey = `test.scheduled:${key}`
    await enqueueAt(diagSpec(firmId, { behaviour: "succeed" }, { jobType: "test.scheduled", idempotencyKey: runKey, runKey, payload: { period: key, other: true } }), T0)
  }

  it("a failing firm does not starve the others; the tick reports the failure", async () => {
    const bad = await newFirm()
    await poison(bad, "2026-11-20")
    await expect(enqueueScheduledRuns(spec, Date.parse("2026-11-20T09:00:00Z"), { pageSize: 2 })).rejects.toBeInstanceOf(ScheduledRunsFailedError)
    for (const f of firms) {
      expect(await readJob(jobIdFor(f, "test.scheduled", "test.scheduled:2026-11-20"))).toMatchObject({ payload: { period: "2026-11-20" } })
    }
  })

  it("backfill continues past a failing firm and then reports failure", async () => {
    const bad = await newFirm()
    await poison(bad, "2026-11-22")
    await expect(backfillScheduledRuns(spec, "2026-11-21", "2026-11-23", T0)).rejects.toMatchObject({ failed: 1 })
    for (const f of firms) {
      for (const day of ["21", "22", "23"]) {
        expect(await readJob(jobIdFor(f, "test.scheduled", `test.scheduled:2026-11-${day}`))).toMatchObject({ payload: { period: `2026-11-${day}` } })
      }
    }
  })

  it("the CLI exits 0 on success, 1 on a failing firm, and 1 with a clear line for an unregistered handler", async () => {
    const lines: string[] = []
    const deps = { schedules: [spec], now: () => T0, out: (l: string) => void lines.push(l) }
    expect(await runBackfill(["test.scheduled", "2026-11-25", "2026-11-26"], deps)).toBe(0)
    expect(lines.at(-1)).toMatch(/^backfilled test\.scheduled 2026-11-25\.\.2026-11-26: \d+ created, \d+ reused, \d+ firms$/)
    await poison(await newFirm(), "2026-11-28")
    expect(await runBackfill(["test.scheduled", "2026-11-28", "2026-11-28"], deps)).toBe(1)
    expect(lines.at(-1)).toMatch(/incomplete: 1 firm run/)
    const ghost = { jobType: "test.ghost", cron: "0 2 * * *", period: "day" as const }
    expect(await runBackfill(["test.ghost", "2026-11-28", "2026-11-28"], { ...deps, schedules: [ghost] })).toBe(1)
    expect(lines.at(-1)).toBe("no handler registered for test.ghost")
  })
})
