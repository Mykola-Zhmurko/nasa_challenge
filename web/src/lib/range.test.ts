import {describe, expect, it} from 'vitest'
import {clampRange, isIsoDate} from '../../lib/range'

describe('isIsoDate', () => {
  it('accepts a calendar date', () => {
    expect(isIsoDate('2020-12-01')).toBe(true)
  })

  it('rejects empty, partial and impossible dates', () => {
    expect(isIsoDate('')).toBe(false)
    expect(isIsoDate('2020-12')).toBe(false)
    expect(isIsoDate('01.12.2020')).toBe(false)
    expect(isIsoDate('2020-13-01')).toBe(false)
  })
})

describe('clampRange', () => {
  it('keeps a window that sits inside the dataset', () => {
    expect(clampRange('2020-12-01', '2020-12-31', '2001-01-01', '2026-11-14')).toEqual({
      from: '2020-12-01',
      to: '2020-12-31',
    })
  })

  it('swaps a window picked backwards', () => {
    expect(clampRange('2020-12-31', '2020-12-01', '2001-01-01', '2026-11-14')).toEqual({
      from: '2020-12-01',
      to: '2020-12-31',
    })
  })

  it('clamps both ends to the dataset', () => {
    expect(clampRange('1990-01-01', '2030-01-01', '2001-01-01', '2026-11-14')).toEqual({
      from: '2001-01-01',
      to: '2026-11-14',
    })
  })

  it('collapses to the dataset when the window lies outside it', () => {
    expect(clampRange('1990-01-01', '1991-01-01', '2001-01-01', '2026-11-14')).toEqual({
      from: '2001-01-01',
      to: '2001-01-01',
    })
  })
})
