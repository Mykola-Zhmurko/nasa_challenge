import {useEffect, useMemo, useRef, useState} from 'react'
import L from 'leaflet'
import {
  AttributionControl,
  MapContainer,
  Popup,
  ScaleControl,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import * as h3 from 'h3-js'
import type {BBox, Cell, PointDetection, SensorTotals} from '../../lib/api'
import {fetchCalendar, fetchPoints} from '../../lib/api'
import {clipToArea, markerLongitudes} from '../../lib/wrap'
import {
  FIRE_RAMP,
  formatConfidence,
  formatCount,
  formatDayNight,
  formatSatellite,
  frpCuts,
  frpRampColor,
  frpStepLabels,
} from '../../lib/ramp'
import {hideNoDataTiles} from '../../lib/tiles'
import {captureFilename, captureMapPng, downloadBlob} from '../../lib/capture'
import type {LatLon} from '../../lib/measure'
import {
  BLUE_MARBLE_NATIVE_ZOOM,
  BORDERS_NATIVE_ZOOM,
  DARK_NATIVE_ZOOM,
  MAP_MAX_BOUNDS,
  MAX_ZOOM,
  MIN_ZOOM,
  SATELLITE_NATIVE_ZOOM,
  UNDERLAY_NATIVE_ZOOM,
  resForZoom,
} from '../../lib/zoom'
import {SmoothWheelZoom} from './SmoothWheelZoom'

export type Basemap = 'satellite' | 'dark' | 'blue-marble'

/** Distance along a path, or area inside a closed ring. */
export type MeasureMode = 'distance' | 'area'

export interface SensorsEnabled {
  MODIS: boolean
  VIIRS: boolean
}

interface MapViewProps {
  cells: Cell[]
  bbox: BBox
  res: number
  zoom: number
  rangeFrom: string
  rangeTo: string
  basemap: Basemap
  sensorsEnabled: SensorsEnabled
  areaSensors?: SensorTotals
  drawing: boolean
  measuring: boolean
  measureMode: MeasureMode
  measurePoints: LatLon[]
  onMeasurePoint: (point: LatLon) => void
  captureToken: number
  captureFooter: string
  onCaptured: (result: {ok: boolean; error?: string}) => void
  onBBox: (bbox: BBox) => void
  onViewBBox?: (bbox: BBox) => void
  onCursor: (position: {lat: number; lon: number} | null) => void
  onZoom: (zoom: number) => void
  onMapReady?: (map: L.Map) => void
}

const MAX_CELLS = 20000
const FEW_CELLS_THRESHOLD = 150

/** Wait for a wheel/pinch gesture to settle before refetching cells and rebuilding layers. */
const SETTLE_MS = 350

/** Minimum gap between two reports, so one slow rebuild cannot trigger the next. */
const COOLDOWN_MS = 600

/** Above this many markers, per-marker tooltips cost more than they help. */
const TOOLTIP_LIMIT = 2000

/** Hexagon centres are needed for every redraw; converting an H3 cell to lat/lng is
 * the expensive part of building the markers, so keep the result around. */
const geoCache = new Map<string, [number, number]>()
const GEO_CACHE_LIMIT = 200000

function cellCentre(h3Id: string): [number, number] {
  const cached = geoCache.get(h3Id)
  if (cached) return cached
  const [lat = 0, lng = 0] = h3.h3ToGeo(h3Id)
  if (geoCache.size > GEO_CACHE_LIMIT) geoCache.clear()
  geoCache.set(h3Id, [lat, lng])
  return [lat, lng]
}

/** True when the outer box fully contains the inner one. */
function bboxCovers(outer: BBox, inner: BBox): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3]
}

/** Rough size of a box in square degrees, only used to compare two boxes. */
function bboxArea(box: BBox): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1])
}

/** Rough size of several boxes together, only used to compare two sets of boxes. */
function boxesArea(boxes: BBox[]): number {
  return boxes.reduce((sum, box) => sum + bboxArea(box), 0)
}

/** Longitude range that is currently drawn; panning inside it needs no redraw. */
type DrawnRange = {west: number; east: number}

/** Box a draw covers: the view plus half a view width on each side, so a short pan
 *  does not rebuild thousands of markers. */
function drawnRange(map: L.Map): DrawnRange {
  const bounds = map.getBounds()
  const west = bounds.getWest()
  const east = bounds.getEast()
  const margin = (east - west) / 2
  return {west: west - margin, east: east + margin}
}

function coversView(drawn: DrawnRange, map: L.Map): boolean {
  const bounds = map.getBounds()
  return bounds.getWest() >= drawn.west && bounds.getEast() <= drawn.east
}

/** One point can sit in two query boxes when the view touches the dateline. */
function mergePoints(points: PointDetection[]): PointDetection[] {
  const seen = new Set<string>()
  const merged: PointDetection[] = []
  for (const point of points) {
    const key = `${point.ts}|${point.lat}|${point.lon}|${point.sensor}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(point)
  }
  return merged
}

/** A clicked cell or detection together with the position it was clicked at, so the popup
 *  opens in the world copy the user actually sees. */
type Picked<T> = {item: T; position: [number, number]}

function Hotspots({
  cells,
  cuts,
  onSelect,
}: {
  cells: Cell[]
  cuts: number[]
  onSelect: (cell: Cell, position: [number, number]) => void
}) {
  const map = useMap()
  const group = useRef<L.LayerGroup | null>(null)
  const rendererRef = useRef<L.Canvas | null>(null)
  const drawnRef = useRef<DrawnRange | null>(null)
  const onSelectRef = useRef(onSelect)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    if (!group.current) {
      group.current = L.layerGroup().addTo(map)
    }
    const layer = group.current
    const renderer = (rendererRef.current ??= L.canvas({padding: 0.4}))

    const draw = () => {
      layer.clearLayers()
      if (!cells.length) return
      const drawn = drawnRange(map)
      drawnRef.current = drawn
      const west = drawn.west
      const east = drawn.east
      const visible = cells.length > MAX_CELLS ? cells.slice(0, MAX_CELLS) : cells
      const withTooltips = visible.length <= TOOLTIP_LIMIT
      const maxDetections = visible.reduce((peak, cell) => Math.max(peak, cell.detections), 1)
      const scale = Math.sqrt(maxDetections)

      visible.forEach(cell => {
        const [lat, lng] = cellCentre(cell.h3)
        const radius = 3 + (Math.sqrt(cell.detections) / scale) * 4
        const fillColor = frpRampColor(cell.mean_frp, cuts)
        // One marker per world copy on screen: the map can show two copies of the same
        // longitude at the dateline, and the fire belongs on both of them.
        for (const lon of markerLongitudes(lng, west, east)) {
          const marker = L.circleMarker([lat, lon], {
            renderer,
            radius,
            stroke: true,
            weight: 0.6,
            color: 'rgba(11, 12, 14, 0.72)',
            fillColor,
            fillOpacity: 0.92,
          })
          if (withTooltips) {
            marker.bindTooltip(
              `${formatCount(cell.detections)} detections · ${cell.mean_frp.toFixed(1)} MW`,
              {direction: 'top', className: 'tip', sticky: true},
            )
          }
          marker.on('click', event => {
            L.DomEvent.stopPropagation(event)
            onSelectRef.current(cell, [lat, lon])
          })
          layer.addLayer(marker)
        }
      })
    }

    draw()
    // Panning only moves the copies under the view; the markers have to follow, otherwise
    // the world copy that scrolls in stays empty. Inside the drawn range nothing changes.
    const onMoveEnd = () => {
      if (drawnRef.current && coversView(drawnRef.current, map)) return
      draw()
    }
    map.on('moveend', onMoveEnd)
    return () => {
      map.off('moveend', onMoveEnd)
    }
  }, [cells, cuts, map])

  useEffect(() => {
    return () => {
      group.current?.clearLayers()
    }
  }, [])

  return null
}

function PointDetections({
  points,
  cuts,
  onSelect,
}: {
  points: PointDetection[]
  cuts: number[]
  onSelect: (point: PointDetection, position: [number, number]) => void
}) {
  const map = useMap()
  const group = useRef<L.LayerGroup | null>(null)
  const rendererRef = useRef<L.Canvas | null>(null)
  const drawnRef = useRef<DrawnRange | null>(null)
  const onSelectRef = useRef(onSelect)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    if (!group.current) {
      group.current = L.layerGroup().addTo(map)
    }
    const layer = group.current
    const renderer = (rendererRef.current ??= L.canvas({padding: 0.4}))

    const draw = () => {
      layer.clearLayers()
      if (!points.length) return
      const drawn = drawnRange(map)
      drawnRef.current = drawn
      const west = drawn.west
      const east = drawn.east
      const withTooltips = points.length <= TOOLTIP_LIMIT

      points.forEach(point => {
        const fillColor = frpRampColor(point.frp_mw, cuts)
        for (const lon of markerLongitudes(point.lon, west, east)) {
          const marker = L.circleMarker([point.lat, lon], {
            renderer,
            radius: 4.5,
            stroke: true,
            weight: 0.7,
            color: 'rgba(11, 12, 14, 0.8)',
            fillColor,
            fillOpacity: 0.94,
          })
          if (withTooltips) {
            marker.bindTooltip(
              `${point.sensor} · ${point.frp_mw.toFixed(2)} MW · ${point.ts}`,
              {direction: 'top', className: 'tip', sticky: true},
            )
          }
          marker.on('click', event => {
            L.DomEvent.stopPropagation(event)
            onSelectRef.current(point, [point.lat, lon])
          })
          layer.addLayer(marker)
        }
      })
    }

    draw()
    const onMoveEnd = () => {
      if (drawnRef.current && coversView(drawnRef.current, map)) return
      draw()
    }
    map.on('moveend', onMoveEnd)
    return () => {
      map.off('moveend', onMoveEnd)
    }
  }, [points, cuts, map])

  useEffect(() => {
    return () => {
      group.current?.clearLayers()
    }
  }, [])

  return null
}

function AreaOutline({bbox, active}: {bbox: BBox; active: boolean}) {
  const map = useMap()
  const layer = useRef<L.Rectangle | null>(null)

  useEffect(() => {
    if (!active) {
      layer.current?.remove()
      layer.current = null
      return
    }
    const bounds = L.latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]])
    if (!layer.current) {
      layer.current = L.rectangle(bounds, {
        color: '#4a8ad6',
        weight: 1,
        fillOpacity: 0.04,
        interactive: false,
      }).addTo(map)
    } else {
      layer.current.setBounds(bounds)
    }
  }, [bbox, active, map])

  return null
}

function FitToArea({bbox}: {bbox: BBox}) {
  const map = useMap()
  const last = useRef('')

  useEffect(() => {
    const key = bbox.join(',')
    if (key === last.current) return
    last.current = key
    map.fitBounds(
      L.latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]),
      {paddingTopLeft: [24, 64], paddingBottomRight: [360, 64], animate: false},
    )
  }, [bbox, map])

  return null
}

function DrawRectangle({active, onDone}: {active: boolean; onDone: (bbox: BBox) => void}) {
  const map = useMap()
  const start = useRef<L.LatLng | null>(null)
  const preview = useRef<L.Rectangle | null>(null)

  useEffect(() => {
    const container = map.getContainer()
    container.style.cursor = active ? 'crosshair' : ''
    return () => {
      container.style.cursor = ''
    }
  }, [active, map])

  useMapEvents({
    mousedown(event) {
      if (!active) return
      map.dragging.disable()
      start.current = event.latlng
      preview.current = L.rectangle(L.latLngBounds(event.latlng, event.latlng), {
        color: '#4a8ad6',
        weight: 1,
        fillOpacity: 0.08,
      }).addTo(map)
    },
    mousemove(event) {
      if (!active || !start.current || !preview.current) return
      preview.current.setBounds(L.latLngBounds(start.current, event.latlng))
    },
    mouseup(event) {
      if (!active || !start.current) return
      map.dragging.enable()
      const bounds = L.latLngBounds(start.current, event.latlng)
      start.current = null
      preview.current?.remove()
      preview.current = null
      const width = bounds.getEast() - bounds.getWest()
      const height = bounds.getNorth() - bounds.getSouth()
      if (width > 0.02 && height > 0.02) {
        onDone([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()])
      }
    },
  })

  return null
}

function MeasureTool({
  active,
  mode,
  points,
  onAddPoint,
}: {
  active: boolean
  mode: MeasureMode
  points: LatLon[]
  onAddPoint: (point: LatLon) => void
}) {
  const map = useMap()
  const group = useRef<L.LayerGroup | null>(null)
  const [hover, setHover] = useState<LatLon | null>(null)

  useEffect(() => {
    const layer = L.layerGroup().addTo(map)
    group.current = layer
    return () => {
      layer.remove()
      group.current = null
    }
  }, [map])

  useEffect(() => {
    const container = map.getContainer()
    if (!active) return
    container.style.cursor = 'crosshair'
    return () => {
      container.style.cursor = ''
    }
  }, [active, map])

  useEffect(() => {
    if (!active) setHover(null)
  }, [active])

  // The preview follows the pointer, so the length is visible before the click.
  useEffect(() => {
    const layer = group.current
    if (!layer) return
    layer.clearLayers()
    if (!active) return

    const closed = mode === 'area' && points.length >= 3
    const path = hover ? [...points, hover] : points
    const latLngs = path.map(point => [point.lat, point.lon] as [number, number])

    if (closed) {
      L.polygon(points.map(point => [point.lat, point.lon] as [number, number]), {
        color: '#4a8ad6',
        weight: 2,
        fillColor: '#4a8ad6',
        fillOpacity: 0.16,
        interactive: false,
      }).addTo(layer)
    }

    if (latLngs.length >= 2) {
      L.polyline(latLngs, {
        color: '#ffffff',
        weight: 2,
        opacity: 0.92,
        interactive: false,
      }).addTo(layer)
    }

    points.forEach(point => {
      L.circleMarker([point.lat, point.lon], {
        radius: 3.5,
        weight: 1,
        color: '#101216',
        fillColor: '#ffffff',
        fillOpacity: 1,
        interactive: false,
      }).addTo(layer)
    })
  }, [active, mode, points, hover])

  useMapEvents({
    click(event) {
      if (!active) return
      onAddPoint({lat: event.latlng.lat, lon: event.latlng.lng})
    },
    mousemove(event) {
      if (!active) return
      setHover({lat: event.latlng.lat, lon: event.latlng.lng})
    },
    mouseout() {
      setHover(null)
    },
  })

  return null
}

function CaptureRunner({
  token,
  footer,
  areaBBox,
  measure,
  onDone,
}: {
  token: number
  footer: string
  areaBBox: BBox
  measure: {mode: MeasureMode; points: LatLon[]}
  onDone: (result: {ok: boolean; error?: string}) => void
}) {
  const map = useMap()
  const lastToken = useRef(0)
  const onDoneRef = useRef(onDone)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    if (token === 0 || token === lastToken.current) return
    lastToken.current = token
    captureMapPng(map, {footer, areaBBox, measure})
      .then(blob => {
        downloadBlob(blob, captureFilename(new Date().toISOString().slice(0, 10)))
        onDoneRef.current({ok: true})
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('Map capture failed:', message)
        onDoneRef.current({ok: false, error: message})
      })
  }, [token, map, footer, areaBBox, measure])

  return null
}

function CursorReadout({onCursor}: {onCursor: (position: {lat: number; lon: number} | null) => void}) {
  useMapEvents({
    mousemove(event) {
      onCursor({lat: event.latlng.lat, lon: event.latlng.lng})
    },
    mouseout() {
      onCursor(null)
    },
  })
  return null
}

function ZoomSync({
  onZoom,
  onViewBBox,
}: {
  onZoom: (zoom: number) => void
  onViewBBox: (bbox: BBox) => void
}) {
  const map = useMap()
  const onZoomRef = useRef(onZoom)
  const onViewBBoxRef = useRef(onViewBBox)
  const bandRef = useRef('')
  const reportedBoxRef = useRef<BBox | null>(null)

  useEffect(() => {
    onZoomRef.current = onZoom
  }, [onZoom])

  useEffect(() => {
    onViewBBoxRef.current = onViewBBox
  }, [onViewBBox])

  useEffect(() => {
    let lastZoom = -1
    const report = () => {
      const z = map.getZoom()
      // Re-rendering the whole app for every zoom step is what makes a fast
      // gesture stutter. The app only needs the zoom band (hexagon level + the
      // switch to point detections), so report only when that band changes.
      const band = `${resForZoom(z)}|${z >= 8 ? 'points' : 'cells'}`
      const bandChanged = band !== bandRef.current
      const zoomChanged = z !== lastZoom
      lastZoom = z
      if (bandChanged) {
        bandRef.current = band
        onZoomRef.current(z)
      }
      // View bounds are only needed for panning and for the hexagon/point band
      // switch; reporting them for every zoom step re-renders the workspace and
      // stalls the animation.
      if (zoomChanged && !bandChanged) return
      const b = map.getBounds()
      // Longitudes stay unwrapped on purpose: a view that reaches past the dateline reports
      // 176…184 instead of being cut at 180, which is what loads the fires on the other side.
      const w = b.getWest()
      const s = Math.max(-90, Math.min(90, b.getSouth()))
      const e = b.getEast()
      const n = Math.max(-90, Math.min(90, b.getNorth()))
      if (w < e && s < n) {
        const next: BBox = [w, s, e, n]
        // A small pan or a half-level step changes the view by a few percent; telling
        // the app about it re-renders the whole workspace for nothing.
        const prev = reportedBoxRef.current
        const spanX = Math.abs(e - w)
        const spanY = Math.abs(n - s)
        const similar =
          prev !== null &&
          Math.abs(prev[0] - w) < spanX * 0.05 &&
          Math.abs(prev[2] - e) < spanX * 0.05 &&
          Math.abs(prev[1] - s) < spanY * 0.05 &&
          Math.abs(prev[3] - n) < spanY * 0.05
        if (!similar) {
          reportedBoxRef.current = next
          onViewBBoxRef.current(next)
        }
      }
    }
    // Zooming fires zoomend for every wheel step. Refetching cells and rebuilding
    // thousands of markers mid-gesture blocks the main thread for hundreds of
    // milliseconds, which makes the zoom jump instead of glide. Report once, after
    // the gesture has gone quiet, and keep a short cooldown so a rebuild that
    // delays the next wheel event cannot start the whole cycle again.
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastEvent = 0
    let lastReport = 0
    const fire = () => {
      if (Date.now() - lastEvent < SETTLE_MS) {
        schedule()
        return
      }
      lastReport = Date.now()
      report()
    }
    const schedule = () => {
      lastEvent = Date.now()
      if (timer) clearTimeout(timer)
      const wait = Math.max(SETTLE_MS, lastReport + COOLDOWN_MS - lastEvent)
      timer = setTimeout(fire, wait)
    }
    report()
    map.on('zoomend', schedule)
    map.on('moveend', schedule)
    return () => {
      if (timer) clearTimeout(timer)
      map.off('zoomend', schedule)
      map.off('moveend', schedule)
    }
  }, [map])

  return null
}

function MapHandle({onMapReady}: {onMapReady?: (map: L.Map) => void}) {
  const map = useMap()
  useEffect(() => {
    onMapReady?.(map)
  }, [map, onMapReady])
  return null
}

export function MapView({
  cells,
  bbox,
  res,
  zoom,
  rangeFrom,
  rangeTo,
  basemap,
  sensorsEnabled,
  areaSensors,
  drawing,
  measuring,
  measureMode,
  measurePoints,
  onMeasurePoint,
  captureToken,
  captureFooter,
  onCaptured,
  onBBox,
  onViewBBox,
  onCursor,
  onZoom,
  onMapReady,
}: MapViewProps) {
  const [selectedCell, setSelectedCell] = useState<Picked<Cell> | null>(null)
  const [cellSensors, setCellSensors] = useState<SensorTotals | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<Picked<PointDetection> | null>(null)
  const [points, setPoints] = useState<PointDetection[]>([])
  const [viewBBox, setViewBBox] = useState<BBox | null>(null)

  const handleViewBBox = (next: BBox) => {
    setViewBBox(next)
    onViewBBox?.(next)
  }

  const bothSensors = sensorsEnabled.MODIS && sensorsEnabled.VIIRS
  const noSensors = !sensorsEnabled.MODIS && !sensorsEnabled.VIIRS
  const singleSensor = !bothSensors && !noSensors
  const showPoints = zoom >= 8 || (cells.length > 0 && cells.length <= FEW_CELLS_THRESHOLD)
  const needPointsFetch = !noSensors && (showPoints || singleSensor)

  // A view that crosses the dateline needs two queries, one per side; everything else is one.
  const effectivePointsBoxes = useMemo<BBox[]>(() => {
    if (!viewBBox || zoom < 8) return [bbox]
    const boxes = clipToArea(bbox, viewBBox)
    return boxes.length ? boxes : [bbox]
  }, [bbox, viewBBox, zoom])

  const pointsQueryRef = useRef<{
    boxes: BBox[]
    from: string
    to: string
    limit: number
  } | null>(null)

  useEffect(() => {
    if (!needPointsFetch) {
      setPoints([])
      setSelectedPoint(null)
      pointsQueryRef.current = null
      return
    }
    if (showPoints) {
      setSelectedCell(null)
    }
    const limit = singleSensor && !showPoints ? 20000 : 5000
    // Panning and zoom steps only shift the view inside the area that is
    // already loaded; refetching there would rebuild thousands of markers for
    // nothing. Fetch again only when the view leaves the loaded area or gets small
    // enough that a denser query actually shows more fires.
    const previous = pointsQueryRef.current
    const reusable =
      previous !== null &&
      previous.from === rangeFrom &&
      previous.to === rangeTo &&
      previous.limit === limit &&
      effectivePointsBoxes.every(box => previous.boxes.some(outer => bboxCovers(outer, box))) &&
      boxesArea(effectivePointsBoxes) > boxesArea(previous.boxes) * 0.4
    if (reusable) return
    pointsQueryRef.current = {
      boxes: effectivePointsBoxes,
      from: rangeFrom,
      to: rangeTo,
      limit,
    }
    const controller = new AbortController()
    Promise.all(
      effectivePointsBoxes.map(box =>
        fetchPoints({bbox: box, from: rangeFrom, to: rangeTo, limit, offset: 0}, controller.signal),
      ),
    ).then(results => {
      if (results.every(result => result.status === 'ok' && result.data)) {
        setPoints(mergePoints(results.flatMap(result => result.data?.points ?? [])))
      }
    })
    return () => controller.abort()
  }, [needPointsFetch, showPoints, singleSensor, effectivePointsBoxes, rangeFrom, rangeTo])

  const filteredPoints = useMemo(() => {
    if (noSensors) return []
    if (bothSensors) return points
    return points.filter(point => {
      const s = point.sensor.toUpperCase()
      if (s === 'MODIS') return sensorsEnabled.MODIS
      if (s === 'VIIRS') return sensorsEnabled.VIIRS
      return true
    })
  }, [points, noSensors, bothSensors, sensorsEnabled])

  const visibleCells = useMemo<Cell[]>(() => {
    if (noSensors) return []
    if (bothSensors) return cells
    if (!filteredPoints.length) return []
    const parentRes = Math.min(res, 8)
    const buckets = new Map<string, {detections: number; frpSum: number}>()
    for (const point of filteredPoints) {
      const h3Cell =
        parentRes === 8 ? point.h3_r8 : h3.h3ToParent(point.h3_r8, parentRes)
      if (!h3Cell) continue
      const existing = buckets.get(h3Cell)
      if (existing) {
        existing.detections += 1
        existing.frpSum += point.frp_mw
      } else {
        buckets.set(h3Cell, {detections: 1, frpSum: point.frp_mw})
      }
    }
    return Array.from(buckets.entries())
      .map(([h3Id, item]) => ({
        h3: h3Id,
        detections: item.detections,
        mean_frp: Math.round((item.frpSum / item.detections) * 100) / 100,
      }))
      .sort((a, b) => b.detections - a.detections)
  }, [noSensors, bothSensors, cells, filteredPoints, res])

  const cuts = useMemo(() => {
    if (showPoints && filteredPoints.length > 0) {
      return frpCuts(filteredPoints.map(p => ({mean_frp: p.frp_mw})))
    }
    return frpCuts(visibleCells)
  }, [showPoints, filteredPoints, visibleCells])

  const labels = useMemo(() => frpStepLabels(cuts), [cuts])

  useEffect(() => {
    if (!selectedCell) {
      setCellSensors(null)
      return
    }
    const controller = new AbortController()
    setCellSensors(null)
    fetchCalendar(
      {h3_cells: [selectedCell.item.h3], from: rangeFrom, to: rangeTo, res},
      controller.signal,
    ).then(result => {
      if (result.status === 'ok' && result.data?.totals.sensors) {
        setCellSensors(result.data.totals.sensors)
      }
    })
    return () => controller.abort()
  }, [selectedCell, rangeFrom, rangeTo, res])

  const selectedAreaKm2 = useMemo(() => {
    if (!selectedCell) return 0
    return Math.round(h3.cellArea(selectedCell.item.h3, h3.UNITS.km2))
  }, [selectedCell])

  const sensorsToShow = cellSensors ?? areaSensors

  return (
    <div className={measuring ? 'map measuring' : 'map'} data-basemap={basemap}>
      <MapContainer
        center={[18, 8]}
        zoom={2}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        zoomSnap={1}
        zoomDelta={1}
        maxBounds={MAP_MAX_BOUNDS}
        maxBoundsViscosity={1}
        worldCopyJump
        preferCanvas
        attributionControl={false}
        style={{height: '100%', width: '100%'}}
      >
        {basemap === 'satellite' && (
          <TileLayer
            key="under-dark"
            className="under-osm"
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            crossOrigin="anonymous"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={UNDERLAY_NATIVE_ZOOM}
            updateWhenZooming={false}
            keepBuffer={1}
            zIndex={0}
            attribution="OpenStreetMap contributors"
          />
        )}
        {basemap === 'blue-marble' && (
          <TileLayer
            key="under-dark-marble"
            className="under-osm"
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            crossOrigin="anonymous"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={UNDERLAY_NATIVE_ZOOM}
            updateWhenZooming={false}
            keepBuffer={1}
            zIndex={0}
            attribution="OpenStreetMap contributors"
          />
        )}
        {basemap === 'satellite' && (
          <TileLayer
            key="satellite"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={SATELLITE_NATIVE_ZOOM}
            updateWhenZooming={false}
            keepBuffer={1}
            crossOrigin="anonymous"
            zIndex={1}
            eventHandlers={{tileload: hideNoDataTiles}}
            attribution="Esri, Maxar, Earthstar Geographics"
          />
        )}
        {basemap === 'dark' && (
          <TileLayer
            key="dark"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={DARK_NATIVE_ZOOM}
            updateWhenZooming={false}
            keepBuffer={1}
            crossOrigin="anonymous"
            attribution="Esri, HERE, Garmin, OpenStreetMap contributors"
          />
        )}
        {basemap === 'blue-marble' && (
          <TileLayer
            key="blue-marble"
            url="https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={BLUE_MARBLE_NATIVE_ZOOM}
            updateWhenZooming={false}
            keepBuffer={1}
            crossOrigin="anonymous"
            zIndex={1}
            eventHandlers={{tileload: hideNoDataTiles}}
            attribution="NASA GIBS Blue Marble"
          />
        )}
        <TileLayer
          key="borders"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
          maxZoom={MAX_ZOOM}
          maxNativeZoom={BORDERS_NATIVE_ZOOM}
          opacity={0.55}
          crossOrigin="anonymous"
          zIndex={2}
        />
        {!showPoints && (
          <Hotspots
            cells={visibleCells}
            cuts={cuts}
            onSelect={(cell, position) => setSelectedCell({item: cell, position})}
          />
        )}
        {showPoints && (
          <PointDetections
            points={filteredPoints}
            cuts={cuts}
            onSelect={(point, position) => setSelectedPoint({item: point, position})}
          />
        )}
        {!showPoints && selectedCell && (
          <Popup
            position={selectedCell.position}
            eventHandlers={{remove: () => setSelectedCell(null)}}
          >
            <div className="cell-popup">
              <div className="popup-row">
                <span>Detections</span>
                <b className="num">{formatCount(selectedCell.item.detections)}</b>
              </div>
              <div className="popup-row">
                <span>Mean fire power</span>
                <b className="num">{selectedCell.item.mean_frp.toFixed(1)} MW</b>
              </div>
              <div className="popup-row">
                <span>Area (km²)</span>
                <b className="num">{formatCount(selectedAreaKm2)} km²</b>
              </div>
              {sensorsToShow && (
                <div className="popup-row">
                  <span>Sensors</span>
                  <b className="num">
                    MODIS {formatCount(sensorsToShow.MODIS)} · VIIRS {formatCount(sensorsToShow.VIIRS)}
                  </b>
                </div>
              )}
            </div>
          </Popup>
        )}
        {showPoints && selectedPoint && (
          <Popup
            position={selectedPoint.position}
            eventHandlers={{remove: () => setSelectedPoint(null)}}
          >
            <div className="cell-popup">
              <div className="popup-row">
                <span>Latitude</span>
                <b className="num">{selectedPoint.item.lat.toFixed(5)}</b>
              </div>
              <div className="popup-row">
                <span>Longitude</span>
                <b className="num">{selectedPoint.item.lon.toFixed(5)}</b>
              </div>
              <div className="popup-row">
                <span>Date</span>
                <b className="num">{selectedPoint.item.ts}</b>
              </div>
              <div className="popup-row">
                <span>Time (UTC)</span>
                <b className="num">{selectedPoint.item.time_utc ?? '—'}</b>
              </div>
              <div className="popup-row">
                <span>Confidence</span>
                <b className="num">
                  {formatConfidence(selectedPoint.item.sensor, selectedPoint.item.confidence_pct)}
                </b>
              </div>
              <div className="popup-row">
                <span>Fire power (MW)</span>
                <b className="num">{selectedPoint.item.frp_mw.toFixed(2)} MW</b>
              </div>
              <div className="popup-row">
                <span>Sensor</span>
                <b className="num">{selectedPoint.item.sensor}</b>
              </div>
              <div className="popup-row">
                <span>Satellite</span>
                <b className="num">{formatSatellite(selectedPoint.item.satellite)}</b>
              </div>
              <div className="popup-row">
                <span>Day/Night</span>
                <b className="num">{formatDayNight(selectedPoint.item.daynight)}</b>
              </div>
            </div>
          </Popup>
        )}
        <AreaOutline bbox={bbox} active={drawing && !measuring} />
        <FitToArea bbox={bbox} />
        <DrawRectangle active={drawing && !measuring} onDone={onBBox} />
        <MeasureTool
          active={measuring}
          mode={measureMode}
          points={measurePoints}
          onAddPoint={onMeasurePoint}
        />
        <CaptureRunner
          token={captureToken}
          footer={captureFooter}
          areaBBox={bbox}
          measure={{mode: measureMode, points: measurePoints}}
          onDone={onCaptured}
        />
        <CursorReadout onCursor={onCursor} />
        <ZoomSync onZoom={onZoom} onViewBBox={handleViewBBox} />
        <MapHandle onMapReady={onMapReady} />
        <SmoothWheelZoom />
        <ScaleControl position="bottomleft" imperial metric maxWidth={150} />
        <AttributionControl position="bottomleft" prefix={false} />
      </MapContainer>

      <div className="map-legend" role="region" aria-label="Fire radiative power legend">
        <div className="map-legend-title">Fire power (MW)</div>
        <div className="legend">
          {labels.map((label, index) => (
            <span className="legend-step" key={index}>
              <span className="legend-bar" style={{background: FIRE_RAMP[index]}} />
              <span className="legend-value">{label}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="nasa-corner" aria-hidden="true">
        NASA · FIRMS
      </div>
    </div>
  )
}
