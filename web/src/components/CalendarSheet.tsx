import type {CalendarDay, CalendarMonth} from '../../lib/api'
import {
  FIRE_RAMP,
  dayNumber,
  daysInMonth,
  firstWeekday,
  formatCount,
  formatRange,
  monthShort,
  rampColor,
  rampInk,
} from '../../lib/ramp'

interface CalendarSheetProps {
  months: CalendarMonth[]
  days: CalendarDay[]
  selected: string | null
  onSelect: (day: string | null) => void
  from: string
  to: string
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function CalendarSheet({months, days, selected, onSelect, from, to}: CalendarSheetProps) {
  const year = Number(to.slice(0, 4))
  const month = Number(to.slice(5, 7))
  const total = days.reduce((sum, day) => sum + day.detections, 0)
  const peak = days.reduce<CalendarDay | null>(
    (best, day) => (!best || day.detections > best.detections ? day : best),
    null,
  )
  const byDate = new Map(days.map(day => [day.date, day.detections]))
  const byMonth = new Map(months.map(item => [`${item.year}-${item.month}`, item.detections]))
  const monthTotal = byMonth.get(`${year}-${month}`) ?? 0
  const dayPeak = days.reduce((max, item) => Math.max(max, item.detections), 0)
  const monthPeak = months.reduce((max, item) => Math.max(max, item.detections), 0)
  const todayIso = new Date().toISOString().slice(0, 10)
  const lead = firstWeekday(year, month)
  const length = daysInMonth(year, month)

  const cells: (number | null)[] = [
    ...Array.from({length: lead}, () => null),
    ...Array.from({length}, (_, index) => index + 1),
  ]

  return (
    <section className="calendar" aria-label="Burning activity calendar">
      <div>
        <div className="cal-head">
          <h2>Burning calendar</h2>
          <span className="range">
            {monthShort(month)} {year} · {formatRange(from, to)}
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
                title={count === undefined ? 'No data loaded for this day' : `${formatCount(count)} hotspots`}
                style={count ? {background: rampColor(count, dayPeak), color: rampInk(count, dayPeak)} : undefined}
              >
                {day}
              </button>
            )
          })}
        </div>

        <div className="scale" aria-hidden="true">
          <span className="scale-label">Fewer</span>
          {FIRE_RAMP.map((color, index) => (
            <span className="swatch" key={color} style={{background: color}} />
          ))}
          <span className="scale-label">More · hotspots per day, up to {formatCount(dayPeak)}</span>
        </div>
      </div>

      <div>
        <div className="cal-head">
          <h2>Monthly totals</h2>
          <span className="range">
            {formatCount(monthTotal)} hotspots · {days.length} of {length} days loaded
          </span>
        </div>

        <div className="year-strip">
          {Array.from({length: 12}, (_, index) => index + 1).map(item => {
            const count = byMonth.get(`${year}-${item}`)
            return (
              <div
                className="mcell"
                key={item}
                data-on={count ? 'true' : 'false'}
                aria-current={item === month ? 'true' : undefined}
                style={count ? {background: rampColor(count, monthPeak), color: rampInk(count, monthPeak)} : undefined}
                title={count ? `${formatCount(count)} hotspots` : 'No data loaded'}
              >
                <span>{monthShort(item)}</span>
                <span className="v">{count ? formatCount(count) : '—'}</span>
              </div>
            )
          })}
        </div>

        <p className="finding">
          {peak ? (
            <>
              <b>{dayNumber(peak.date)} {monthShort(Number(peak.date.slice(5, 7)))}</b> carried the most
              hotspots in this window: {formatCount(peak.detections)} of {formatCount(total)} (
              {Math.round((peak.detections / Math.max(total, 1)) * 100)}%).
            </>
          ) : (
            'No hotspots in this area for the loaded window.'
          )}
        </p>
        <p className="note">
          Monthly history starts with the loaded FIRMS window, so no earlier year is available to compare
          against yet. Every month cell stays empty until its days are imported.
        </p>
      </div>
    </section>
  )
}
