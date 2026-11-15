import {describe, expect, it} from 'vitest'
import {MAX_ZOOM, MIN_ZOOM, resForZoom, wheelZoomDelta} from '../../lib/zoom'

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
    expect(resForZoom(12)).toBe(7)
    expect(resForZoom(16)).toBe(7)
  })

  it('never returns a level outside the allowed range [4, 7] and is monotonic', () => {
    let prev = resForZoom(-5)
    for (let z = -5; z <= 25; z += 0.5) {
      const level = resForZoom(z)
      expect(Number.isInteger(level)).toBe(true)
      expect(level).toBeGreaterThanOrEqual(4)
      expect(level).toBeLessThanOrEqual(7)
      expect(level).toBeGreaterThanOrEqual(prev)
      prev = level
    }
    expect(resForZoom(MIN_ZOOM)).toBeGreaterThanOrEqual(4)
    expect(resForZoom(MAX_ZOOM)).toBeLessThanOrEqual(7)
  })
})

describe('wheelZoomDelta', () => {
  it('converts pixel, line, and page wheel deltas into zoom level deltas', () => {
    expect(wheelZoomDelta(100, 0)).toBe(-1)
    expect(wheelZoomDelta(-100, 0)).toBe(1)
    expect(wheelZoomDelta(3, 1)).toBeCloseTo(-0.99)
    expect(wheelZoomDelta(1, 2)).toBe(-4)
    expect(wheelZoomDelta(50, 0)).toBe(-0.5)
  })
})

