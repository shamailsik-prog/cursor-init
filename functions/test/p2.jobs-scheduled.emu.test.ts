import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { backfillScheduledRuns, enqueueScheduledRuns, type ScheduledJobSpec } from "../src/p2/scheduled"
import { jobIdFor } from "../src/p2/enqueue"
import { EMULATORS } from "./emu"
import { T0, installTestHandlers, newFirm, readJob, removeTestHandlers } from "./jobs"

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

  it("backfill enqueues every period of the range per firm, and a second run creates nothing", async () => {
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
})
