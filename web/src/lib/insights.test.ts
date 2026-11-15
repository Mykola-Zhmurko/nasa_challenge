import {describe, expect, it} from 'vitest'
import {anomalyLevel, bboxAreaKm2, bboxInside, monthComparison, rangeActivity} from '../../lib/insights'

describe('monthComparison', () => {
  const days = [
    {date: '2001-11-03', detections: 100, mean_frp: 5},
    {date: '2001-11-14', detections: 100, mean_frp: 5},
    {date: '2002-11-03', detections: 300, mean_frp: 5},
    {date: '2002-11-14', detections: 200, mean_frp: 5},
    {date: '2026-11-03', detections: 200_000, mean_frp: 15},
    {date: '2026-11-14', detections: 91_287, mean_frp: 16},
    {date: '2002-11-25', detections: 9_999, mean_frp: 16},
  ]

  it('compares the newest month over the same day-of-month window of the earlier years', () => {
    const result = monthComparison(days)
    expect(result).not.toBeNull()
    expect(result?.year).toBe(2026)
    expect(result?.month).toBe(11)
    expect(result?.daysLoaded).toBe(12)
    expect(result?.detections).toBe(291_287)
    expect(result?.median).toBe(350)
    expect(result?.years).toBe(2)
  })

  it('states the difference as a percentage, not as a rank', () => {
    const result = monthComparison(days)
    expect(result?.percent).toBe(83_125)
  })

  it('returns null without any daily data', () => {
    expect(monthComparison([])).toBeNull()
  })
})

describe('rangeActivity', () => {
  const days = [
    {date: '2026-11-07', detections: 10, mean_frp: 2},
    {date: '2026-11-08', detections: 0, mean_frp: 0},
    {date: '2026-11-10', detections: 47_500, mean_frp: 9},
    {date: '2026-11-20', detections: 999, mean_frp: 9},
  ]

  it('finds the peak day and counts active days inside the range only', () => {
    const result = rangeActivity(days, '2026-11-07', '2026-11-14')
    expect(result.peakDate).toBe('2026-11-10')
    expect(result.peakDetections).toBe(47_500)
    expect(result.activeDays).toBe(2)
    expect(result.daysInRange).toBe(8)
  })

  it('reports no peak for an empty range', () => {
    const result = rangeActivity(days, '2026-12-01', '2026-12-05')
    expect(result.peakDate).toBeNull()
    expect(result.peakDetections).toBe(0)
    expect(result.activeDays).toBe(0)
    expect(result.daysInRange).toBe(5)
  })
})

describe('bboxAreaKm2', () => {
  it('approximates the area of a one-degree box at the equator', () => {
    const area = bboxAreaKm2([0, 0, 1, 1])
    expect(area).toBeGreaterThan(12_000)
    expect(area).toBeLessThan(12_500)
  })

  it('shrinks towards the poles', () => {
    expect(bboxAreaKm2([0, 60, 1, 61])).toBeLessThan(bboxAreaKm2([0, 0, 1, 1]) / 1.8)
  })

  it('returns zero for a degenerate box', () => {
    expect(bboxAreaKm2([10, 10, 10, 20])).toBe(0)
  })
})

describe('bboxInside', () => {
  it('accepts a preset that is a hair wider than the data coverage', () => {
    expect(bboxInside([-25, 34, 45, 72], [-24.84225, 34, 45, 71.99673])).toBe(true)
  })

  it('rejects a box that lies clearly outside the coverage', () => {
    expect(bboxInside([-60, 34, 45, 72], [-24.84225, 34, 45, 71.99673])).toBe(false)
  })

  it('rejects a small box just outside the coverage', () => {
    expect(bboxInside([-30, 40, -29, 41], [-24.84225, 34, 45, 71.99673])).toBe(false)
  })
})

describe('anomalyLevel', () => {
  it('names the comparison in words', () => {
    expect(anomalyLevel(900)).toBe('far above normal')
    expect(anomalyLevel(60)).toBe('above normal')
    expect(anomalyLevel(0)).toBe('near normal')
    expect(anomalyLevel(-50)).toBe('below normal')
  })
})
