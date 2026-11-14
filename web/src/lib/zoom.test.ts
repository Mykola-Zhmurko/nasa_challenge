import {describe, expect, it} from 'vitest'
import {MAX_ZOOM, MIN_ZOOM, resForZoom} from '../../lib/zoom'

describe('resForZoom', () => {
  it('returns the documented H3 hexagon resolution for representative zoom levels', () => {
    expect(resForZoom(2)).toBe(4)
    expect(resForZoom(3)).toBe(4)
    expect(resForZoom(4)).toBe(5)
    expect(resForZoom(5)).toBe(5)
    expect(resForZoom(6)).toBe(6)
    expect(resForZoom(8)).toBe(6)
    expect(resForZoom(9)).toBe(7)
    expect(resForZoom(11)).toBe(7)
    expect(resForZoom(12)).toBe(8)
    expect(resForZoom(16)).toBe(8)
  })

  it('never returns a level outside the allowed range [4, 8]', () => {
    for (let z = -5; z <= 25; z += 0.5) {
      const level = resForZoom(z)
      expect(Number.isInteger(level)).toBe(true)
      expect(level).toBeGreaterThanOrEqual(4)
      expect(level).toBeLessThanOrEqual(8)
    }
    expect(resForZoom(MIN_ZOOM)).toBeGreaterThanOrEqual(4)
    expect(resForZoom(MAX_ZOOM)).toBeLessThanOrEqual(8)
  })
})
