/** The one hue family of the subject: pale yellow -> orange -> deep red. */
export const FIRE_RAMP = ['#f6df7f', '#f0a33e', '#df6324', '#b8321a', '#7f170e']

const DEFAULT_FRP_CUTS = [2.5, 5, 10, 25, 100]

/** Five quantile upper bounds (MW) derived from the loaded cells' mean_frp. */
export function frpCuts(cells: {mean_frp: number}[]): number[] {
  if (!cells.length) return DEFAULT_FRP_CUTS
  const values = cells
    .map(cell => cell.mean_frp)
    .filter(val => Number.isFinite(val) && val > 0)
    .sort((a, b) => a - b)
  if (!values.length) return DEFAULT_FRP_CUTS
  const n = values.length
  const cuts = FIRE_RAMP.map((_, idx) => {
    const pos =
      idx === FIRE_RAMP.length - 1
        ? n - 1
        : Math.min(n - 1, Math.max(0, Math.floor(((idx + 1) / FIRE_RAMP.length) * n) - 1))
    const val = values[pos] ?? 0
    return Math.round(val * 10) / 10
  })
  for (let i = 1; i < cuts.length; i++) {
    const prev = cuts[i - 1] ?? 0
    if ((cuts[i] ?? 0) < prev) {
      cuts[i] = prev
    }
  }
  return cuts
}

export function frpStepIndex(value: number, cuts: number[]): number {
  if (value <= 0 || !cuts.length) return 0
  for (let i = 0; i < cuts.length; i++) {
    if (value <= (cuts[i] ?? Infinity)) return i
  }
  return FIRE_RAMP.length - 1
}

export function frpRampColor(value: number, cuts: number[]): string {
  const index = frpStepIndex(value, cuts)
  return FIRE_RAMP[index] ?? '#f6df7f'
}

export function frpStepLabels(cuts: number[]): string[] {
  const fmt = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1))
  return cuts.map((upper, index) => {
    const lower = index === 0 ? 0 : (cuts[index - 1] ?? 0)
    if (index === 0) return `0.0–${fmt(upper)}`
    if (lower >= upper) return `${fmt(upper)}`
    return `${fmt(lower)}–${fmt(upper)}`
  })
}

/** Five steps of the fire ramp, read against the peak of the current view. */
export function stepIndex(value: number, peak: number): number {
  if (value <= 0 || peak <= 0) return -1
  const step = Math.floor((value / peak) * FIRE_RAMP.length)
  return Math.min(FIRE_RAMP.length - 1, Math.max(0, step))
}

export function rampColor(value: number, peak: number): string {
  const index = stepIndex(value, peak)
  return index < 0 ? '#2c2b2f' : FIRE_RAMP[index] ?? '#f6df7f'
}

/** Ink that stays legible on a filled ramp step. */
export function rampInk(value: number, peak: number): string {
  return stepIndex(value, peak) >= 3 ? '#ffffff' : '#14100d'
}

/** Upper bound of each step, so the legend carries real numbers. */
export function stepCuts(peak: number): number[] {
  return FIRE_RAMP.map((_, index) => Math.ceil((peak * (index + 1)) / FIRE_RAMP.length))
}

export function stepLabels(peak: number): string[] {
  const cuts = stepCuts(peak)
  return cuts.map((upper, index) => {
    const lower = index === 0 ? 1 : (cuts[index - 1] ?? 0) + 1
    return lower >= upper ? `${upper}` : `${lower}–${upper}`
  })
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
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function monthShort(month: number): string {
  return MONTHS[month - 1] ?? ''
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

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Weekday index (0 = Sunday) of the first day of the month. */
export function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
}
