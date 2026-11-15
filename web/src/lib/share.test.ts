import {describe, expect, it} from 'vitest'
import {buildShareUrl, type ShareState} from './share'

const BASE_STATE: ShareState = {
  bbox: [-180, -58, 180, 72],
  day: null,
  rangePreset: '7d',
  customRange: null,
  res: 4,
  pinnedRes: null,
  basemap: 'satellite',
  sensorsEnabled: {MODIS: true, VIIRS: true},
}

describe('buildShareUrl', () => {
  it('encodes the view bbox rounded to four decimals instead of the world preset', () => {
    const url = buildShareUrl('https://example.com/', {
      ...BASE_STATE,
      bbox: [-8.426, 37.104, -6.189, 39.852],
    })
    const params = new URL(url).searchParams
    expect(params.get('bbox')).toBe('-8.426,37.104,-6.189,39.852')
    expect(params.get('range')).toBe('7d')
    expect(params.get('res')).toBe('auto')
    expect(params.get('basemap')).toBe('satellite')
    expect(params.get('sensors')).toBe('MODIS,VIIRS')
  })

  it('preserves a very small view bbox with four decimals unchanged', () => {
    const url = buildShareUrl('https://example.com/', {
      ...BASE_STATE,
      bbox: [39.5312, 57.6011, 39.5704, 57.6238],
    })
    const params = new URL(url).searchParams
    expect(params.get('bbox')).toBe('39.5312,57.6011,39.5704,57.6238')
  })

  it('prefers day over range or custom window when day is set', () => {
    const url = buildShareUrl('https://example.com/', {
      ...BASE_STATE,
      day: '2026-11-10',
      rangePreset: '3d',
      customRange: {from: '2026-11-01', to: '2026-11-05'},
    })
    const params = new URL(url).searchParams
    expect(params.get('day')).toBe('2026-11-10')
    expect(params.get('range')).toBeNull()
    expect(params.get('from')).toBeNull()
    expect(params.get('to')).toBeNull()
  })

  it('encodes custom from and to dates when rangePreset is custom', () => {
    const url = buildShareUrl('https://example.com/', {
      ...BASE_STATE,
      rangePreset: 'custom',
      customRange: {from: '2026-11-02', to: '2026-11-09'},
    })
    const params = new URL(url).searchParams
    expect(params.get('from')).toBe('2026-11-02')
    expect(params.get('to')).toBe('2026-11-09')
    expect(params.get('range')).toBeNull()
    expect(params.get('day')).toBeNull()
  })

  it('falls back to range=7d when rangePreset is day without an active day', () => {
    const url = buildShareUrl('https://example.com/', {
      ...BASE_STATE,
      day: null,
      rangePreset: 'day',
    })
    const params = new URL(url).searchParams
    expect(params.get('range')).toBe('7d')
    expect(params.get('day')).toBeNull()
  })

  it('uses auto when pinnedRes is null and the effective resolution when pinned', () => {
    const autoUrl = buildShareUrl('https://example.com/', {
      ...BASE_STATE,
      res: 5,
      pinnedRes: null,
    })
    expect(new URL(autoUrl).searchParams.get('res')).toBe('auto')

    const pinnedUrl = buildShareUrl('https://example.com/', {
      ...BASE_STATE,
      res: 6,
      pinnedRes: 6,
    })
    expect(new URL(pinnedUrl).searchParams.get('res')).toBe('6')
  })

  it('joins active sensors and sets an empty sensors parameter when both are off', () => {
    const singleUrl = buildShareUrl('https://example.com/', {
      ...BASE_STATE,
      sensorsEnabled: {MODIS: false, VIIRS: true},
    })
    expect(new URL(singleUrl).searchParams.get('sensors')).toBe('VIIRS')

    const noneUrl = buildShareUrl('https://example.com/', {
      ...BASE_STATE,
      sensorsEnabled: {MODIS: false, VIIRS: false},
    })
    expect(new URL(noneUrl).searchParams.get('sensors')).toBe('')
  })
})
