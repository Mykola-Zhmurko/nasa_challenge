import {describe, expect, it} from 'vitest'
import {greyShare, isNoDataPlaceholder} from '../../lib/tiles'

const SIZE = 256

function tileBuffer(colour: [number, number, number], size = SIZE): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = colour[0]
    data[i + 1] = colour[1]
    data[i + 2] = colour[2]
    data[i + 3] = 255
  }
  return data
}

describe('no-data placeholder detection', () => {
  it('recognises the Esri placeholder background as a no-data tile', () => {
    const share = greyShare(tileBuffer([204, 204, 204]), SIZE, SIZE)
    expect(share).toBe(1)
    expect(isNoDataPlaceholder(share)).toBe(true)
  })

  it('accepts the JPEG noise around the placeholder grey', () => {
    const share = greyShare(tileBuffer([205, 202, 206]), SIZE, SIZE)
    expect(isNoDataPlaceholder(share)).toBe(true)
  })

  it('treats real imagery as data', () => {
    for (const colour of [
      [24, 88, 32],
      [196, 152, 88],
      [8, 12, 26],
      [250, 250, 250],
    ] as [number, number, number][]) {
      const share = greyShare(tileBuffer(colour), SIZE, SIZE)
      expect(isNoDataPlaceholder(share)).toBe(false)
    }
  })

  it('stays below the threshold when only part of the tile is placeholder grey', () => {
    const data = tileBuffer([40, 90, 40])
    // Left half = placeholder grey, right half = vegetation.
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE / 2; x += 1) {
        const i = (y * SIZE + x) * 4
        data[i] = 204
        data[i + 1] = 204
        data[i + 2] = 204
      }
    }
    expect(isNoDataPlaceholder(greyShare(data, SIZE, SIZE))).toBe(false)
  })

  it('returns zero for an empty buffer instead of dividing by zero', () => {
    expect(greyShare(new Uint8ClampedArray(0), 0, 0)).toBe(0)
  })
})
