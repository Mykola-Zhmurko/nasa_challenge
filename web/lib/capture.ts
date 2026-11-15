/**
 * Capture the current map view as a PNG.
 *
 * The map is a stack of raster tiles plus one canvas per marker layer, so the
 * picture is assembled on a canvas instead of asking the browser for a
 * screenshot: every tile that carries a CORS header (OpenStreetMap, Esri, NASA
 * GIBS) can be read back, which keeps the export free of a screenshot library.
 * Vector overlays (measure line, area outline) are drawn from their coordinates,
 * because a Leaflet SVG cannot be read as pixels.
 */

import type {Map as LeafletMap} from 'leaflet'
import type {LatLon} from './measure'

export interface CaptureMeasure {
  mode: 'distance' | 'area'
  points: LatLon[]
}

export interface CaptureOptions {
  /** Small line at the bottom edge: what the picture shows and where it comes from. */
  footer: string
  /** Selected area outline, drawn like on screen. */
  areaBBox?: [number, number, number, number]
  /** Measure geometry, drawn like on screen. */
  measure?: CaptureMeasure
}

/** Same treatment the under-layer gets in CSS, applied while compositing. */
const UNDERLAY_FILTER = 'grayscale(0.9) brightness(0.62) contrast(1.12)'
const BACKGROUND = '#101216'
const FOOTER_HEIGHT = 22

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function relativeBox(element: Element, container: DOMRect): Box {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left - container.left,
    y: rect.top - container.top,
    width: rect.width,
    height: rect.height,
  }
}

function isVisible(element: HTMLElement): boolean {
  return element.style.visibility !== 'hidden' && element.style.opacity !== '0'
}

/**
 * A tile without a CORS header cannot be read back, and one of them is enough to
 * make the whole export fail. Probe each picture on a scratch canvas first, so a
 * mis-configured layer leaves a hole in the picture instead of breaking it.
 */
function isReadable(image: CanvasImageSource): boolean {
  const scratch = document.createElement('canvas')
  scratch.width = 1
  scratch.height = 1
  const context = scratch.getContext('2d')
  if (!context) return false
  try {
    context.drawImage(image, 0, 0, 1, 1)
    scratch.toDataURL()
    return true
  } catch {
    return false
  }
}

function drawTiles(context: CanvasRenderingContext2D, map: LeafletMap, container: DOMRect) {
  const tiles = map.getContainer().querySelectorAll<HTMLImageElement>('img.leaflet-tile')
  for (const tile of Array.from(tiles)) {
    if (!tile.complete || tile.naturalWidth === 0 || !isVisible(tile)) continue
    const box = relativeBox(tile, container)
    if (box.width < 1 || box.height < 1) continue
    if (!isReadable(tile)) continue
    context.save()
    context.globalAlpha = tile.style.opacity ? Number(tile.style.opacity) : 1
    context.filter = tile.closest('.under-osm') ? UNDERLAY_FILTER : 'none'
    context.drawImage(tile, box.x, box.y, box.width, box.height)
    context.restore()
  }
}

function drawMarkerLayers(context: CanvasRenderingContext2D, map: LeafletMap, container: DOMRect) {
  const canvases = map.getContainer().querySelectorAll<HTMLCanvasElement>('canvas')
  for (const layer of Array.from(canvases)) {
    const box = relativeBox(layer, container)
    if (box.width < 1 || box.height < 1) continue
    if (!isReadable(layer)) continue
    context.drawImage(layer, box.x, box.y, box.width, box.height)
  }
}

function drawAreaOutline(
  context: CanvasRenderingContext2D,
  map: LeafletMap,
  bbox: [number, number, number, number],
) {
  const northWest = map.latLngToContainerPoint([bbox[3], bbox[0]])
  const southEast = map.latLngToContainerPoint([bbox[1], bbox[2]])
  context.save()
  context.strokeStyle = '#4a8ad6'
  context.fillStyle = 'rgba(74, 138, 214, 0.08)'
  context.lineWidth = 1
  context.beginPath()
  context.rect(
    northWest.x,
    northWest.y,
    southEast.x - northWest.x,
    southEast.y - northWest.y,
  )
  context.fill()
  context.stroke()
  context.restore()
}

function drawMeasure(
  context: CanvasRenderingContext2D,
  map: LeafletMap,
  measure: CaptureMeasure,
) {
  if (!measure.points.length) return
  const projected = measure.points.map(point => map.latLngToContainerPoint([point.lat, point.lon]))
  const closed = measure.mode === 'area' && projected.length >= 3

  if (closed) {
    context.save()
    context.beginPath()
    projected.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    })
    context.closePath()
    context.fillStyle = 'rgba(74, 138, 214, 0.16)'
    context.fill()
    context.restore()
  }

  if (projected.length >= 2) {
    context.save()
    context.strokeStyle = '#ffffff'
    context.lineWidth = 2
    context.lineJoin = 'round'
    context.beginPath()
    projected.forEach((point, index) => {
      if (index === 0) context.moveTo(point.x, point.y)
      else context.lineTo(point.x, point.y)
    })
    if (closed) context.closePath()
    context.stroke()
    context.restore()
  }

  context.save()
  for (const point of projected) {
    context.beginPath()
    context.arc(point.x, point.y, 3.5, 0, Math.PI * 2)
    context.fillStyle = '#ffffff'
    context.fill()
    context.lineWidth = 1
    context.strokeStyle = BACKGROUND
    context.stroke()
  }
  context.restore()
}

function drawFooter(context: CanvasRenderingContext2D, width: number, height: number, footer: string) {
  context.save()
  context.fillStyle = 'rgba(16, 18, 22, 0.86)'
  context.fillRect(0, height - FOOTER_HEIGHT, width, FOOTER_HEIGHT)
  context.fillStyle = '#a6a9b0'
  context.font = '11px "IBM Plex Sans", system-ui, sans-serif'
  context.textBaseline = 'middle'
  context.fillText(footer, 8, height - FOOTER_HEIGHT / 2)
  context.textAlign = 'right'
  context.fillStyle = '#ffffff'
  context.fillText('NASA · FIRMS', width - 8, height - FOOTER_HEIGHT / 2)
  context.restore()
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('The PNG could not be encoded'))
    }, 'image/png')
  })
}

/** Draw the current view into a PNG blob. */
export async function captureMapPng(map: LeafletMap, options: CaptureOptions): Promise<Blob> {
  const size = map.getSize()
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(size.x * ratio))
  canvas.height = Math.max(1, Math.round(size.y * ratio))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot draw the capture')
  context.scale(ratio, ratio)
  context.fillStyle = BACKGROUND
  context.fillRect(0, 0, size.x, size.y)

  const container = map.getContainer().getBoundingClientRect()
  drawTiles(context, map, container)
  drawMarkerLayers(context, map, container)
  if (options.areaBBox) drawAreaOutline(context, map, options.areaBBox)
  if (options.measure) drawMeasure(context, map, options.measure)
  drawFooter(context, size.x, size.y, options.footer)

  return toBlob(canvas)
}

/** Hand a blob to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/** File name for the capture of a given day, e.g. `firms-2026-11-14.png`. */
export function captureFilename(day: string): string {
  return `firms-${day}.png`
}
