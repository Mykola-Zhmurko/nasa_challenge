import {useEffect, useLayoutEffect, useRef, useState} from 'react'
import type {KeyboardEvent as ReactKeyboardEvent} from 'react'
import {createPortal} from 'react-dom'
import {formatDay} from '../../lib/ramp'
import {
  MONTH_NAMES,
  WEEKDAYS,
  daysInMonth,
  isoOf,
  monthCells,
  monthKey,
  partsOf,
  shiftDay,
  shiftMonth,
  weekdayOf,
} from '../../lib/dategrid'

interface DateRangePickerProps {
  from: string
  to: string
  min: string
  max: string
  onChange: (from: string, to: string) => void
}

type Side = 'from' | 'to'

const POPOVER_GAP = 6
const SCREEN_EDGE = 8

function CalendarIcon() {
  return (
    <svg className="range-field-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="1" y="2.2" width="10" height="8.8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M1 5h10M3.6 1v2.2M8.4 1v2.2" stroke="currentColor" strokeWidth="1.1" fill="none" />
    </svg>
  )
}

function Chevron({direction}: {direction: 'prev' | 'next'}) {
  return (
    <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d={direction === 'prev' ? 'M7.5 2.5L4 6l3.5 3.5' : 'M4.5 2.5L8 6l-3.5 3.5'}
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * The two date fields plus a range calendar. The fields always show the active
 * window; clicking one opens the calendar with that end as the moving one, and
 * picking a second day applies the window.
 */
export function DateRangePicker({from, to, min, max, onChange}: DateRangePickerProps) {
  const [side, setSide] = useState<Side | null>(null)
  const [draft, setDraft] = useState({start: from, end: to})
  const [step, setStep] = useState<Side>('from')
  const [view, setView] = useState<{year: number; month: number}>(() => {
    const month = partsOf(from)
    return {year: month.year, month: month.month}
  })

  const [hover, setHover] = useState<string | null>(null)
  const [focusDay, setFocusDay] = useState(from)
  const [position, setPosition] = useState<{left: number; top: number} | null>(null)

  const rowRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const dayRefs = useRef(new Map<string, HTMLButtonElement>())

  const firstMonth = partsOf(min)
  const lastMonth = partsOf(max)
  const today = new Date().toISOString().slice(0, 10)

  const apply = (start: string, end: string) => {
    if (start !== from || end !== to) onChange(start, end)
    setSide(null)
    setHover(null)
  }

  /** Read by the listeners that outlive a render (outside click, Escape). */
  const applyLatest = useRef(() => {})
  applyLatest.current = () => apply(draft.start, draft.end)

  const openAt = (next: Side) => {
    const start = next === 'from' ? from : to
    const month = partsOf(start)
    setDraft({start: from, end: to})
    setStep(next)
    setView({year: month.year, month: month.month})
    setFocusDay(start)
    setHover(null)
    setPosition(null)
    setSide(next)
  }

  const toggle = (next: Side) => {
    if (side === next) applyLatest.current()
    else openAt(next)
  }

  const pick = (day: string) => {
    if (day < min || day > max) return
    setFocusDay(day)
    if (step === 'from') {
      setDraft({start: day, end: draft.end < day ? day : draft.end})
      setStep('to')
      return
    }
    const start = draft.start <= day ? draft.start : day
    const end = draft.start <= day ? day : draft.start
    setDraft({start, end})
    apply(start, end)
  }

  const goToMonth = (year: number, month: number) => {
    setView({year, month})
    setFocusDay(isoOf(year, month, Math.min(partsOf(focusDay).day, daysInMonth(year, month))))
  }

  const stepMonth = (delta: number) => {
    const next = shiftMonth(view.year, view.month, delta)
    goToMonth(next.year, next.month)
  }

  const pickToday = () => {
    setDraft({start: max, end: max})
    setStep('to')
    goToMonth(lastMonth.year, lastMonth.month)
    setFocusDay(max)
  }

  // Place the popover under the fields, above them when the screen ends.
  useLayoutEffect(() => {
    if (!side) return
    const place = () => {
      const row = rowRef.current?.getBoundingClientRect()
      const popover = popoverRef.current
      if (!row || !popover) return
      const width = popover.offsetWidth
      const height = popover.offsetHeight
      const left = Math.max(SCREEN_EDGE, Math.min(row.left, window.innerWidth - width - SCREEN_EDGE))
      const below = row.bottom + POPOVER_GAP
      const above = row.top - height - POPOVER_GAP
      const top =
        below + height <= window.innerHeight - SCREEN_EDGE
          ? below
          : above >= SCREEN_EDGE
            ? above
            : Math.max(SCREEN_EDGE, window.innerHeight - height - SCREEN_EDGE)
      setPosition({left, top})
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [side, view.year, view.month])

  // A click outside or Escape keeps the picked window and closes the popover.
  useEffect(() => {
    if (!side) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target) || rowRef.current?.contains(target)) return
      applyLatest.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') applyLatest.current()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [side])

  // Keep the keyboard cursor on a real button after every move.
  useEffect(() => {
    if (!side) return
    dayRefs.current.get(focusDay)?.focus()
  }, [side, focusDay, view.year, view.month])

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let dayDelta = 0
    let monthDelta = 0
    if (event.key === 'ArrowLeft') dayDelta = -1
    else if (event.key === 'ArrowRight') dayDelta = 1
    else if (event.key === 'ArrowUp') dayDelta = -7
    else if (event.key === 'ArrowDown') dayDelta = 7
    else if (event.key === 'PageUp') monthDelta = -1
    else if (event.key === 'PageDown') monthDelta = 1
    else if (event.key === 'Home') dayDelta = -weekdayOf(focusDay)
    else if (event.key === 'End') dayDelta = 6 - weekdayOf(focusDay)
    else return

    event.preventDefault()
    let target: string
    if (monthDelta) {
      const {year, month, day} = partsOf(focusDay)
      const next = shiftMonth(year, month, monthDelta)
      target = isoOf(next.year, next.month, Math.min(day, daysInMonth(next.year, next.month)))
    } else {
      target = shiftDay(focusDay, dayDelta)
    }
    if (target < min) target = min
    if (target > max) target = max
    const month = partsOf(target)
    setView({year: month.year, month: month.month})
    setFocusDay(target)
  }

  // The band follows the hovered day while the end is being chosen.
  const rangeEnd = step === 'to' && hover ? hover : draft.end
  const low = draft.start <= rangeEnd ? draft.start : rangeEnd
  const high = draft.start <= rangeEnd ? rangeEnd : draft.start
  const cells = monthCells(view.year, view.month)
  const canGoBack = monthKey(view.year, view.month) > monthKey(firstMonth.year, firstMonth.month)
  const canGoForward = monthKey(view.year, view.month) < monthKey(lastMonth.year, lastMonth.month)
  const years: number[] = []
  for (let year = firstMonth.year; year <= lastMonth.year; year += 1) years.push(year)

  const fields: {side: Side; label: string; value: string}[] = [
    {side: 'from', label: 'From', value: from},
    {side: 'to', label: 'To', value: to},
  ]

  return (
    <div className="range-dates" ref={rowRef}>
      {fields.map(field => (
        <div className="range-date" key={field.side}>
          <span>{field.label}</span>
          <button
            type="button"
            className={side === field.side ? 'range-field is-active' : 'range-field'}
            aria-haspopup="dialog"
            aria-expanded={side === field.side}
            aria-label={`${field.side === 'from' ? 'Start' : 'End'} date, ${formatDay(field.value)}`}
            onClick={() => toggle(field.side)}
          >
            <span className="range-field-value">{formatDay(field.value)}</span>
            <CalendarIcon />
          </button>
        </div>
      ))}

      {side &&
        createPortal(
          <div
            className="dp"
            ref={popoverRef}
            role="dialog"
            aria-label="Choose date range"
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              opacity: position ? 1 : 0,
              pointerEvents: position ? 'auto' : 'none',
            }}
          >
            <div className="dp-head">
              <button
                type="button"
                className="dp-nav"
                aria-label="Previous month"
                disabled={!canGoBack}
                onClick={() => stepMonth(-1)}
              >
                <Chevron direction="prev" />
              </button>
              <div className="dp-title">
                <select
                  aria-label="Month"
                  value={view.month}
                  onChange={event => goToMonth(view.year, Number(event.target.value))}
                >
                  {MONTH_NAMES.map((name, index) => (
                    <option key={name} value={index}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Year"
                  value={view.year}
                  onChange={event => goToMonth(Number(event.target.value), view.month)}
                >
                  {years.map(year => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="dp-nav"
                aria-label="Next month"
                disabled={!canGoForward}
                onClick={() => stepMonth(1)}
              >
                <Chevron direction="next" />
              </button>
            </div>

            <div className="dp-week" aria-hidden="true">
              {WEEKDAYS.map(name => (
                <span key={name}>{name}</span>
              ))}
            </div>

            <div className="dp-grid" onKeyDown={onGridKeyDown} onMouseLeave={() => setHover(null)}>
              {cells.map((day, index) => {
                if (!day) return <span className="dp-blank" key={`blank-${index}`} />
                const outside = day < min || day > max
                const inRange = !outside && day >= low && day <= high
                const isEdge = inRange && (day === low || day === high)
                const single = low === high
                const classes = ['dp-day']
                if (inRange && day === low) classes.push('is-low')
                if (inRange && day === high) classes.push('is-high')
                if (isEdge) classes.push('is-edge')
                if (inRange && single) classes.push('is-single')
                if (day === today) classes.push('is-today')
                if (outside) classes.push('is-out')
                return (
                  <button
                    type="button"
                    key={day}
                    ref={node => {
                      if (node) dayRefs.current.set(day, node)
                      else dayRefs.current.delete(day)
                    }}
                    className={classes.join(' ')}
                    tabIndex={day === focusDay ? 0 : -1}
                    aria-label={formatDay(day)}
                    aria-current={day === today ? 'date' : undefined}
                    disabled={outside}
                    onClick={() => pick(day)}
                    onMouseEnter={() => setHover(day)}
                  >
                    {!single && inRange && <span className="dp-band" aria-hidden="true" />}
                    <span className="dp-num">{partsOf(day).day}</span>
                  </button>
                )
              })}
            </div>

            <div className="dp-foot">
              <button type="button" className="dp-link" onClick={pickToday}>
                Today
              </button>
              <button type="button" className="dp-done" onClick={() => applyLatest.current()}>
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
