/** Calendar arithmetic for a limitation deadline. Not a statutory period. */

export type LimitationAlert = { daysBefore: 90 | 30 | 7; dueOn: string }

export type DateUnit = "day" | "month" | "year"

export function isCalendarDate(isoDate: string): boolean {
  return parts(isoDate) !== null
}

export function limitationAlertSchedule(deadline: string): LimitationAlert[] {
  return ([90, 30, 7] as const).map((daysBefore) => ({ daysBefore, dueOn: addDays(deadline, -daysBefore) }))
}

export function addDays(isoDate: string, days: number): string {
  const date = parts(isoDate)
  if (!date) throw new Error("limitation date arithmetic on a date that is not a calendar day")
  const next = new Date(Date.UTC(date.y, date.m - 1, date.d + days))
  return iso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())
}

/**
 * Adds a count of days, months or years. When the anniversary day does not exist,
 * returns null unless `clamp` is set, in which case the day is the last day of that month.
 * The clamp is used only when the verified text states that rule.
 */
export function addUnit(isoDate: string, count: number, unit: DateUnit, clamp: boolean): string | null {
  if (unit === "day") return addDays(isoDate, count)
  const date = parts(isoDate)
  if (!date) return null
  const months = unit === "year" ? count * 12 : count
  const index = date.m - 1 + months
  const year = date.y + Math.floor(index / 12)
  const month = (index % 12) + 1
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (date.d > dim) return clamp ? iso(year, month, dim) : null
  return iso(year, month, date.d)
}

function parts(isoDate: string): { y: number; m: number; d: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null
  const y = Number(isoDate.slice(0, 4))
  const m = Number(isoDate.slice(5, 7))
  const d = Number(isoDate.slice(8, 10))
  if (m < 1 || m > 12 || d < 1) return null
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null
  return { y, m, d }
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}
