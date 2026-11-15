import {useEffect, useMemo, useRef, useState} from 'react'
import type {CalendarClimatology, CalendarMonth} from '../../lib/api'
import {formatCompact, formatCount, monthFull, monthShort} from '../../lib/ramp'
import {
  monthlySeries,
  otherYear,
  seriesTotal,
  yearsOnRecord,
  type MonthSeries,
} from '../../lib/trends'

/**
 * Three small SVG charts for the burning calendar: two selectable years side by side (bars and
 * line, drawn on one shared scale so the pair can be compared month by month), and the daily
 * counts of the current month. Drawn by hand (no chart library) to the app's chart rules: one
 * hue on the data that matters, 3-4 quiet gridlines, a dashed reference line for the median,
 * an honest readout under each plot instead of a floating tooltip.
 */

const PLOT_HEIGHT = 148
const PAD_TOP = 12
const PAD_BOTTOM = 22
const MONTHS = Array.from({length: 12}, (_, index) => index + 1)

const BAR_MUTED = 'var(--control)'
const BAR_ACTIVE = 'var(--fire-4)'
const LINE_ACTIVE = 'var(--fire-4)'
const REFERENCE = 'var(--muted)'

interface TrendProps {
  months: CalendarMonth[]
  climatology: CalendarClimatology[]
  year: number
  yearsLoaded: number
  yearsExpected: number
}

/** Measured width of the plot container, so labels never stretch with the viewBox. */
function useWidth() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => setWidth(node.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** Round axis steps whose top sits above the largest value. */
function axisTicks(max: number, count = 3): number[] {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(size => size >= raw) ?? 10 * magnitude
  let top = Math.ceil(max / step) * step
  if (top <= max) top += step
  const ticks: number[] = []
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(Number(value.toFixed(6)))
  return ticks
}

/** Every k-th label, with one step all the way — never two labels touching. */
function labelStep(count: number, width: number): number {
  if (count <= 1) return 1
  const room = Math.max(1, Math.floor(width / 46))
  return Math.max(1, Math.ceil(count / room))
}

function Axes({
  ticks,
  y,
  x,
  labels,
  step,
  padL,
  width,
}: {
  ticks: number[]
  y: (value: number) => number
  x: (index: number) => number
  labels: string[]
  step: number
  padL: number
  width: number
}) {
  return (
    <g>
      {ticks.map(tick => (
        <g key={tick}>
          <line x1={padL} x2={width} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth={1} />
          <text x={padL - 6} y={y(tick) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
            {formatCompact(tick)}
          </text>
        </g>
      ))}
      {labels.map((label, index) =>
        index % step === 0 ? (
          <text
            key={`${label}-${index}`}
            x={x(index)}
            y={PLOT_HEIGHT - PAD_BOTTOM + 15}
            textAnchor={index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'}
            fontSize={11}
            fill="var(--muted)"
          >
            {label}
          </text>
        ) : null,
      )}
    </g>
  )
}

function EmptyPlot({message}: {message: string}) {
  return (
    <svg viewBox={`0 0 320 ${PLOT_HEIGHT}`} width="100%" height={PLOT_HEIGHT} role="img" aria-label={message}>
      <line x1={0} x2={320} y1={PLOT_HEIGHT - PAD_BOTTOM} y2={PLOT_HEIGHT - PAD_BOTTOM} stroke="var(--border)" />
      <text x={0} y={PLOT_HEIGHT / 2} fontSize={12} fill="var(--muted)">
        {message}
      </text>
    </svg>
  )
}

/** Geometry shared by the year charts, so both plots line up month for month. */
function useYearPlot(ticks: number[], top: number) {
  const [ref, width] = useWidth()
  const w = Math.max(240, width)
  const padL = 8 + Math.max(...ticks.map(tick => formatCompact(tick).length)) * 7
  const innerWidth = w - padL - 4
  const band = innerWidth / 12
  const x = (index: number) => padL + band * index + band / 2
  const y = (value: number) => PAD_TOP + (PLOT_HEIGHT - PAD_TOP - PAD_BOTTOM) * (1 - value / top)
  const labels = MONTHS.map(month => monthShort(month))
  return {ref, w, padL, innerWidth, band, x, y, labels}
}

/** Invisible full-height columns: hovering anywhere in a month reports that month. */
function HitColumns({
  padL,
  band,
  onHover,
  year,
  series,
}: {
  padL: number
  band: number
  onHover: (month: number | null) => void
  year: number
  series: MonthSeries
}) {
  return (
    <g>
      {MONTHS.map((month, index) => {
        const value = series[index] ?? null
        return (
          <rect
            key={`hit-${month}`}
            x={padL + band * index}
            y={PAD_TOP}
            width={band}
            height={PLOT_HEIGHT - PAD_TOP - PAD_BOTTOM}
            fill="transparent"
            onMouseEnter={() => onHover(month)}
          >
            <title>{value === null ? `${monthFull(month)} ${year}: no data` : `${monthFull(month)} ${year}: ${formatCount(value)} hotspots`}</title>
          </rect>
        )
      })}
    </g>
  )
}

/** One bar per month of the selected year. */
function YearBars({
  year,
  series,
  ticks,
  top,
  hovered,
  onHover,
}: {
  year: number
  series: MonthSeries
  ticks: number[]
  top: number
  hovered: number | null
  onHover: (month: number | null) => void
}) {
  const plot = useYearPlot(ticks, top)
  const loaded = series.some(value => value !== null)
  const barWidth = Math.max(3, Math.min(26, plot.band * 0.58))

  return (
    <div ref={plot.ref} className="trend-plot">
      {!loaded ? (
        <EmptyPlot message={`No monthly data for ${year}.`} />
      ) : (
        <svg
          viewBox={`0 0 ${plot.w} ${PLOT_HEIGHT}`}
          width="100%"
          height={PLOT_HEIGHT}
          role="img"
          aria-label={`Hotspots per month in ${year}`}
          onMouseLeave={() => onHover(null)}
        >
          <Axes
            ticks={ticks}
            y={plot.y}
            x={plot.x}
            labels={plot.labels}
            step={labelStep(12, plot.innerWidth)}
            padL={plot.padL}
            width={plot.w}
          />
          {hovered !== null ? (
            <line
              x1={plot.x(hovered - 1)}
              x2={plot.x(hovered - 1)}
              y1={PAD_TOP}
              y2={PLOT_HEIGHT - PAD_BOTTOM}
              stroke="var(--border)"
              strokeWidth={1}
            />
          ) : null}
          {series.map((value, index) =>
            value === null ? null : (
              <rect
                key={MONTHS[index]}
                x={plot.x(index) - barWidth / 2}
                y={plot.y(value)}
                width={barWidth}
                height={Math.max(0, plot.y(0) - plot.y(value))}
                fill={BAR_ACTIVE}
                opacity={hovered === null || hovered === index + 1 ? 1 : 0.45}
              />
            ),
          )}
          <HitColumns padL={plot.padL} band={plot.band} onHover={onHover} year={year} series={series} />
        </svg>
      )}
    </div>
  )
}

/** The month-by-month curve of the selected year against the multi-year median. */
function YearLine({
  year,
  series,
  medians,
  ticks,
  top,
  hovered,
  onHover,
}: {
  year: number
  series: MonthSeries
  medians: number[]
  ticks: number[]
  top: number
  hovered: number | null
  onHover: (month: number | null) => void
}) {
  const plot = useYearPlot(ticks, top)
  const loaded = series.some(value => value !== null)

  const yearPath = series
    .map((value, index) => {
      if (value === null) return null
      const previous = series[index - 1] ?? null
      return `${index === 0 || previous === null ? 'M' : 'L'}${plot.x(index).toFixed(1)} ${plot.y(value).toFixed(1)}`
    })
    .filter(Boolean)
    .join('')
  const medianPath = medians
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${plot.x(index).toFixed(1)} ${plot.y(value).toFixed(1)}`)
    .join('')
  const hoveredValue = hovered === null ? null : (series[hovered - 1] ?? null)

  return (
    <div ref={plot.ref} className="trend-plot">
      {!loaded ? (
        <EmptyPlot message={`No monthly data for ${year}.`} />
      ) : (
        <svg
          viewBox={`0 0 ${plot.w} ${PLOT_HEIGHT}`}
          width="100%"
          height={PLOT_HEIGHT}
          role="img"
          aria-label={`Monthly hotspots in ${year} against the multi-year median`}
          onMouseLeave={() => onHover(null)}
        >
          <Axes
            ticks={ticks}
            y={plot.y}
            x={plot.x}
            labels={plot.labels}
            step={labelStep(12, plot.innerWidth)}
            padL={plot.padL}
            width={plot.w}
          />
          <path d={medianPath} fill="none" stroke={REFERENCE} strokeWidth={1} strokeDasharray="4 4" />
          <path d={yearPath} fill="none" stroke={LINE_ACTIVE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hovered !== null ? (
            <line
              x1={plot.x(hovered - 1)}
              x2={plot.x(hovered - 1)}
              y1={PAD_TOP}
              y2={PLOT_HEIGHT - PAD_BOTTOM}
              stroke="var(--border)"
              strokeWidth={1}
            />
          ) : null}
          {hovered !== null && hoveredValue !== null ? (
            <circle cx={plot.x(hovered - 1)} cy={plot.y(hoveredValue)} r={4} fill={LINE_ACTIVE} />
          ) : null}
          <HitColumns padL={plot.padL} band={plot.band} onHover={onHover} year={year} series={series} />
        </svg>
      )}
    </div>
  )
}

function Legend({dashed}: {dashed: string}) {
  return (
    <span className="trend-legend">
      <span className="trend-key">
        <svg width="16" height="8" aria-hidden="true">
          <line x1="0" x2="16" y1="4" y2="4" stroke={REFERENCE} strokeWidth="1" strokeDasharray="4 4" />
        </svg>
        {dashed}
      </span>
    </span>
  )
}

function YearPick({
  years,
  value,
  onChange,
  label,
}: {
  years: number[]
  value: number
  onChange: (year: number) => void
  label: string
}) {
  return (
    <label className="trend-pick">
      Year
      <select value={value} onChange={event => onChange(Number(event.target.value))} aria-label={label}>
        {years.map(item => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  )
}

function yearNote(series: MonthSeries, year: number): string {
  const {total, months} = seriesTotal(series)
  if (months === 0) return `No monthly data for ${year}.`
  if (months === 12) return `${formatCount(total)} hotspots in ${year}`
  return `${formatCount(total)} hotspots in ${year} · ${months} of 12 months with data`
}

function monthNote(month: number, year: number, value: number | null): string {
  return value === null
    ? `${monthFull(month)} ${year} — no data`
    : `${monthFull(month)} ${year} — ${formatCount(value)} hotspots`
}

export function TrendCharts({months, climatology, year, yearsLoaded, yearsExpected}: TrendProps) {
  const years = useMemo(() => yearsOnRecord(months, year), [months, year])
  const yearsKey = years.join(',')
  const [yearA, setYearA] = useState(year)
  const [yearB, setYearB] = useState(() => otherYear(years, year))
  const [hoverMonth, setHoverMonth] = useState<number | null>(null)

  // Both picks follow the inspected period: a new heatmap cell resets them to that year
  // and its nearest neighbour on record.
  useEffect(() => {
    const next = yearsOnRecord(months, year)
    setYearA(next.includes(year) ? year : (next[0] ?? year))
    setYearB(otherYear(next, year))
    setHoverMonth(null)
  }, [year, yearsKey])

  const seriesA = useMemo(() => monthlySeries(months, yearA), [months, yearA])
  const seriesB = useMemo(() => monthlySeries(months, yearB), [months, yearB])
  const medians = useMemo(() => {
    const byMonth = new Map<number, number>()
    for (const item of climatology) byMonth.set(item.month, item.median_detections)
    return MONTHS.map(month => byMonth.get(month) ?? 0)
  }, [climatology])

  const peak = Math.max(...seriesA.map(value => value ?? 0), ...seriesB.map(value => value ?? 0), ...medians, 0)
  const ticks = axisTicks(peak, 3)
  const top = ticks[ticks.length - 1] ?? 1

  const readoutA =
    hoverMonth === null ? yearNote(seriesA, yearA) : monthNote(hoverMonth, yearA, seriesA[hoverMonth - 1] ?? null)
  const readoutB =
    hoverMonth === null
      ? yearNote(seriesB, yearB)
      : `${monthNote(hoverMonth, yearB, seriesB[hoverMonth - 1] ?? null)} · median ${formatCount(
          Math.round(medians[hoverMonth - 1] ?? 0),
        )}`

  const partial = yearsLoaded < yearsExpected

  return (
    <section className="cal-trends" aria-label="Trend charts">
      <div className="cal-head">
        <h2>Trends</h2>
        <span className="range">
          {partial ? `${yearsLoaded} of ${yearsExpected} years with data` : `${yearsLoaded} years`}
        </span>
      </div>

      <div className="trend-grid">
        <figure className="trend-card">
          <figcaption>
            <h3>Monthly counts</h3>
            <YearPick years={years} value={yearA} onChange={setYearA} label="First year to compare" />
          </figcaption>
          <YearBars
            year={yearA}
            series={seriesA}
            ticks={ticks}
            top={top}
            hovered={hoverMonth}
            onHover={setHoverMonth}
          />
          <p className="trend-readout" data-live={hoverMonth !== null ? 'true' : 'false'} aria-live="polite">
            {readoutA}
          </p>
        </figure>

        <figure className="trend-card">
          <figcaption>
            <h3>Season curve</h3>
            <YearPick years={years} value={yearB} onChange={setYearB} label="Second year to compare" />
            <Legend dashed="median of all years" />
          </figcaption>
          <YearLine
            year={yearB}
            series={seriesB}
            medians={medians}
            ticks={ticks}
            top={top}
            hovered={hoverMonth}
            onHover={setHoverMonth}
          />
          <p className="trend-readout" data-live={hoverMonth !== null ? 'true' : 'false'} aria-live="polite">
            {readoutB}
          </p>
        </figure>
      </div>
    </section>
  )
}
