import {useMemo, useState} from 'react'
import type {CalendarAnomaly, CalendarClimatology, CalendarDay, CalendarMonth} from '../../lib/api'
import {
  FIRE_RAMP,
  dayNumber,
  daysInMonth,
  firstWeekday,
  formatCompact,
  formatCount,
  formatRange,
  monthFull,
  monthShort,
  rampColor,
  rampInk,
} from '../../lib/ramp'
import {TrendCharts} from './TrendCharts'

interface CalendarSheetProps {
  months: CalendarMonth[]
  days: CalendarDay[]
  climatology: CalendarClimatology[]
  anomaly: CalendarAnomaly[]
  selected: string | null
  onSelect: (day: string | null) => void
  from: string
  to: string
  rangeTo: string
  onClose: () => void
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export function CalendarSheet({
  months,
  days,
  climatology,
  anomaly,
  selected,
  onSelect,
  from,
  to,
  rangeTo,
  onClose,
}: CalendarSheetProps) {
  const defaultIso = selected ?? rangeTo
  const defaultYear = Number(defaultIso.slice(0, 4))
  const defaultMonth = Number(defaultIso.slice(5, 7))
  const [focusedYm, setFocusedYm] = useState<{year: number; month: number} | null>(null)

  const year = selected
    ? Number(selected.slice(0, 4))
    : (focusedYm?.year ?? defaultYear)
  const month = selected
    ? Number(selected.slice(5, 7))
    : (focusedYm?.month ?? defaultMonth)

  const years = useMemo(() => {
    const set = new Set<number>()
    for (const m of months) {
      if (Number.isFinite(m.year)) set.add(m.year)
    }
    if (!set.size && Number.isFinite(defaultYear)) {
      set.add(defaultYear)
    }
    return Array.from(set).sort((a, b) => b - a)
  }, [months, defaultYear])

  const minYear = years.length ? Math.min(...years) : defaultYear
  const maxYear = years.length ? Math.max(...years) : defaultYear
  const yearSpanLabel = minYear < maxYear ? `${minYear}-${maxYear}` : `2001-${maxYear}`
  const yearsExpected = Math.max(1, maxYear - 2001 + 1)

  const byDate = useMemo(() => new Map(days.map(day => [day.date, day.detections])), [days])
  const byMonth = useMemo(
    () => new Map(months.map(item => [`${item.year}-${item.month}`, item.detections])),
    [months],
  )
  const climByMonth = useMemo(
    () => new Map(climatology.map(item => [item.month, item.median_detections])),
    [climatology],
  )
  const anomalyByYm = useMemo(
    () => new Map(anomaly.map(item => [`${item.year}-${item.month}`, item.ratio])),
    [anomaly],
  )

  const monthDays = useMemo(() => {
    const prefix = `${year}-${String(month).padStart(2, '0')}-`
    return days.filter(d => d.date.startsWith(prefix))
  }, [days, year, month])

  const monthTotal = byMonth.get(`${year}-${month}`) ?? 0
  const dayPeak = monthDays.reduce((max, item) => Math.max(max, item.detections), 0)
  const monthPeak = months.reduce((max, item) => Math.max(max, item.detections), 0)
  const todayIso = new Date().toISOString().slice(0, 10)
  const lead = firstWeekday(year, month)
  const length = daysInMonth(year, month)

  const medianForMonth = climByMonth.get(month) ?? monthTotal
  const ratioForMonth =
    anomalyByYm.get(`${year}-${month}`) ??
    (medianForMonth > 0 ? Math.round((monthTotal / medianForMonth) * 100) / 100 : 0)

  const peakDay = monthDays.reduce<CalendarDay | null>(
    (best, day) => (!best || day.detections > best.detections ? day : best),
    null,
  )

  const cells: (number | null)[] = [
    ...Array.from({length: lead}, () => null),
    ...Array.from({length}, (_, index) => index + 1),
  ]

  return (
    <section className="calendar-sheet" aria-label="Burning activity calendar">
      <div className="sheet-bar">
        <div className="cal-head" style={{marginBottom: 0}}>
          <h2>Burning calendar ({yearSpanLabel})</h2>
          <span className="range">
            {years.length} {years.length === 1 ? 'year' : 'years'} · {formatRange(from, to)}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close burning calendar"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
        </button>
      </div>

      <div className="calendar-grid-wrap">
        <div>
          <div className="cal-head">
            <h2>Annual × monthly heatmap</h2>
            <span className="range">
              Rows = years, columns = months · click a cell to inspect
            </span>
          </div>

          <div className="multiyear-wrap" role="region" aria-label="Multi-year monthly burning heatmap">
            <div className="my-header">
              <span className="my-year-col">Year</span>
              {MONTH_NUMS.map(m => (
                <span key={m} className="my-month-col">
                  {monthShort(m)}
                </span>
              ))}
            </div>
            <div className="my-body">
              {years.map(y => (
                <div className="my-row" key={y}>
                  <span className="my-year-label num">{y}</span>
                  {MONTH_NUMS.map(m => {
                    const key = `${y}-${m}`
                    const count = byMonth.get(key)
                    const ratio = anomalyByYm.get(key)
                    const med = climByMonth.get(m)
                    const isFocused = y === year && m === month
                    return (
                      <button
                        type="button"
                        key={key}
                        className="mcell"
                        data-on={count ? 'true' : 'false'}
                        aria-current={isFocused ? 'true' : undefined}
                        onClick={() => setFocusedYm({year: y, month: m})}
                        style={
                          count
                            ? {
                                background: rampColor(count, monthPeak),
                                color: rampInk(count, monthPeak),
                              }
                            : undefined
                        }
                        title={
                          count
                            ? `${monthFull(m)} ${y}: ${formatCount(count)} hotspots (${(ratio ?? 1).toFixed(1)}x median ${formatCount(Math.round(med ?? count))})`
                            : `${monthFull(m)} ${y}: no detections`
                        }
                      >
                        <span className="v">{count ? formatCompact(count) : '—'}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="scale" aria-label="Viridis colour ramp legend">
            <span className="scale-label">Fewer</span>
            {FIRE_RAMP.map(color => (
              <span className="swatch" key={color} style={{background: color}} />
            ))}
            <span className="scale-label">
              More · Viridis ramp encodes monthly hotspots (up to {formatCount(monthPeak)})
            </span>
          </div>

          <p className="finding">
            {monthTotal > 0 ? (
              <>
                <b>
                  {monthFull(month)} {year}: {ratioForMonth.toFixed(1)}x the {yearSpanLabel} median for
                  this month
                </b>{' '}
                ({formatCount(monthTotal)} hotspots vs multi-year median{' '}
                {formatCount(Math.round(medianForMonth))}).
              </>
            ) : (
              'No hotspots recorded in this area for the selected month.'
            )}
          </p>
        </div>

        <div>
          <div className="cal-head">
            <h2>
              {monthFull(month)} {year} daily breakdown
            </h2>
            <span className="range">
              {formatCount(monthTotal)} hotspots · {monthDays.length} of {length} days active
            </span>
          </div>

          <div className="month-grid">
            {DOW.map(day => (
              <span className="dow" key={day}>
                {day}
              </span>
            ))}

            {cells.map((day, index) => {
              if (day === null) {
                return <span className="cell blank" key={`blank-${index}`} aria-hidden="true" />
              }
              const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
              const count = byDate.get(iso)
              const active = selected === iso
              return (
                <button
                  key={iso}
                  type="button"
                  className="cell"
                  data-on={count ? 'true' : 'false'}
                  data-partial={iso === todayIso ? 'true' : undefined}
                  aria-current={active ? 'true' : undefined}
                  disabled={count === undefined}
                  onClick={() => onSelect(active ? null : iso)}
                  title={
                    count === undefined
                      ? 'No data loaded for this day'
                      : `${iso}: ${formatCount(count)} hotspots`
                  }
                  style={
                    count
                      ? {background: rampColor(count, dayPeak), color: rampInk(count, dayPeak)}
                      : undefined
                  }
                >
                  {day}
                </button>
              )
            })}
          </div>

          <p className="note" style={{marginTop: 8}}>
            {peakDay ? (
              <>
                Peak day in {monthShort(month)} {year}:{' '}
                <b>
                  {dayNumber(peakDay.date)} {monthShort(month)}
                </b>{' '}
                with {formatCount(peakDay.detections)} hotspots (
                {Math.round((peakDay.detections / Math.max(monthTotal, 1)) * 100)}% of month).
              </>
            ) : (
              `Select another month cell in the ${yearSpanLabel} matrix to inspect its daily activity.`
            )}
          </p>
        </div>
      </div>

      <TrendCharts
        months={months}
        days={days}
        climatology={climatology}
        year={year}
        selected={selected}
        yearsLoaded={years.length}
        yearsExpected={yearsExpected}
      />
    </section>
  )
}
