export const MAX_ZOOM = 18
export const MIN_ZOOM = 2

/** Highest latitude the map may be panned to. Mercator runs to infinity at the poles, so the
 *  limit sits just below them; the viewport can therefore never be dragged off the world. */
export const MAX_PAN_LATITUDE = 85

/** Panning limit of the map. Latitude is clamped to ±MAX_PAN_LATITUDE; the longitude range is
 *  deliberately wider than one world copy so the globe still scrolls freely in both directions
 *  (worldCopyJump keeps the centre normalised to ±180). */
export const MAP_MAX_BOUNDS: [[number, number], [number, number]] = [
  [-MAX_PAN_LATITUDE, -720],
  [MAX_PAN_LATITUDE, 720],
]

/** Deepest native tile level of the Esri Dark Gray Canvas basemap; above it Leaflet upscales the level-16 tiles. */
export const DARK_NATIVE_ZOOM = 16

/** Deepest native tile level of the OpenStreetMap under-layer that fills imagery gaps (open water). */
export const UNDERLAY_NATIVE_ZOOM = 19

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

/** Wheel travel in pixels that asks for one zoom level; one mouse-wheel notch is about 100 px. */
export const WHEEL_PX_PER_LEVEL = 100

/**
 * Zoom levels a wheel event asks for: negative means zoom out. `deltaMode` 1 counts lines (Firefox),
 * 2 counts pages; both are converted to pixels first.
 */
export function wheelZoomDelta(deltaY: number, deltaMode = 0): number {
  const perUnit = deltaMode === 1 ? 33 : deltaMode === 2 ? 400 : 1
  return -(deltaY * perUnit) / WHEEL_PX_PER_LEVEL
}

