import type {CalendarDay} from '../../lib/api'
import {dayNumber, formatCount, formatRange, monthShort, rampColor, weekdayShort} from '../../lib/ramp'

interface TimelineBarProps {
  days: CalendarDay[]
  selected: string | null
  onSelect: (day: string | null) => void
  from: string
  to: string
  playing: boolean
  onPlay: () => void
  calendarOpen: boolean
  onToggleCalendar: () => void
}

export function TimelineBar({
  days,
  selected,
  onSelect,
  from,
  to,
  playing,
  onPlay,
  calendarOpen,
  onToggleCalendar,
}: TimelineBarProps) {
  const peak = days.reduce((max, day) => Math.max(max, day.detections), 1)
  const today = new Date().toISOString().slice(0, 10)
  const partial = to === today ? today : null

  return (
    <footer className="timeline" aria-label="Day timeline">
      <div className="tl-caption">
        <span className="m">{selected ? 'Selected day' : 'Loaded window'}</span>
        <span className="d">{selected ? formatDayShort(selected) : formatRange(from, to)}</span>
        {partial && <span className="m">{formatDayShort(partial)} still filling</span>}
      </div>

      <div className="tl-days" role="group" aria-label="Days with hotspots">
        <button
          type="button"
          className="day"
          aria-pressed={selected === null}
          onClick={() => onSelect(null)}
        >
          <span className="wd">All {days.length} days</span>
          <span className="dn">{formatCount(days.reduce((sum, day) => sum + day.detections, 0))}</span>
          <span className="cnt">hotspots</span>
          <span className="bar">
            <span style={{width: '100%', background: 'var(--muted)'}} />
          </span>
        </button>

        {days.map(day => (
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

      <div className="tl-actions">
        <button type="button" className="btn" aria-pressed={playing} onClick={onPlay}>
          {playing ? 'Pause' : 'Play days'}
        </button>
        <button
          type="button"
          className="btn"
          aria-pressed={calendarOpen}
          onClick={onToggleCalendar}
        >
          Burning calendar
        </button>
      </div>
    </footer>
  )
}

function formatDayShort(iso: string): string {
  return `${weekdayShort(iso)} ${dayNumber(iso)} ${monthShort(Number(iso.slice(5, 7)))}`
}
