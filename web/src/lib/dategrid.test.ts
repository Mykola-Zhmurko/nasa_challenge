import {describe, expect, it} from 'vitest'
import {
  daysBetween,
  daysInMonth,
  isoOf,
  monthCells,
  monthKey,
  monthLabel,
  partsOf,
  shiftDay,
  shiftMonth,
  weekdayOf,
} from '../../lib/dategrid'

describe('dategrid', () => {
  it('builds and reads ISO dates', () => {
    expect(isoOf(2026, 10, 1)).toBe('2026-11-01')
    expect(isoOf(2026, 0, 9)).toBe('2026-01-09')
    expect(partsOf('2026-11-14')).toEqual({year: 2026, month: 10, day: 14})
  })

  it('counts Monday as the first weekday', () => {
    expect(weekdayOf('2026-11-02')).toBe(0)
    expect(weekdayOf('2026-11-01')).toBe(6)
    expect(weekdayOf('2026-11-14')).toBe(5)
  })

  it('pads a month grid to whole weeks', () => {
    const cells = monthCells(2026, 10)
    expect(cells.length).toBe(42)
    expect(cells[6]).toBe('2026-11-01')
    expect(cells[35]).toBe('2026-11-30')
    expect(cells.filter(cell => cell === null).length).toBe(12)
  })

  it('starts a month that begins on a Monday without a gap', () => {
    const cells = monthCells(2026, 5)
    expect(cells[0]).toBe('2026-06-01')
    expect(cells.length % 7).toBe(0)
  })

  it('knows month lengths', () => {
    expect(daysInMonth(2024, 1)).toBe(29)
    expect(daysInMonth(2026, 1)).toBe(28)
    expect(daysInMonth(2026, 10)).toBe(30)
  })

  it('moves months across year borders', () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({year: 2025, month: 11})
    expect(shiftMonth(2026, 11, 1)).toEqual({year: 2027, month: 0})
    expect(shiftMonth(2026, 10, 0)).toEqual({year: 2026, month: 10})
  })

  it('moves days and counts an inclusive span', () => {
    expect(shiftDay('2026-11-30', 1)).toBe('2026-12-01')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(daysBetween('2026-11-11', '2026-11-14')).toBe(4)
    expect(daysBetween('2026-11-14', '2026-11-11')).toBe(4)
    expect(daysBetween('2026-11-11', '2026-11-11')).toBe(1)
  })

  it('labels months and keys them in order', () => {
    expect(monthLabel(2026, 10)).toBe('November 2026')
    expect(monthKey(2026, 0)).toBeGreaterThan(monthKey(2025, 11))
  })
})
