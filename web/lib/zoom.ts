export const MAX_ZOOM = 16
export const MIN_ZOOM = 2

/** Deepest native tile level of the Esri Dark Gray Canvas basemap; MAX_ZOOM stays below it so tiles are never upscaled. */
export const DARK_NATIVE_ZOOM = 16

/** Deepest native tile level of the Esri World Imagery basemap. */
export const SATELLITE_NATIVE_ZOOM = 19

/** Deepest native tile level of the NASA GIBS Blue Marble WMTS layer. */
export const BLUE_MARBLE_NATIVE_ZOOM = 8

/** Deepest native tile level of the Esri World Boundaries and Places reference overlay. */
export const BORDERS_NATIVE_ZOOM = 16

/**
 * Hexagon level that matches the ground scale of a map zoom, so zooming in reveals
 * finer hotspots instead of the same coarse cells. Level 8 (~1 km) is the MODIS pixel scale.
 */
export function resForZoom(zoom: number): number {
  if (zoom <= 3) return 4
  if (zoom <= 5) return 5
  if (zoom <= 8) return 6
  if (zoom <= 11) return 7
  return 8
}
