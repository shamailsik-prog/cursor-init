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
  const utc = Date.UTC(date.y, date.m - 1, date.d + days)
  if (!Number.isFinite(utc)) throw new Error("limitation date arithmetic overflow")
  const next = new Date(utc)
  const year = next.getUTCFullYear()
  const month = next.getUTCMonth() + 1
  const day = next.getUTCDate()
  if (!Number.isFinite(year) || year < 1 || year > 9999) throw new Error("limitation date arithmetic overflow")
  return iso(year, month, day)
}

/**
 * Adds a count of days, months or years. When the anniversary day does not exist,
 * returns null unless `clamp` is set, in which case the day is the last day of that month.
 * The clamp is used only when the verified text states that rule.
 */
export function addUnit(isoDate: string, count: number, unit: DateUnit, clamp: boolean): string | null {
  if (unit === "day") {
    try {
      const shifted = addDays(isoDate, count)
      return isCalendarDate(shifted) ? shifted : null
    } catch {
      return null
    }
  }
  const date = parts(isoDate)
  if (!date) return null
  const months = unit === "year" ? count * 12 : count
  const index = date.m - 1 + months
  const year = date.y + Math.floor(index / 12)
  const month = (index % 12) + 1
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null
  let dim: number
  try {
    const probe = new Date(Date.UTC(year, month, 0))
    if (!Number.isFinite(probe.getTime())) return null
    dim = probe.getUTCDate()
  } catch {
    return null
  }
  if (!Number.isFinite(dim) || dim < 1) return null
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
