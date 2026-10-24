import { Query } from "firebase-admin/firestore"
import { vi } from "vitest"

/** The checker's per-run scan budget (`alerts/checker.ts` CHECKER_BUDGET_MS, unit-pinned). */
export const CHECKER_BUDGET_MS = 40_000

/**
 * A wall clock for one `runAlertChecker` run whose scan budget is spent as soon as the run has read its first query
 * page: it reads 0 until then and `CHECKER_BUDGET_MS` after (inside the raises' grace, which the checker grants past the
 * scan budget). Pages are counted at `Query.prototype.get`, which every checker query goes through. Call `restore()`
 * after the run.
 */
export function budgetSpentAfterFirstPage(): { wallClock: () => number; restore: () => void } {
  let pages = 0
  const original = Query.prototype.get
  const spy = vi.spyOn(Query.prototype, "get").mockImplementation(async function (this: Query) {
    const snap = await original.call(this)
    pages += 1
    return snap
  })
  return { wallClock: () => (pages >= 1 ? CHECKER_BUDGET_MS : 0), restore: () => spy.mockRestore() }
}
