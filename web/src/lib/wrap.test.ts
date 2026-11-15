import {describe, expect, it} from 'vitest'
import {clipToArea, markerLongitudes, splitBBox, wrapLon} from '../../lib/wrap'

describe('wrapLon', () => {
  it('keeps longitudes inside the normal range untouched', () => {
    expect(wrapLon(0)).toBe(0)
    expect(wrapLon(179.5)).toBe(179.5)
    expect(wrapLon(-179.5)).toBe(-179.5)
  })

  it('folds the next world copy back', () => {
    expect(wrapLon(181)).toBe(-179)
    expect(wrapLon(360)).toBe(0)
    expect(wrapLon(-181)).toBe(179)
  })
})

describe('splitBBox', () => {
  it('returns one box for a view inside the normal range', () => {
    expect(splitBBox([-20, 5, 40, 60])).toEqual([[-20, 5, 40, 60]])
  })

  it('splits a view that straddles the dateline', () => {
    const [west, east] = splitBBox([176, -25, 184, -12])
    expect(west).toEqual([176, -25, 180, -12])
    expect(east).toEqual([-180, -25, -176, -12])
  })

  it('splits a view that reaches past the dateline from the east', () => {
    const boxes = splitBBox([-190, 10, -170, 20])
    expect(boxes).toEqual([
      [170, 10, 180, 20],
      [-180, 10, -170, 20],
    ])
  })

  it('asks for the whole world when the view is wider than one copy', () => {
    expect(splitBBox([-250, -60, 260, 75])).toEqual([[-180, -60, 180, 75]])
  })

  it('drops an empty box', () => {
    expect(splitBBox([10, 5, 10, 20])).toEqual([])
  })
})

describe('clipToArea', () => {
  const area: [number, number, number, number] = [-180, -58, 180, 72]

  it('keeps both halves of a dateline view inside a world area', () => {
    expect(clipToArea(area, [176, -25, 184, -12])).toEqual([
      [176, -25, 180, -12],
      [-180, -25, -176, -12],
    ])
  })

  it('clips to the loaded area', () => {
    expect(clipToArea([110, -48, 180, 0], [150, -20, 190, 10])).toEqual([
      [150, -20, 180, 0],
    ])
  })

  it('returns nothing when the view lies outside the area', () => {
    expect(clipToArea([110, -48, 180, 0], [-120, 20, -100, 40])).toEqual([])
  })
})

describe('markerLongitudes', () => {
  it('draws a marker once while the view stays in one world copy', () => {
    expect(markerLongitudes(10, -100, 100)).toEqual([10])
  })

  it('draws the neighbouring copy when the view reaches past the dateline', () => {
    expect(markerLongitudes(179, 174, 186)).toEqual([179])
    expect(markerLongitudes(-179, 174, 186)).toEqual([181])
  })

  it('draws both copies when the view spans more than one world', () => {
    expect(markerLongitudes(10, -350, 370)).toEqual([-350, 10, 370])
  })
})
