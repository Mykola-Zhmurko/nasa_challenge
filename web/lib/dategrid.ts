/** Calendar-grid maths for the date range picker. All dates are ISO `YYYY-MM-DD` in UTC. */

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

/** Monday first, the order the grid draws. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

const DAY_MS = 86_400_000

function ms(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`)
}

/** Build an ISO date from a year, a month index (0-11) and a day of month. */
export function isoOf(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Year, month index and day of an ISO date. */
export function partsOf(iso: string): {year: number; month: number; day: number} {
  const date = new Date(ms(iso))
  return {year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate()}
}

/** Sortable key for a month, so two months can be compared. */
export function monthKey(year: number, month: number): number {
  return year * 12 + month
}

/** Weekday index with Monday = 0 and Sunday = 6. */
export function weekdayOf(iso: string): number {
  return (new Date(ms(iso)).getUTCDay() + 6) % 7
}

/** Number of days in a month. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/**
 * The month as week rows, Monday first. Cells before the first day and after the
 * last are `null`, so the grid never shifts.
 */
export function monthCells(year: number, month: number): (string | null)[] {
  const cells: (string | null)[] = Array(weekdayOf(isoOf(year, month, 1))).fill(null)
  for (let day = 1; day <= daysInMonth(year, month); day += 1) {
    cells.push(isoOf(year, month, day))
  }
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

/** Move a month by `delta` months, rolling over the year. */
export function shiftMonth(year: number, month: number, delta: number): {year: number; month: number} {
  const key = monthKey(year, month) + delta
  return {year: Math.floor(key / 12), month: ((key % 12) + 12) % 12}
}

/** Move a date by `delta` days. */
export function shiftDay(iso: string, delta: number): string {
  return new Date(ms(iso) + delta * DAY_MS).toISOString().slice(0, 10)
}

/** Inclusive number of days between two ISO dates (same day = 1). */
export function daysBetween(from: string, to: string): number {
  const first = Math.min(ms(from), ms(to))
  const last = Math.max(ms(from), ms(to))
  return Math.round((last - first) / DAY_MS) + 1
}

/** "November 2026" */
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`
}
