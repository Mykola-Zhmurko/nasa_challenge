import type {BBox} from './api'

/**
 * Longitude folded into [-180, 180). Panning the map east of the dateline hands out
 * longitudes above 180 (the neighbouring world copy); the data itself never leaves
 * that range, so every view box has to be folded back before it becomes a query.
 */
export function wrapLon(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180
}

/**
 * Split a box that may reach past ±180 into at most two boxes inside [-180, 180].
 * A view straddling the dateline covers 176…182 degrees, which no query can ask for,
 * so it becomes 176…180 plus -180…-178.
 */
export function splitBBox(box: BBox): BBox[] {
  const [west, south, east, north] = box
  const span = east - west
  if (!(span > 0) || !(north > south)) return []
  if (span >= 360) return [[-180, south, 180, north]]
  const start = wrapLon(west)
  const end = start + span
  if (end <= 180) return [[start, south, end, north]]
  return [
    [start, south, 180, north],
    [-180, south, end - 360, north],
  ]
}

/** Overlap of the loaded area with a view box that may reach past ±180. */
export function clipToArea(area: BBox, view: BBox): BBox[] {
  const parts: BBox[] = []
  for (const part of splitBBox(view)) {
    const minLon = Math.max(area[0], part[0])
    const minLat = Math.max(area[1], part[1])
    const maxLon = Math.min(area[2], part[2])
    const maxLat = Math.min(area[3], part[3])
    if (minLon < maxLon && minLat < maxLat) parts.push([minLon, minLat, maxLon, maxLat])
  }
  return parts
}

/**
 * Longitudes at which one marker has to be drawn to appear in every world copy that is
 * on screen. A marker only exists at its own longitude, so the copies of the map have to
 * be drawn again — otherwise half of the world looks fire-free once the view reaches the
 * dateline.
 */
export function markerLongitudes(lng: number, west: number, east: number): number[] {
  const out: number[] = []
  for (let copy = -2; copy <= 2; copy++) {
    const shifted = lng + copy * 360
    if (shifted >= west && shifted <= east) out.push(shifted)
  }
  return out.length ? out : [lng]
}
