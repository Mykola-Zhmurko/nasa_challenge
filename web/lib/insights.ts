import type {BBox, CalendarDay} from './api'

/** Approximate ground area of a bounding box in km² (small-angle formula). */
export function bboxAreaKm2(bbox: BBox): number {
  const [west, south, east, north] = bbox
  const width = Math.abs(east - west)
  const height = Math.abs(north - south)
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0
  const midLat = ((south + north) / 2) * (Math.PI / 180)
  const kmPerDegLat = 111.32
  const kmPerDegLon = 111.32 * Math.cos(midLat)
  return Math.round(width * kmPerDegLon * height * kmPerDegLat)
}

export interface MonthComparison {
  /** Newest month in the series, e.g. 11 for November. */
  month: number
  year: number
  /** Number of days of that month that carry data in both sides of the comparison. */
  daysLoaded: number
  /** Hotspots in the first `daysLoaded` days of that month. */
  detections: number
  /** Median of the same days in the earlier years. */
  median: number
  /** detections / median, 1 means "exactly the median". */
  ratio: number
  /** Difference to the median in percent, e.g. 1240 means "+1,240 %". */
  percent: number
  /** Earlier years that carry data for the same days. */
  years: number
}

/** Median of a sorted list; an even count averages the two middle values, like DuckDB. */
function medianOf(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * Compares the newest month in the series with the SAME days of that month in the earlier years.
 * A running month must never be measured against full months.
 */
export function monthComparison(days: CalendarDay[], reference?: string | null): MonthComparison | null {
  if (!days.length) return null
  // The box follows what the user looks at: the picked day, else the newest day in the data.
  const target =
    reference && /^\d{4}-\d{2}-\d{2}$/.test(reference)
      ? reference
      : days.reduce((best, item) => (item.date > best.date ? item : best)).date
  const [yearText, monthText, dayText] = target.split('-')
  const year = Number(yearText)
  const month = Number(monthText)
  const dayOfMonth = Number(dayText)
  if (!year || !month || !dayOfMonth) return null

  // Compare the same day-of-month window: from the first to the last day that carries data
  // in the current month. Days without rows count as zero on both sides, so a sparse area
  // still gets a median instead of "no data".
  let firstDay = Number.POSITIVE_INFINITY
  let lastDay = 0
  let detections = 0
  for (const item of days) {
    const [itemYear, itemMonth, itemDay] = item.date.split('-').map(Number)
    if (itemYear !== year || itemMonth !== month || itemDay === undefined) continue
    if (itemDay < firstDay) firstDay = itemDay
    if (itemDay > lastDay) lastDay = itemDay
    detections += item.detections
  }
  if (!Number.isFinite(firstDay) || lastDay === 0) return null

  const byYear = new Map<number, number>()
  for (const item of days) {
    const [itemYear, itemMonth, itemDay] = item.date.split('-').map(Number)
    if (itemMonth !== month || itemYear === undefined || itemDay === undefined) continue
    if (itemDay < firstDay || itemDay > lastDay) continue
    if (itemYear === year) continue
    byYear.set(itemYear, (byYear.get(itemYear) ?? 0) + item.detections)
  }
  const earlier = [...byYear.values()].sort((a, b) => a - b)
  if (!earlier.length) return null

  const median = medianOf(earlier)
  const ratio = median > 0 ? Math.round((detections / median) * 100) / 100 : 0
  const percent = median > 0 ? Math.round((detections / median - 1) * 100) : 0
  return {
    month,
    year,
    daysLoaded: lastDay - firstDay + 1,
    detections,
    median,
    ratio,
    percent,
    years: earlier.length,
  }
}

export interface RangeActivity {
  /** Day with the most detections inside the range. */
  peakDate: string | null
  peakDetections: number
  /** Days inside the range that reported at least one detection. */
  activeDays: number
  /** Days the range covers. */
  daysInRange: number
}

export function rangeActivity(days: CalendarDay[], from: string, to: string): RangeActivity {
  const inside = days.filter(item => item.date >= from && item.date <= to)
  let peakDate: string | null = null
  let peakDetections = 0
  let activeDays = 0
  for (const day of inside) {
    if (day.detections > 0) activeDays += 1
    if (day.detections > peakDetections) {
      peakDetections = day.detections
      peakDate = day.date
    }
  }
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  const daysInRange =
    Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 86_400_000) + 1 : 0
  return {peakDate, peakDetections, activeDays, daysInRange}
}

/** Plain words for the comparison — the box never states the number alone. */
export function anomalyLevel(percent: number): string {
  if (percent >= 400) return 'far above normal'
  if (percent >= 50) return 'above normal'
  if (percent <= -33) return 'below normal'
  return 'near normal'
}

/** True when `inner` lies inside `outer` (used to check whether the history covers the area). */
export function bboxInside(inner: BBox, outer: BBox): boolean {
  const [iw, is, ie, inorth] = inner
  const [ow, os, oe, onorth] = outer
  // A preset that is a hair wider than the data coverage (Europe: -25 vs -24.84) must still
  // count as covered, otherwise its comparison box never appears. Scale the tolerance with
  // the box, so a genuinely outside area keeps failing.
  const tolerance = Math.max(0.01, 0.01 * Math.max(ie - iw, inorth - is))
  return (
    iw >= ow - tolerance && ie <= oe + tolerance && is >= os - tolerance && inorth <= onorth + tolerance
  )
}
