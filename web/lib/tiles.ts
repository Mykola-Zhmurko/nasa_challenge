import type L from 'leaflet'

/**
 * Esri's World Imagery cache has no pixels over open water and some remote regions.
 * Instead of an error it answers with a light-grey image reading
 * "Map data not yet available" (background exactly #CCCCCC, ~97 % of the tile).
 * Such a tile must not paint over the dark basemap underneath it.
 */
const PLACEHOLDER_GREY = 204
const GREY_TOLERANCE = 8
const PLACEHOLDER_MIN_SHARE = 0.5

let scratch: HTMLCanvasElement | null = null

/** Share of pixels that are the placeholder grey — 1 means "no data" tile, ~0 means real imagery. */
export function greyShare(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  step = 4,
): number {
  let total = 0
  let grey = 0
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4
      const r = data[i] ?? 0
      const g = data[i + 1] ?? 0
      const b = data[i + 2] ?? 0
      total += 1
      if (
        Math.abs(r - PLACEHOLDER_GREY) <= GREY_TOLERANCE &&
        Math.abs(g - PLACEHOLDER_GREY) <= GREY_TOLERANCE &&
        Math.abs(b - PLACEHOLDER_GREY) <= GREY_TOLERANCE
      ) {
        grey += 1
      }
    }
  }
  return total === 0 ? 0 : grey / total
}

export function isNoDataPlaceholder(share: number): boolean {
  return share > PLACEHOLDER_MIN_SHARE
}

/** Reads a loaded tile image and reports whether Esri sent the "no data" placeholder. */
export function tileHasNoData(tile: HTMLImageElement): boolean {
  const width = tile.naturalWidth || 256
  const height = tile.naturalHeight || 256
  if (!width || !height) return false
  if (!scratch) scratch = document.createElement('canvas')
  const canvas = scratch
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', {willReadFrequently: true})
  if (!context) return false
  context.drawImage(tile, 0, 0)
  let pixels: Uint8ClampedArray
  try {
    pixels = context.getImageData(0, 0, width, height).data
  } catch {
    // Tainted canvas (no CORS header) — assume real imagery.
    return false
  }
  return isNoDataPlaceholder(greyShare(pixels, width, height))
}

/** `tileload` handler: hide Esri placeholder tiles so the basemap below shows through. */
export function hideNoDataTiles(event: L.TileEvent): void {
  const tile = event.tile as HTMLImageElement
  tile.style.visibility = tileHasNoData(tile) ? 'hidden' : ''
}
