import type {CalendarDay, CalendarMonth} from './api'

/** Twelve monthly values of one year, January first; null where no month is loaded. */
export type MonthSeries = (number | null)[]

/** Years that carry monthly rows, newest first. */
export function yearsOnRecord(months: CalendarMonth[], fallback: number): number[] {
  const set = new Set<number>()
  for (const item of months) {
    if (Number.isFinite(item.year)) set.add(item.year)
  }
  if (!set.size) set.add(fallback)
  return Array.from(set).sort((a, b) => b - a)
}

export function monthlySeries(months: CalendarMonth[], year: number): MonthSeries {
  const byMonth = new Map<number, number>()
  for (const item of months) {
    if (item.year === year) byMonth.set(item.month, item.detections)
  }
  return Array.from({length: 12}, (_, index) => byMonth.get(index + 1) ?? null)
}

/** Sum of the loaded months; a year with 1 of 12 months loaded has no year total. */
export function seriesTotal(series: MonthSeries): {total: number; months: number} {
  let total = 0
  let months = 0
  for (const value of series) {
    if (value === null) continue
    total += value
    months += 1
  }
  return {total, months}
}

/** The nearest older year on record, else the nearest newer one. */
export function otherYear(years: number[], year: number): number {
  const older = years.filter(item => item < year)
  if (older.length) return Math.max(...older)
  const newer = years.filter(item => item > year)
  if (newer.length) return Math.min(...newer)
  return year
}

/** The month the daily chart shows: the current one, else the latest month that has days. */
export function currentMonthWindow(
  days: CalendarDay[],
  todayIso: string,
): {year: number; month: number; current: boolean} {
  const year = Number(todayIso.slice(0, 4))
  const month = Number(todayIso.slice(5, 7))
  const prefix = `${year}-${String(month).padStart(2, '0')}-`
  if (days.some(day => day.date.startsWith(prefix))) return {year, month, current: true}
  const latest = days.reduce((best, day) => (day.date > best ? day.date : best), '')
  if (!latest) return {year, month, current: true}
  return {year: Number(latest.slice(0, 4)), month: Number(latest.slice(5, 7)), current: false}
}
