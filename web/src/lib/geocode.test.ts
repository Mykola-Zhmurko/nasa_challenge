import {afterEach, describe, expect, it, vi} from 'vitest'
import {boxForCity, parseCoordinates, suggestPlaces, toAscii} from '../../lib/geocode'

function mockFetch(results: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ok: true, json: async () => ({results})}) as unknown as Response),
  )
}

/** Answers per `name` query; anything unknown returns no hits. */
function mockFetchByQuery(byQuery: Record<string, unknown[]>) {
  const spy = vi.fn(async (input: string) => {
    const name = new URL(input).searchParams.get('name') ?? ''
    return {ok: true, json: async () => ({results: byQuery[name] ?? []})} as unknown as Response
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

const WUERZBURG = {
  name: 'Würzburg',
  feature_code: 'PPLA2',
  latitude: 49.79,
  longitude: 9.95,
  admin1: 'Bavaria',
  country: 'Germany',
  population: 133_731,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('city search', () => {
  it('keeps populated places and drops countries and regions', async () => {
    mockFetch([
      {name: 'Ukraine', feature_code: 'PCLI', latitude: 49, longitude: 32, country: 'Ukraine'},
      WUERZBURG,
      {name: 'Wurzen', feature_code: 'PPL', latitude: 51.37, longitude: 12.74, admin1: 'Saxony', country: 'Germany'},
      {name: 'Bavaria', feature_code: 'ADM1', latitude: 48.9, longitude: 11.4, country: 'Germany'},
    ])
    const rows = await suggestPlaces('würz')
    expect(rows.map(row => row.name)).toEqual(['Wuerzburg', 'Wurzen'])
    expect(rows[0]?.detail).toBe('Bavaria, Germany')
  })

  it('writes every name in plain ASCII', async () => {
    mockFetch([
      {name: 'Düsseldorf', feature_code: 'PPLA2', latitude: 51.22, longitude: 6.77, admin1: 'North Rhine-Westphalia', country: 'Germany'},
      {name: 'São Paulo', feature_code: 'PPLA', latitude: -23.55, longitude: -46.63, admin1: 'São Paulo', country: 'Brazil'},
    ])
    const rows = await suggestPlaces('dus')
    expect(rows.map(row => row.name)).toEqual(['Duesseldorf', 'Sao Paulo'])
    expect(rows[1]?.detail).toBe('Brazil')
    for (const row of rows) {
      expect(row.name).toMatch(/^[\x20-\x7E]+$/)
      expect(row.detail).toMatch(/^[\x20-\x7E]*$/)
    }
  })

  it('finds a city typed with an umlaut spelled as ue', async () => {
    const spy = mockFetchByQuery({Wurzburg: [WUERZBURG], Würzburg: [WUERZBURG]})
    const rows = await suggestPlaces('Wuerzburg')
    expect(rows.map(row => row.name)).toEqual(['Wuerzburg'])
    const asked = spy.mock.calls.map(call => new URL(call[0] as string).searchParams.get('name'))
    expect(asked).toContain('Wurzburg')
  })

  it('asks for the accented and the plain spelling at once', async () => {
    const spy = mockFetchByQuery({Würzburg: [WUERZBURG], Wurzburg: [WUERZBURG]})
    const rows = await suggestPlaces('Würzburg')
    expect(rows.map(row => row.name)).toEqual(['Wuerzburg'])
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('sizes the bounding box by population', async () => {
    mockFetch([
      {name: 'Paris', feature_code: 'PPLC', latitude: 48.85, longitude: 2.35, country: 'France', population: 2_138_551},
      {name: 'Kleinort', feature_code: 'PPL', latitude: 50, longitude: 10, country: 'Germany'},
    ])
    const [big, small] = await suggestPlaces('par')
    const bigWidth = (big?.bbox?.[2] ?? 0) - (big?.bbox?.[0] ?? 0)
    const smallWidth = (small?.bbox?.[2] ?? 0) - (small?.bbox?.[0] ?? 0)
    expect(bigWidth).toBeCloseTo(0.8, 5)
    expect(smallWidth).toBeCloseTo(0.2, 5)
  })

  it('asks nothing for a single character', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect(await suggestPlaces('w')).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('toAscii', () => {
  it('turns umlauts into ae/oe/ue and drops other accents', () => {
    expect(toAscii('Würzburg')).toBe('Wuerzburg')
    expect(toAscii('Düsseldorf')).toBe('Duesseldorf')
    expect(toAscii('Gießen')).toBe('Giessen')
    expect(toAscii('Baden-Württemberg')).toBe('Baden-Wuerttemberg')
    expect(toAscii('São Paulo')).toBe('Sao Paulo')
    expect(toAscii('Kraków')).toBe('Krakow')
    expect(toAscii('Łódź')).toBe('Lodz')
    expect(toAscii('Ørsted')).toBe('Orsted')
  })
})

describe('boxForCity', () => {
  it('falls back to a small box for unknown population', () => {
    expect(boxForCity(49.8, 9.95)).toEqual([9.85, 49.7, 10.05, 49.9])
  })

  it('clamps at the poles', () => {
    const box = boxForCity(89.9, 10, 1_000_000)
    expect(box?.[3]).toBeLessThanOrEqual(90)
  })
})

describe('parseCoordinates', () => {
  it('accepts comma, semicolon and space separated pairs', () => {
    expect(parseCoordinates('48.5, 9.2')).toEqual({lat: 48.5, lon: 9.2})
    expect(parseCoordinates('48.5;9.2')).toEqual({lat: 48.5, lon: 9.2})
    expect(parseCoordinates('48.5 9.2')).toEqual({lat: 48.5, lon: 9.2})
  })

  it('rejects out-of-range values and text', () => {
    expect(parseCoordinates('95, 10')).toBeNull()
    expect(parseCoordinates('berlin')).toBeNull()
  })
})
