import {describe, expect, it} from 'vitest'
import {currentMonthWindow, monthlySeries, otherYear, seriesTotal, yearsOnRecord} from '../../lib/trends'

const months = [
  {year: 2001, month: 1, detections: 10, mean_frp: 5},
  {year: 2001, month: 11, detections: 90, mean_frp: 5},
  {year: 2020, month: 7, detections: 40, mean_frp: 5},
  {year: 2026, month: 11, detections: 291_287, mean_frp: 15.6},
]

describe('yearsOnRecord', () => {
  it('lists the loaded years newest first', () => {
    expect(yearsOnRecord(months, 2026)).toEqual([2026, 2020, 2001])
  })

  it('falls back to the focused year when nothing is loaded', () => {
    expect(yearsOnRecord([], 2026)).toEqual([2026])
  })
})

describe('monthlySeries', () => {
  it('returns twelve slots with null where a month is not loaded', () => {
    const series = monthlySeries(months, 2001)
    expect(series).toHaveLength(12)
    expect(series[0]).toBe(10)
    expect(series[10]).toBe(90)
    expect(series[1]).toBeNull()
  })

  it('keeps an unloaded year empty instead of zero-filled', () => {
    expect(monthlySeries(months, 2015).every(value => value === null)).toBe(true)
  })
})

describe('seriesTotal', () => {
  it('sums only the loaded months and counts them', () => {
    expect(seriesTotal(monthlySeries(months, 2001))).toEqual({total: 100, months: 2})
  })

  it('reports an empty series as zero months, not zero fires', () => {
    expect(seriesTotal(monthlySeries(months, 2015))).toEqual({total: 0, months: 0})
  })
})

describe('otherYear', () => {
  const years = [2026, 2020, 2001]

  it('picks the nearest older year for the second chart', () => {
    expect(otherYear(years, 2026)).toBe(2020)
    expect(otherYear(years, 2020)).toBe(2001)
  })

  it('falls back to the nearest newer year for the oldest one', () => {
    expect(otherYear(years, 2001)).toBe(2020)
  })

  it('stays on the same year when it is the only one', () => {
    expect(otherYear([2026], 2026)).toBe(2026)
  })
})

describe('currentMonthWindow', () => {
  const days = [
    {date: '2026-10-31', detections: 5, mean_frp: 3},
    {date: '2026-11-10', detections: 47_500, mean_frp: 14.95},
  ]

  it('shows the current month when it has days', () => {
    expect(currentMonthWindow(days, '2026-11-14')).toEqual({year: 2026, month: 11, current: true})
  })

  it('falls back to the latest month with days and says it is not current', () => {
    expect(currentMonthWindow(days, '2026-12-02')).toEqual({year: 2026, month: 11, current: false})
  })

  it('keeps the current month when no days are loaded at all', () => {
    expect(currentMonthWindow([], '2026-11-14')).toEqual({year: 2026, month: 11, current: true})
  })
})
