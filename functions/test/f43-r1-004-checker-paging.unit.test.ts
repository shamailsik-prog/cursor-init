import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Timestamp } from "firebase-admin/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CHECK_MAX_PAGES, CHECK_PAGE_SIZE, CHECK_PASSES, CHECKER_BUDGET_MS, checkerTestSeam, reservationQueryRunBound, runAlertChecker, type CheckCursor, type CheckQuery, type CheckerPageRow } from "../src/alerts/checker"
import { raiseAlertBestEffort } from "../src/alerts/raise"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const BOUND_SENTENCE = "each of held and quarantined is read within 6·ceil(N / 500) runs when the budget fits only the leading query"
const OVERSTATED_BOUND = "rotation then reads a row within 3·ceil"

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

describe("FA-F43-R1-004-001: held/quarantine residual bound", () => {
  const T = Date.parse("1970-01-04T00:00:00.000Z")
  const stamp = Timestamp.fromMillis(T)

  it("reads quarantined reservations on run 6·ceil(N/500) when a held window spends the budget, and held still leads the previous reservations turn", async () => {
    const calls: Array<Call & { run: number }> = []
    let pages = 0
    const origin = 1_700_000_000_000
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    let currentRun = 0
    checkerTestSeam.readPage = async (name, field, cursor) => {
      calls.push({ name, field, cursor, run: currentRun })
      pages += 1
      if (name === "reservationsQuarantined") {
        return [{ id: "q1", data: { firmId: "firm-q", state: "reconcile_failed", leaseUntil: stamp } }]
      }
      return Array.from({ length: CHECK_PAGE_SIZE }, (_, i) => ({
        id: `${name}-${pages}-${i}`,
        data: { firmId: "firm-fill", leaseUntil: stamp, nextAttemptAt: stamp, sweepAt: stamp, "unmerge.startedAt": stamp },
      }))
    }
    const wallClock = () => origin + Math.floor((pages * CHECKER_BUDGET_MS) / CHECK_MAX_PAGES)
    const runs = reservationQueryRunBound(1)

    for (let run = 0; run < runs; run++) {
      currentRun = run
      pages = 0
      await runAlertChecker({ now: () => T, wallClock })
    }

    const firstQuarantined = calls.find((c) => c.name === "reservationsQuarantined")
    expect(reservationQueryRunBound(1)).toBe(6)
    expect(reservationQueryRunBound(CHECK_PAGE_SIZE * CHECK_MAX_PAGES)).toBe(6)
    expect(reservationQueryRunBound(CHECK_PAGE_SIZE * CHECK_MAX_PAGES + 1)).toBe(12)
    expect(firstQuarantined?.run).toBe(runs - 1)
    expect(calls.filter((c) => c.run === 2).map((c) => c.name)[0]).toBe("reservationsHeld")
    expect(calls.filter((c) => c.run === 2).some((c) => c.name === "reservationsQuarantined")).toBe(false)
    expect(CHECK_PAGE_SIZE * CHECK_MAX_PAGES).toBe(500)
  })

  it("states the same 6·ceil bound in the checker, the README and the spec, and does not leave the unqualified 3·ceil sentence", () => {
    const files = [
      "functions/src/alerts/checker.ts",
      "functions/src/alerts/README.md",
      "docs/superpowers/specs/2026-10-24-f43-durable-alert-delivery-design.md",
    ]
    for (const file of files) {
      const text = readFileSync(resolve(repoRoot, file), "utf8")
      expect(text, file).toContain(BOUND_SENTENCE)
      expect(text, file).not.toContain(OVERSTATED_BOUND)
    }
  })

  it("on the quarantine lead, reads quarantine first and still reads held when the budget remains", async () => {
    const calls = install({
      reservationsHeld: [{ id: "h1", data: { firmId: "firm-held", state: "reserved", leaseUntil: stamp } }],
      reservationsQuarantined: [{ id: "q1", data: { firmId: "firm-q", state: "reconcile_failed", leaseUntil: stamp } }],
    })
    checkerTestSeam.memory = { cursors: {}, passIndex: CHECK_PASSES.length * 2 - 1 }

    await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })

    expect(calls.map((c) => c.name)).toEqual(["reservationsQuarantined", "reservationsHeld"])
    expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId).sort()).toEqual(["firm-held", "firm-q"])
  })
})

describe("FA-F43-R1-004-002: a quarantined row with no leaseUntil stays outside the lease order", () => {
  const T = Date.parse("1970-01-05T00:00:00.000Z")

  it("does not alert a quarantined row whose leaseUntil is absent", async () => {
    const calls = install({
      reservationsQuarantined: [{ id: "missing", data: { firmId: "firm-missing", state: "reconcile_failed" } }],
    })

    await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })

    expect(calls.filter((c) => c.name === "reservationsQuarantined").map((c) => c.field)).toEqual(["leaseUntil"])
    expect(raise.mock.calls).toHaveLength(0)
  })

  it("keeps a Timestamp lease and a stored null, and drops only the absent field", async () => {
    const calls = install({
      reservationsQuarantined: [
        { id: "leased", data: { firmId: "firm-leased", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T) } },
        { id: "missing", data: { firmId: "firm-missing", state: "reconcile_failed" } },
        { id: "null-lease", data: { firmId: "firm-null", state: "reconcile_failed", leaseUntil: null } },
      ],
    })

    await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })

    expect(calls.find((c) => c.name === "reservationsQuarantined")?.field).toBe("leaseUntil")
    const specs = raise.mock.calls.map((c) => c[0] as { firmId: string; detail: { quarantined: number } })
    expect(specs.map((s) => s.firmId)).toEqual(["firm-leased", "firm-null"])
    expect(specs.every((s) => s.detail.quarantined === 1)).toBe(true)
  })
})
