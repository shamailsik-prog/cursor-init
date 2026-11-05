import { Timestamp } from "firebase-admin/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CHECK_PAGE_SIZE, CHECKER_BUDGET_MS, checkerTestSeam, runAlertChecker, type CheckCursor, type CheckQuery, type CheckerPageRow } from "../src/alerts/checker"
import { raiseAlertBestEffort } from "../src/alerts/raise"

/**
 * FA-F43-R1-004. Two defects in the checker, pinned without the emulator:
 *
 * 1. Quarantined reservations were ordered by document id. A late id with the oldest `leaseUntil` sat behind a 500-row
 *    window of newer leases and was not read on the first run.
 * 2. Passes always ran jobs, then sagas, then reservations. A wall-clock budget spent on the first pass skipped the
 *    later passes on every run. Rotating the start index gives each pass the leading slot once every three runs.
 */

vi.mock("../src/alerts/raise", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/alerts/raise")>()
  return { ...actual, raiseAlertBestEffort: vi.fn(async () => "raised") }
})

const raise = raiseAlertBestEffort as unknown as ReturnType<typeof vi.fn>

type Call = { name: CheckQuery; field: string | null; cursor: CheckCursor | null }

function timeMs(v: unknown): number {
  if (v instanceof Timestamp) return v.toMillis()
  if (typeof v === "number" && Number.isFinite(v)) return v
  return Number.POSITIVE_INFINITY
}

/** Pages the way the checker asked to: by `field` (id alone when null), then id, after `cursor`. */
function pageRows(rows: readonly CheckerPageRow[], field: string | null, cursor: CheckCursor | null): CheckerPageRow[] {
  const sorted = [...rows].sort((a, b) => {
    if (field !== null) {
      const d = timeMs(a.data[field]) - timeMs(b.data[field])
      if (d !== 0) return d
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  if (cursor === null) return sorted
  const idx = sorted.findIndex((r) => r.id === cursor.id && (field === null || cursor.at === null || timeMs(r.data[field]) === cursor.at.toMillis()))
  return idx < 0 ? sorted : sorted.slice(idx + 1)
}

function install(rows: Partial<Record<CheckQuery, CheckerPageRow[]>>): Call[] {
  const calls: Call[] = []
  checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
  checkerTestSeam.readPage = async (name, field, cursor) => {
    calls.push({ name, field, cursor })
    return pageRows(rows[name] ?? [], field, cursor)
  }
  return calls
}

afterEach(() => {
  delete checkerTestSeam.readPage
  delete checkerTestSeam.memory
  raise.mockClear()
})

describe("FA-F43-R1-004: quarantined reservations page oldest lease first", () => {
  const T = Date.parse("1970-01-02T00:00:00.000Z")

  it("reads the oldest leaseUntil across pages even when those ids sort last, and resumes after the 500th", async () => {
    const a = (i: number): CheckerPageRow => ({
      id: `a-${String(i).padStart(4, "0")}`,
      data: { firmId: "firm-a", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T + 10_000 + i) },
    })
    const b = (i: number): CheckerPageRow => ({
      id: `z-${String(i).padStart(4, "0")}`,
      data: { firmId: "firm-b", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T + i) },
    })
    const rows = [...Array.from({ length: 517 }, (_, i) => a(i)), ...Array.from({ length: 3 }, (_, i) => b(i))]
    const calls = install({ reservationsQuarantined: rows })

    await runAlertChecker({ now: () => T + 3_600_000, passes: ["reservations"], wallClock: () => 0 })

    const seen = calls.filter((c) => c.name === "reservationsQuarantined")
    expect(seen.length).toBe(5)
    expect(seen[0]?.field).toBe("leaseUntil")
    expect(seen[0]?.cursor).toBeNull()
    // Page 2 resumes at the 100th oldest lease (the 97th firm-A row: three firm-B leases come first).
    expect(seen[1]?.cursor).toMatchObject({ id: "a-0096" })
    expect(seen[1]?.cursor?.at?.toMillis()).toBe(T + 10_000 + 96)

    const cursor = checkerTestSeam.memory?.cursors.reservationsQuarantined
    expect(cursor?.id).toBe("a-0496")
    expect(cursor?.at?.toMillis()).toBe(T + 10_000 + 496)

    const firms = raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)
    expect(firms).toContain("firm-b")
    const firmB = raise.mock.calls.map((c) => c[0] as { firmId: string; detail: { quarantined: number } }).find((s) => s.firmId === "firm-b")
    expect(firmB?.detail.quarantined).toBe(3)
  })

  it("an id-only cursor cannot resume a time order, so the oldest lease is still read", async () => {
    const calls = install({
      reservationsQuarantined: [
        { id: "a", data: { firmId: "firm-old", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T) } },
        { id: "b", data: { firmId: "firm-new", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T + 50_000) } },
      ],
    })
    checkerTestSeam.memory = {
      cursors: { reservationsQuarantined: { at: null, id: "b" } },
      passIndex: 0,
    }

    await runAlertChecker({ now: () => T + 3_600_000, passes: ["reservations"], wallClock: () => 0 })

    const seen = calls.filter((c) => c.name === "reservationsQuarantined")
    expect(seen[0]?.field).toBe("leaseUntil")
    expect(seen[0]?.cursor).toBeNull()
    expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)).toContain("firm-old")
  })
})

describe("FA-F43-R1-004: pass rotation under a budget that fits one pass", () => {
  it("runs sagas and reservations once each across consecutive runs when the first pass spends the budget", async () => {
    const calls = install({})
    let spentNow = false
    checkerTestSeam.readPage = async (name, field, cursor) => {
      calls.push({ name, field, cursor })
      spentNow = true
      return []
    }
    const wallClock = () => (spentNow ? CHECKER_BUDGET_MS : 0)

    for (let run = 0; run < 4; run++) {
      spentNow = false
      await runAlertChecker({ now: () => 1_700_000_000_000, wallClock })
    }

    expect(calls.map((c) => c.name)).toEqual(["jobsWaiting", "sagas", "reservationsHeld", "jobsWaiting"])
    expect(CHECK_PAGE_SIZE).toBe(100)
  })
})
