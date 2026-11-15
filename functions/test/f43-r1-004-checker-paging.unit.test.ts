import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Timestamp } from "firebase-admin/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CHECK_MAX_PAGES, CHECK_PAGE_SIZE, CHECK_PASSES, CHECKER_BUDGET_MS, CHECKER_RAISE_SLACK_MS, checkerTestSeam, reservationQueryRunBound, runAlertChecker, type CheckCursor, type CheckQuery, type CheckerPageRow } from "../src/alerts/checker"
import { raiseAlertBestEffort } from "../src/alerts/raise"
import { spyRegisteredErrors } from "./registeredErrorLog"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const BOUND_SENTENCE = "each of held and quarantined is read within 6·ceil(N / 500) runs when the budget fits only the leading query"
const OVERSTATED_BOUND = "rotation then reads a row within 3·ceil"
const FA_260_001_SENTENCE = "That drop does not end the query: the end is a raw page shorter than 100 (FA-260-001)."
const FA_260_R2_001_SENTENCE = "Only a missing order field fails closed. When the row a query would save has no order field, that query logs ops_alert.pass_failed with code checker_cursor_absent_order, the rows already read are still alerted, and the same window is read again on the next run (FA-260-R2-001)."
const FA_260_R3_001_SENTENCE = "A present order field, including a number or a string, is stored on the cursor and the next run resumes after that row (FA-260-R3-001)."
const FA_260_002_SENTENCE = "A stored null is the exception (FA-260-002, parked): 100 or more null leases at a page end restart the query, the rows behind them are not read, and the first 100 are counted again on each run."
const ABSENT_ORDER_CODE = "checker_cursor_absent_order"
const OVERCLAIMED_STARVE = "starve the rows after it"
const OVERCLAIMED_FULL_PAGE = "A full raw page continues from its last raw row"
const OVERCLAIMED_REREAD = "costs at most a window re-read"

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

function orderMillis(at: CheckCursor["at"] | undefined): number | undefined {
  if (at instanceof Timestamp) return at.toMillis()
  if (typeof at === "number" && Number.isFinite(at)) return at
  return undefined
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
  const atMs = orderMillis(cursor.at)
  const idx = sorted.findIndex((r) => r.id === cursor.id && (field === null || atMs === undefined || timeMs(r.data[field]) === atMs))
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
    expect(orderMillis(seen[1]?.cursor?.at)).toBe(T + 10_000 + 96)

    const cursor = checkerTestSeam.memory?.cursors.reservationsQuarantined
    expect(cursor?.id).toBe("a-0496")
    expect(orderMillis(cursor?.at)).toBe(T + 10_000 + 496)

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

  it("alerts rows after a full page that contains one absent leaseUntil, and resumes from the last raw row", async () => {
    const calls: Call[] = []
    const leased = Array.from({ length: CHECK_PAGE_SIZE - 1 }, (_, i) => ({
      id: `leased-${String(i).padStart(3, "0")}`,
      data: { firmId: "firm-leased", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T + i) },
    }))
    const absent = { id: "absent-lease", data: { firmId: "firm-absent", state: "reconcile_failed" } }
    const late = {
      id: "firm-late",
      data: { firmId: "firm-late", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T + 1_000_000) },
    }
    const firstPage: CheckerPageRow[] = [absent, ...leased]
    const lastRaw = leased[leased.length - 1]!
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, field, cursor) => {
      calls.push({ name, field, cursor })
      if (name !== "reservationsQuarantined") return []
      if (cursor === null) return firstPage
      return [late]
    }

    await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })

    const quarantined = calls.filter((c) => c.name === "reservationsQuarantined")
    expect(firstPage).toHaveLength(CHECK_PAGE_SIZE)
    expect(firstPage[firstPage.length - 1]?.id).toBe(lastRaw.id)
    expect(quarantined.map((c) => c.cursor)).toEqual([
      null,
      { at: lastRaw.data.leaseUntil, id: lastRaw.id },
    ])
    const firms = raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)
    expect(firms).toContain("firm-late")
    expect(firms).toContain("firm-leased")
    expect(firms).not.toContain("firm-absent")
    expect(checkerTestSeam.memory?.cursors.reservationsQuarantined).toBeNull()
  })

  it("resumes from the last raw row when that row is the one whose leaseUntil is absent", async () => {
    const calls: Call[] = []
    const leased = Array.from({ length: CHECK_PAGE_SIZE - 1 }, (_, i) => ({
      id: `leased-${String(i).padStart(3, "0")}`,
      data: { firmId: "firm-leased", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T + i) },
    }))
    const absent = { id: "absent-last", data: { firmId: "firm-absent", state: "reconcile_failed" } }
    const late = {
      id: "firm-late",
      data: { firmId: "firm-late", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T + 1_000_000) },
    }
    const firstPage = [...leased, absent]
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, field, cursor) => {
      calls.push({ name, field, cursor })
      if (name !== "reservationsQuarantined") return []
      if (cursor?.id === absent.id) return [late]
      return cursor === null ? firstPage : []
    }

    await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })

    const quarantined = calls.filter((c) => c.name === "reservationsQuarantined")
    expect(quarantined[1]?.cursor?.id).toBe(absent.id)
    expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)).toContain("firm-late")
    expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)).not.toContain("firm-absent")
  })

  it("a raw page one row short of CHECK_PAGE_SIZE is the end, so a later row is not read", async () => {
    const calls: Call[] = []
    const leased = Array.from({ length: CHECK_PAGE_SIZE - 1 }, (_, i) => ({
      id: `leased-${String(i).padStart(3, "0")}`,
      data: { firmId: "firm-leased", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T + i) },
    }))
    const phantom = {
      id: "phantom-late",
      data: { firmId: "firm-phantom", state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(T + 1_000_000) },
    }
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, field, cursor) => {
      calls.push({ name, field, cursor })
      if (name !== "reservationsQuarantined") return []
      return cursor === null ? leased : [phantom]
    }

    await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })

    expect(leased).toHaveLength(CHECK_PAGE_SIZE - 1)
    expect(calls.filter((c) => c.name === "reservationsQuarantined")).toHaveLength(1)
    expect(checkerTestSeam.memory?.cursors.reservationsQuarantined).toBeNull()
    const firms = raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)
    expect(firms).toContain("firm-leased")
    expect(firms).not.toContain("firm-phantom")
  })
})

function leasedRow(id: string, firmId: string, ms: number): CheckerPageRow {
  return { id, data: { firmId, state: "reconcile_failed", leaseUntil: Timestamp.fromMillis(ms) } }
}

function absentRow(id: string): CheckerPageRow {
  return { id, data: { firmId: "firm-absent", state: "reconcile_failed" } }
}

/** Pages in the given order, after the cursor id. The seam does not re-sort an absent field to the end. */
function pageInOrder(rows: readonly CheckerPageRow[], cursor: CheckCursor | null): CheckerPageRow[] {
  const start = cursor === null ? 0 : rows.findIndex((row) => row.id === cursor.id) + 1
  return rows.slice(Math.max(0, start), Math.max(0, start) + CHECK_PAGE_SIZE)
}

describe("FA-260-R2-001: a window that ends on an absent order field fails closed", () => {
  const T = Date.parse("1970-01-06T00:00:00.000Z")
  const window = CHECK_PAGE_SIZE * CHECK_MAX_PAGES

  it("A3: 499 leased rows, an absent lease at row 500, then firm-late — alerted or pass_failed, never a silent restart", async () => {
    const errors = spyRegisteredErrors()
    const rows = [
      ...Array.from({ length: window - 1 }, (_, i) => leasedRow(`leased-${String(i).padStart(4, "0")}`, "firm-leased", T + i)),
      absentRow("absent-500"),
      leasedRow("firm-late", "firm-late", T + 9_000_000),
    ]
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder(rows, cursor) : [])
    try {
      for (let run = 0; run < 2; run++) {
        raise.mockClear()
        errors.calls.length = 0
        await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
        const firms = raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)
        const coded = errors.fieldsOf("ops_alert.pass_failed").filter((fields) => fields.pass === "reservationsQuarantined" && fields.code === ABSENT_ORDER_CODE)
        expect(firms, `run ${run}`).toContain("firm-leased")
        expect(firms, `run ${run}`).not.toContain("firm-late")
        expect(firms, `run ${run}`).not.toContain("firm-absent")
        expect(coded, `run ${run}`).toHaveLength(1)
      }
      expect(checkerTestSeam.memory?.cursors.reservationsQuarantined ?? null).toBeNull()
    } finally {
      errors.restore()
    }
  })

  it("A2: 500 absent rows then 10 leased — the leased rows are alerted or the pass fails closed, and no undefined cursor is stored", async () => {
    const errors = spyRegisteredErrors()
    const rows = [
      ...Array.from({ length: window }, (_, i) => absentRow(`absent-${String(i).padStart(4, "0")}`)),
      ...Array.from({ length: 10 }, (_, i) => leasedRow(`leased-${String(i).padStart(2, "0")}`, "firm-leased", T + i)),
    ]
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder(rows, cursor) : [])
    try {
      for (let run = 0; run < 2; run++) {
        raise.mockClear()
        errors.calls.length = 0
        await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
        const firms = raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)
        const coded = errors.fieldsOf("ops_alert.pass_failed").filter((fields) => fields.pass === "reservationsQuarantined" && fields.code === ABSENT_ORDER_CODE)
        expect(firms, `run ${run}`).not.toContain("firm-leased")
        expect(firms, `run ${run}`).not.toContain("firm-absent")
        expect(coded, `run ${run}`).toHaveLength(1)
      }
      expect(checkerTestSeam.memory?.cursors.reservationsQuarantined ?? null).toBeNull()
    } finally {
      errors.restore()
    }
  })

  it("fails closed when the budget stops on a full page whose last raw row has no leaseUntil", async () => {
    const errors = spyRegisteredErrors()
    const leased = Array.from({ length: CHECK_PAGE_SIZE - 1 }, (_, i) => leasedRow(`leased-${String(i).padStart(3, "0")}`, "firm-leased", T + i))
    const firstPage = [...leased, absentRow("absent-last")]
    const late = leasedRow("firm-late", "firm-late", T + 9_000_000)
    let quarantinedPages = 0
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => {
      if (name !== "reservationsQuarantined") return []
      quarantinedPages += 1
      return cursor === null ? firstPage : [late]
    }
    try {
      await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => (quarantinedPages > 0 ? CHECKER_BUDGET_MS : 0) })
      const firms = raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)
      const coded = errors.fieldsOf("ops_alert.pass_failed").filter((fields) => fields.pass === "reservationsQuarantined" && fields.code === ABSENT_ORDER_CODE)
      expect(firms).toContain("firm-leased")
      expect(firms).not.toContain("firm-late")
      expect(coded).toHaveLength(1)
      expect(checkerTestSeam.memory?.cursors.reservationsQuarantined ?? null).toBeNull()
    } finally {
      errors.restore()
    }
  })
})

function presentLease(id: string, firmId: string, leaseUntil: number | string): CheckerPageRow {
  return { id, data: { firmId, state: "reconcile_failed", leaseUntil } }
}

describe("FA-260-R3-001: a present number or string leaseUntil is a cursor, and one absent field does not drop other firms", () => {
  const T = Date.parse("1970-01-07T00:00:00.000Z")
  const window = CHECK_PAGE_SIZE * CHECK_MAX_PAGES

  it("R3/R7: a number lease at row 500 is stored and the next run alerts the row after it", async () => {
    const errors = spyRegisteredErrors()
    const numbers = Array.from({ length: window }, (_, i) => presentLease(`num-${String(i).padStart(4, "0")}`, "firm-num", i + 1))
    const late = leasedRow("firm-late", "firm-late", T)
    const rows = [...numbers, late]
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder(rows, cursor) : [])
    try {
      await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
      expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)).toContain("firm-num")
      expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)).not.toContain("firm-late")
      expect(checkerTestSeam.memory?.cursors.reservationsQuarantined).toEqual({ at: window, id: "num-0499" })
      expect(errors.fieldsOf("ops_alert.pass_failed")).toHaveLength(0)
      raise.mockClear()
      await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
      expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)).toContain("firm-late")
    } finally {
      errors.restore()
    }
  })

  it("R4: a string lease at row 500 is stored and the next run alerts the row after it", async () => {
    const errors = spyRegisteredErrors()
    const strings = Array.from({ length: window }, (_, i) => presentLease(`str-${String(i).padStart(4, "0")}`, "firm-str", `s-${String(i).padStart(4, "0")}`))
    const late = leasedRow("firm-late", "firm-late", T)
    const rows = [...strings, late]
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder(rows, cursor) : [])
    try {
      await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
      expect(checkerTestSeam.memory?.cursors.reservationsQuarantined).toEqual({ at: "s-0499", id: "str-0499" })
      expect(errors.fieldsOf("ops_alert.pass_failed")).toHaveLength(0)
      raise.mockClear()
      await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
      expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)).toContain("firm-late")
    } finally {
      errors.restore()
    }
  })

  it("R8: twelve other firms' held rows are alerted when the quarantined window stops on an absent leaseUntil", async () => {
    const errors = spyRegisteredErrors()
    const held = Array.from({ length: 12 }, (_, i) => ({
      id: `held-${String(i).padStart(2, "0")}`,
      data: { firmId: `firm-held-${String(i).padStart(2, "0")}`, state: "reserved", leaseUntil: Timestamp.fromMillis(T) },
    }))
    const quarantined = [
      ...Array.from({ length: window - 1 }, (_, i) => leasedRow(`q-${String(i).padStart(4, "0")}`, "firm-quarantined", T + i)),
      absentRow("absent-500"),
      leasedRow("firm-late", "firm-late", T + 9_000_000),
    ]
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => {
      if (name === "reservationsHeld") return cursor === null ? held : []
      if (name === "reservationsQuarantined") return pageInOrder(quarantined, cursor)
      return []
    }
    try {
      await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
      const firms = raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)
      expect(firms.filter((firm) => firm.startsWith("firm-held-")).sort()).toEqual(held.map((row) => row.data.firmId).sort())
      expect(firms).toContain("firm-quarantined")
      expect(firms).not.toContain("firm-late")
      expect(errors.fieldsOf("ops_alert.pass_failed").filter((fields) => fields.code === ABSENT_ORDER_CODE)).toHaveLength(1)
    } finally {
      errors.restore()
    }
  })
})

function nullLease(id: string, firmId: string): CheckerPageRow {
  return { id, data: { firmId, state: "reconcile_failed", leaseUntil: null } }
}

describe("FA-260-002: a stored null at a full page end is kept and does not resume", () => {
  const T = Date.parse("1970-01-11T00:00:00.000Z")

  it("re-reads the first 100 null leases five times and does not alert the rows behind them", async () => {
    const nulls = Array.from({ length: CHECK_PAGE_SIZE }, (_, i) => nullLease(`null-${String(i).padStart(3, "0")}`, "firm-null"))
    const behind = leasedRow("behind", "firm-behind", T)
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder([...nulls, behind], cursor) : [])
    await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
    const specs = raise.mock.calls.map((c) => c[0] as { firmId: string; detail: { unresolved: number } })
    expect(specs.map((spec) => spec.firmId)).not.toContain("firm-behind")
    expect(specs.find((spec) => spec.firmId === "firm-null")?.detail.unresolved).toBe(CHECK_PAGE_SIZE * CHECK_MAX_PAGES)
  })

  it("saves the null cursor and does not log a closed failure", async () => {
    const errors = spyRegisteredErrors()
    const nulls = Array.from({ length: CHECK_PAGE_SIZE }, (_, i) => nullLease(`null-${String(i).padStart(3, "0")}`, "firm-null"))
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder(nulls, cursor) : [])
    try {
      await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
      expect(errors.fieldsOf("ops_alert.pass_failed")).toHaveLength(0)
      expect(checkerTestSeam.memory?.cursors.reservationsQuarantined).toEqual({ at: null, id: "null-099" })
    } finally {
      errors.restore()
    }
  })
})

describe("cursor resume guards", () => {
  const T = Date.parse("1970-01-12T00:00:00.000Z")
  const window = CHECK_PAGE_SIZE * CHECK_MAX_PAGES

  it("keeps a stored cursor when the budget is already spent before that query reads a page", async () => {
    const pinned = { at: Timestamp.fromMillis(T), id: "pinned-cursor" }
    checkerTestSeam.memory = { cursors: { reservationsQuarantined: pinned }, passIndex: 0 }
    let heldRead = false
    checkerTestSeam.readPage = async (name) => {
      if (name === "reservationsHeld") {
        heldRead = true
        return []
      }
      throw new Error(`page read for ${name}`)
    }
    await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => (heldRead ? CHECKER_BUDGET_MS : 0) })
    expect(checkerTestSeam.memory?.cursors.reservationsQuarantined).toEqual(pinned)
  })

  it("leaves the stored cursor in place when the save row has no order field", async () => {
    const errors = spyRegisteredErrors()
    const pinned = { at: Timestamp.fromMillis(T), id: "pinned-cursor" }
    const rows = [...Array.from({ length: window - 1 }, (_, i) => leasedRow(`leased-${String(i).padStart(4, "0")}`, "firm-leased", T + i)), absentRow("absent-500")]
    checkerTestSeam.memory = { cursors: { reservationsQuarantined: pinned }, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder(rows, cursor) : [])
    try {
      await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
      expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)).toContain("firm-leased")
      expect(errors.fieldsOf("ops_alert.pass_failed").filter((fields) => fields.code === ABSENT_ORDER_CODE)).toHaveLength(1)
      expect(checkerTestSeam.memory?.cursors.reservationsQuarantined).toEqual(pinned)
    } finally {
      errors.restore()
    }
  })

  it("ignores a stored cursor that has no order field and still reads the oldest row", async () => {
    const rows = [leasedRow("early", "firm-early", T), leasedRow("skip-me", "firm-mid", T + 1), leasedRow("late", "firm-late", T + 2)]
    checkerTestSeam.memory = { cursors: { reservationsQuarantined: { id: "skip-me" } as CheckCursor }, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder(rows, cursor) : [])
    await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
    expect(raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)).toContain("firm-early")
  })

  it("alerts rows from earlier pages when the save row has no order field", async () => {
    const errors = spyRegisteredErrors()
    const early = Array.from({ length: 300 }, (_, i) => leasedRow(`early-${String(i).padStart(4, "0")}`, "firm-early", T + i))
    const last = Array.from({ length: window - 300 - 1 }, (_, i) => leasedRow(`last-${String(i).padStart(3, "0")}`, "firm-last", T + 10_000 + i))
    const rows = [...early, ...last, absentRow("absent-500")]
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder(rows, cursor) : [])
    try {
      await runAlertChecker({ now: () => T, passes: ["reservations"], wallClock: () => 0 })
      const firms = raise.mock.calls.map((c) => (c[0] as { firmId: string }).firmId)
      expect(firms).toContain("firm-early")
      expect(firms).toContain("firm-last")
      expect(errors.fieldsOf("ops_alert.pass_failed").filter((fields) => fields.code === ABSENT_ORDER_CODE)).toHaveLength(1)
    } finally {
      errors.restore()
    }
  })

  it("stops raising 10s past the budget and still advances the pass index", async () => {
    const rows = ["a", "b", "c"].map((name, i) => leasedRow(name, `firm-${name}`, T + i))
    checkerTestSeam.memory = { cursors: {}, passIndex: 0 }
    checkerTestSeam.readPage = async (name, _field, cursor) => (name === "reservationsQuarantined" ? pageInOrder(rows, cursor) : [])
    let raised = 0
    raise.mockImplementation(async () => {
      raised += 1
      return "raised"
    })
    await runAlertChecker({ now: () => T, wallClock: () => (raised > 0 ? CHECKER_BUDGET_MS + CHECKER_RAISE_SLACK_MS : 0) })
    expect(raised).toBe(1)
    expect(checkerTestSeam.memory?.passIndex).toBe(1)
  })
})

describe("FA-260 README sentences", () => {
  it("pins the FA-260-001 sentence and the fail-closed sentence in the README, the checker and the spec", () => {
    const files = [
      "functions/src/alerts/README.md",
      "functions/src/alerts/checker.ts",
      "docs/superpowers/specs/2026-10-24-f43-durable-alert-delivery-design.md",
    ]
    for (const file of files) {
      const text = readFileSync(resolve(repoRoot, file), "utf8")
      expect(text, file).toContain(FA_260_001_SENTENCE)
      expect(text, file).toContain(FA_260_R2_001_SENTENCE)
      expect(text, file).toContain(FA_260_R3_001_SENTENCE)
      expect(text, file).toContain(FA_260_002_SENTENCE)
      expect(text, file).not.toContain(OVERCLAIMED_STARVE)
      expect(text, file).not.toContain(OVERCLAIMED_FULL_PAGE)
      expect(text, file).not.toContain(OVERCLAIMED_REREAD)
    }
  })
})
