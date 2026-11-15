/** Perceptually uniform, colour-blind-safe 5-step Viridis ramp (dark violet -> teal -> yellow). */
export const FIRE_RAMP = ['#440154', '#3b528b', '#269994', '#5ec962', '#fde725']

export function parseDetectionTimestampMs(ts?: string | null, timeUtc?: string | null): number | null {
  if (!ts || !timeUtc) return null
  const trimmed = timeUtc.trim()
  if (!/^\d{2}:\d{2}/.test(trimmed)) return null
  const ms = Date.parse(`${ts}T${trimmed.slice(0, 5)}:00Z`)
  return Number.isFinite(ms) ? ms : null
}

export function formatConfidence(sensor: string, pct: number): string {
  if (sensor.toUpperCase() === 'VIIRS') {
    return pct >= 80 ? `High (${pct}%)` : `Nominal (${pct}%)`
  }
  return `${pct}% (${pct >= 80 ? 'high' : 'nominal'})`
}

export function formatDayNight(dn: string): string {
  const norm = dn.trim().toUpperCase()
  if (norm === 'D') return 'Day (D)'
  if (norm === 'N') return 'Night (N)'
  return dn || '—'
}

export function formatSatellite(sat: string): string {
  const norm = sat.trim().toUpperCase()
  if (norm === 'T') return 'Terra (T)'
  if (norm === 'A') return 'Aqua (A)'
  if (norm === 'N') return 'Suomi NPP (N)'
  if (norm === 'N20' || norm === 'J1') return 'NOAA-20 (N20)'
  return sat || '—'
}

/**
 * Fixed fire-power classes in MW. The same five classes are used for the map colours and for both
 * legends, so a colour means the same thing in every area, at every zoom level and over time.
 * The bounds sit on the worldwide quantiles of the mean fire power per hotspot area.
 */
export const FRP_CUTS = [2.5, 5, 10, 25, 100]

export function frpStepIndex(value: number, cuts: number[]): number {
  if (value <= 0 || !cuts.length) return 0
  for (let i = 0; i < cuts.length; i++) {
    if (value <= (cuts[i] ?? Infinity)) return i
  }
  return FIRE_RAMP.length - 1
}

export function frpRampColor(value: number, cuts: number[]): string {
  const index = frpStepIndex(value, cuts)
  return FIRE_RAMP[index] ?? '#440154'
}

export function frpStepLabels(): string[] {
  const fmt = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1))
  return FRP_CUTS.map((upper, index) => {
    const lower = index === 0 ? 0 : (FRP_CUTS[index - 1] ?? 0)
    if (index === 0) return `0.0–${fmt(upper)}`
    return `${fmt(lower)}–${fmt(upper)}`
  })
}

/** Five steps of the Viridis ramp, read against the peak of the current view. */
export function stepIndex(value: number, peak: number): number {
  if (value <= 0 || peak <= 0) return -1
  const step = Math.floor((value / peak) * FIRE_RAMP.length)
  return Math.min(FIRE_RAMP.length - 1, Math.max(0, step))
}

export function rampColor(value: number, peak: number): string {
  const index = stepIndex(value, peak)
  return index < 0 ? '#2c2b2f' : FIRE_RAMP[index] ?? '#440154'
}

/** Ink that stays legible (>= 4.5:1 WCAG AA) on a filled Viridis ramp step. */
export function rampInk(value: number, peak: number): string {
  return stepIndex(value, peak) >= 2 ? '#101216' : '#ffffff'
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

export function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_FULL = [
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
]
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function monthShort(month: number): string {
  return MONTHS[month - 1] ?? ''
}

export function monthFull(month: number): string {
  return MONTHS_FULL[month - 1] ?? ''
}

export function weekdayShort(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? ''
}

export function dayNumber(iso: string): string {
  return iso.slice(8, 10)
}

/** "07–14 Nov 2026" */
export function formatRange(from: string, to: string): string {
  const a = new Date(`${from}T00:00:00Z`)
  const b = new Date(`${to}T00:00:00Z`)
  const aMonth = MONTHS[a.getUTCMonth()]
  const bMonth = MONTHS[b.getUTCMonth()]
  const aYear = a.getUTCFullYear()
  const bYear = b.getUTCFullYear()
  const day = (d: Date) => String(d.getUTCDate()).padStart(2, '0')
  if (aYear !== bYear) return `${day(a)} ${aMonth} ${aYear} – ${day(b)} ${bMonth} ${bYear}`
  if (aMonth !== bMonth) return `${day(a)} ${aMonth} – ${day(b)} ${bMonth} ${bYear}`
  return `${day(a)}–${day(b)} ${bMonth} ${bYear}`
}

/** "14 Nov 2026" */
export function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** Shift an ISO YYYY-MM-DD date by deltaDays, optionally clamped to minIso. */
export function shiftIsoDate(iso: string, deltaDays: number, minIso?: string): string {
  const ms = Date.parse(`${iso}T00:00:00Z`)
  if (!Number.isFinite(ms)) return iso
  const shifted = new Date(ms + deltaDays * 86_400_000).toISOString().slice(0, 10)
  if (minIso && shifted < minIso) return minIso
  return shifted
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Weekday index (0 = Sunday) of the first day of the month. */
export function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
}
