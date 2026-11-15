import type {CalendarDay} from '../../lib/api'
import {dayNumber, formatCount, formatRange, monthShort, rampColor, weekdayShort} from '../../lib/ramp'
import type {TimeRangePreset} from './ControlPanel'

interface TimelineBarProps {
  days: CalendarDay[]
  selected: string | null
  rangePreset: TimeRangePreset
  onSelect: (day: string | null) => void
  onRangePreset: (preset: '24h' | '3d' | '7d') => void
  from: string
  to: string
  playing: boolean
  onPlay: () => void
  onClose: () => void
}

export function TimelineBar({
  days,
  selected,
  rangePreset,
  onSelect,
  onRangePreset,
  from,
  to,
  playing,
  onPlay,
  onClose,
}: TimelineBarProps) {
  // Only days inside the active window belong to the strip: the calendar payload can
  // carry days outside it, and mixing them in made the strip total disagree with the panel.
  const windowDays = days.filter(day => day.date >= from && day.date <= to)
  const peak = windowDays.reduce((max, day) => Math.max(max, day.detections), 1)
  const windowTotal = windowDays.reduce((sum, day) => sum + day.detections, 0)
  const today = new Date().toISOString().slice(0, 10)
  const partial = to === today ? today : null

  // Step one day through the strip. The strip only lists days with data, so a
  // step lands on the next recorded day; with nothing selected the arrows start
  // at the newest day.
  const selectedIndex = selected ? windowDays.findIndex(item => item.date === selected) : -1
  const prevDay = selected
    ? selectedIndex >= 0
      ? days[selectedIndex - 1]
      : windowDays.filter(item => item.date < selected).at(-1)
    : windowDays[windowDays.length - 2]
  const nextDay = selected
    ? selectedIndex >= 0
      ? days[selectedIndex + 1]
      : windowDays.find(item => item.date > selected)
    : windowDays[windowDays.length - 1]

  return (
    <section className="timeline-strip" aria-label="Day timeline">
      <div className="tl-caption">
        <span className="m">
          {rangePreset === '24h'
            ? '24HRS window'
            : rangePreset === '3d'
              ? '3 DAYS window'
              : selected
                ? 'Selected day'
                : 'Current window'}
        </span>
        <span className="d">{selected ? formatDayShort(selected) : formatRange(from, to)}</span>
        {partial && <span className="m">{formatDayShort(partial)} still filling</span>}
      </div>

      <div className="tl-nav">
        <button
          type="button"
          className="tl-arrow"
          onClick={() => prevDay && onSelect(prevDay.date)}
          disabled={!prevDay}
          aria-label={prevDay ? `Previous day, ${formatDayShort(prevDay.date)}` : 'Previous day'}
          title={prevDay ? formatDayShort(prevDay.date) : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="tl-days" role="group" aria-label="Days with hotspots">
          <button
            type="button"
            className="day"
            aria-pressed={selected === null && rangePreset === '7d'}
            onClick={() => onSelect(null)}
          >
            <span className="wd">All {windowDays.length} days</span>
            <span className="dn">{formatCount(windowTotal)}</span>
            <span className="cnt">hotspots</span>
            <span className="bar">
              <span style={{width: '100%', background: 'var(--muted)'}} />
            </span>
          </button>

          {windowDays.map(day => (
            <button
              key={day.date}
              type="button"
              className="day"
              aria-pressed={selected === day.date}
              data-partial={partial === day.date ? 'true' : undefined}
              onClick={() => onSelect(day.date)}
            >
              <span className="wd">
                {weekdayShort(day.date)}
                {partial === day.date ? ' · today' : ''}
              </span>
              <span className="dn">{dayNumber(day.date)}</span>
              <span className="cnt">{formatCount(day.detections)}</span>
              <span className="bar">
                <span
                  style={{
                    width: `${Math.max(4, Math.round((day.detections / peak) * 100))}%`,
                    background: rampColor(day.detections, peak),
                  }}
                />
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="tl-arrow"
          onClick={() => nextDay && onSelect(nextDay.date)}
          disabled={!nextDay}
          aria-label={nextDay ? `Next day, ${formatDayShort(nextDay.date)}` : 'Next day'}
          title={nextDay ? formatDayShort(nextDay.date) : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M5 2l5 5-5 5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="tl-actions">
        <button
          type="button"
          className="btn"
          aria-pressed={rangePreset === '24h'}
          onClick={() => onRangePreset('24h')}
        >
          24HRS
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={rangePreset === '3d'}
          onClick={() => onRangePreset('3d')}
        >
          3 DAYS
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={rangePreset === '7d'}
          onClick={() => onRangePreset('7d')}
        >
          7 DAYS
        </button>
        <button type="button" className="btn" aria-pressed={playing} onClick={onPlay}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close timeline"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
        </button>
      </div>
    </section>
  )
}

function formatDayShort(iso: string): string {
  return `${weekdayShort(iso)} ${dayNumber(iso)} ${monthShort(Number(iso.slice(5, 7)))}`
}
