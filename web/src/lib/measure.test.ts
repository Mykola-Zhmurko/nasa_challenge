import {describe, expect, it} from 'vitest'
import {formatArea, formatDistance, pathLengthM, ringAreaM2, segmentLengthM} from '../../lib/measure'

describe('segmentLengthM', () => {
  it('measures one degree of latitude at about 111 km', () => {
    const metres = segmentLengthM({lat: 0, lon: 0}, {lat: 1, lon: 0})
    expect(metres / 1000).toBeGreaterThan(110)
    expect(metres / 1000).toBeLessThan(112)
  })

  it('is zero for the same point twice', () => {
    expect(segmentLengthM({lat: 49.8, lon: 9.9}, {lat: 49.8, lon: 9.9})).toBe(0)
  })
})

describe('pathLengthM', () => {
  it('adds the segments of a polyline', () => {
    const one = segmentLengthM({lat: 0, lon: 0}, {lat: 1, lon: 0})
    const total = pathLengthM([
      {lat: 0, lon: 0},
      {lat: 1, lon: 0},
      {lat: 2, lon: 0},
    ])
    expect(total).toBeCloseTo(one * 2, 3)
  })

  it('is zero for fewer than two points', () => {
    expect(pathLengthM([])).toBe(0)
    expect(pathLengthM([{lat: 5, lon: 5}])).toBe(0)
  })
})

describe('ringAreaM2', () => {
  it('measures a one-degree box at the equator at about 12,360 km2', () => {
    const squareMetres = ringAreaM2([
      {lat: 0, lon: 0},
      {lat: 0, lon: 1},
      {lat: 1, lon: 1},
      {lat: 1, lon: 0},
    ])
    expect(squareMetres / 1_000_000).toBeGreaterThan(12_000)
    expect(squareMetres / 1_000_000).toBeLessThan(12_700)
  })

  it('does not depend on the direction the ring was drawn', () => {
    const clockwise = ringAreaM2([
      {lat: 0, lon: 0},
      {lat: 0, lon: 1},
      {lat: 1, lon: 1},
    ])
    const counterClockwise = ringAreaM2([
      {lat: 1, lon: 1},
      {lat: 0, lon: 1},
      {lat: 0, lon: 0},
    ])
    expect(clockwise).toBeCloseTo(counterClockwise, 3)
  })

  it('is zero for fewer than three points', () => {
    expect(ringAreaM2([{lat: 0, lon: 0}, {lat: 1, lon: 1}])).toBe(0)
  })
})

describe('formatDistance', () => {
  it('switches from metres to kilometres', () => {
    expect(formatDistance(0)).toBe('0 m')
    expect(formatDistance(820)).toBe('820 m')
    expect(formatDistance(12_400)).toBe('12.4 km')
    expect(formatDistance(1_240_000)).toBe('1,240 km')
  })
})

describe('formatArea', () => {
  it('switches from square metres to square kilometres', () => {
    expect(formatArea(0)).toBe('0 km²')
    expect(formatArea(8_400)).toBe('8,400 m²')
    expect(formatArea(12_400_000)).toBe('12.4 km²')
  })
})
