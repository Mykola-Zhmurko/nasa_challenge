/**
 * Measure maths for the map tool: path length and ring area on a sphere.
 *
 * The values are computed here, not in the component, so they can be tested
 * without a browser: a Leaflet map is not needed to add up distances.
 */

export interface LatLon {
  lat: number
  lon: number
}

/** Mean Earth radius in metres (IUGG). */
const EARTH_RADIUS_M = 6371008.8

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** Great-circle length of one segment in metres (haversine). */
export function segmentLengthM(a: LatLon, b: LatLon): number {
  const dLat = toRadians(b.lat - a.lat)
  const dLon = toRadians(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Total length of an open polyline in metres. */
export function pathLengthM(points: LatLon[]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]
    const b = points[i]
    if (a && b) total += segmentLengthM(a, b)
  }
  return total
}

/** Area of a closed ring in square metres (spherical excess, ring is closed implicitly). */
export function ringAreaM2(points: LatLon[]): number {
  if (points.length < 3) return 0
  let total = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    if (!a || !b) continue
    total += toRadians(b.lon - a.lon) * (2 + Math.sin(toRadians(a.lat)) + Math.sin(toRadians(b.lat)))
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2)
}

/** Distance in the unit a reader expects: metres below one kilometre, else kilometres. */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres <= 0) return '0 m'
  if (metres < 1000) return `${Math.round(metres)} m`
  const km = metres / 1000
  return `${km.toLocaleString('en-US', {maximumFractionDigits: km < 100 ? 1 : 0})} km`
}

/** Area in the unit a reader expects: square metres below one square kilometre, else km². */
export function formatArea(squareMetres: number): string {
  if (!Number.isFinite(squareMetres) || squareMetres <= 0) return '0 km²'
  if (squareMetres < 1_000_000) {
    return `${Math.round(squareMetres).toLocaleString('en-US')} m²`
  }
  const km2 = squareMetres / 1_000_000
  return `${km2.toLocaleString('en-US', {maximumFractionDigits: km2 < 100 ? 2 : 0})} km²`
}
