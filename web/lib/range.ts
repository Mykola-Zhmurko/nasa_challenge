export interface DateWindow {
  from: string
  to: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** True for a well-formed calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ms)
}

/** Order a picked window and keep it inside the dataset range. */
export function clampRange(from: string, to: string, min: string, max: string): DateWindow {
  const first = from <= to ? from : to
  const last = from <= to ? to : from
  const start = first < min ? min : first > max ? max : first
  const end = last > max ? max : last < min ? min : last
  return start <= end ? {from: start, to: end} : {from: end, to: start}
}
