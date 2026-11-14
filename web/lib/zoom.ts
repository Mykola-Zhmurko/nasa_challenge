export const MAX_ZOOM = 18
export const MIN_ZOOM = 2

/** Deepest native tile level of the Esri Dark Gray Canvas basemap; above it Leaflet upscales the level-16 tiles. */
export const DARK_NATIVE_ZOOM = 16

/** Deepest native tile level of the CARTO dark basemap that sits under imagery layers which have gaps (open water). */
export const UNDERLAY_NATIVE_ZOOM = 20

/** Deepest native tile level of the Esri World Imagery basemap. */
export const SATELLITE_NATIVE_ZOOM = 19

/** Deepest native tile level of the NASA GIBS Blue Marble WMTS layer. */
export const BLUE_MARBLE_NATIVE_ZOOM = 8

/** Deepest native tile level of the Esri World Boundaries and Places reference overlay. */
export const BORDERS_NATIVE_ZOOM = 16

/**
 * Hexagon level that matches the ground scale of a map zoom: level 4 is the coarsest
 * and level 7 is the finest, so zooming in reveals finer cells.
 */
export function resForZoom(zoom: number): number {
  if (zoom <= 3) return 4
  if (zoom <= 5) return 5
  if (zoom <= 8) return 6
  return 7
}
