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
import {
  BLUE_MARBLE_NATIVE_ZOOM,
  BORDERS_NATIVE_ZOOM,
  DARK_NATIVE_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  SATELLITE_NATIVE_ZOOM,
  UNDERLAY_NATIVE_ZOOM,
  resForZoom,
} from '../../lib/zoom'

export type Basemap = 'satellite' | 'dark' | 'blue-marble'

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
  onBBox: (bbox: BBox) => void
  onCursor: (position: {lat: number; lon: number} | null) => void
  onZoom: (zoom: number) => void
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

function Hotspots({
  cells,
  cuts,
  onSelect,
}: {
  cells: Cell[]
  cuts: number[]
  onSelect: (cell: Cell) => void
}) {
  const map = useMap()
  const group = useRef<L.LayerGroup | null>(null)
  const rendererRef = useRef<L.Canvas | null>(null)
  const onSelectRef = useRef(onSelect)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    if (!group.current) {
      group.current = L.layerGroup().addTo(map)
    }
    const layer = group.current
    layer.clearLayers()
    if (!cells.length) return

    const visible = cells.length > MAX_CELLS ? cells.slice(0, MAX_CELLS) : cells
    const renderer = (rendererRef.current ??= L.canvas({padding: 0.4}))
    const withTooltips = visible.length <= TOOLTIP_LIMIT
    const maxDetections = visible.reduce((peak, cell) => Math.max(peak, cell.detections), 1)
    const scale = Math.sqrt(maxDetections)

    visible.forEach(cell => {
      const [lat, lng] = cellCentre(cell.h3)
      const radius = 3 + (Math.sqrt(cell.detections) / scale) * 4
      const fillColor = frpRampColor(cell.mean_frp, cuts)
      const marker = L.circleMarker([lat, lng], {
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
        onSelectRef.current(cell)
      })
      layer.addLayer(marker)
    })
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
  onSelect: (point: PointDetection) => void
}) {
  const map = useMap()
  const group = useRef<L.LayerGroup | null>(null)
  const rendererRef = useRef<L.Canvas | null>(null)
  const onSelectRef = useRef(onSelect)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    if (!group.current) {
      group.current = L.layerGroup().addTo(map)
    }
    const layer = group.current
    layer.clearLayers()
    if (!points.length) return

    const renderer = (rendererRef.current ??= L.canvas({padding: 0.4}))
    const withTooltips = points.length <= TOOLTIP_LIMIT

    points.forEach(point => {
      const fillColor = frpRampColor(point.frp_mw, cuts)
      const marker = L.circleMarker([point.lat, point.lon], {
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
        onSelectRef.current(point)
      })
      layer.addLayer(marker)
    })
  }, [points, cuts, map])

  useEffect(() => {
    return () => {
      group.current?.clearLayers()
    }
  }, [])

  return null
}

function AreaOutline({bbox}: {bbox: BBox}) {
  const map = useMap()
  const layer = useRef<L.Rectangle | null>(null)

  useEffect(() => {
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
  }, [bbox, map])

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
      // Re-rendering the whole app for every half-zoom step is what makes a fast
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
      const w = Math.max(-180, Math.min(180, b.getWest()))
      const s = Math.max(-90, Math.min(90, b.getSouth()))
      const e = Math.max(-180, Math.min(180, b.getEast()))
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
      ;(window as unknown as {__reports?: number}).__reports =
        ((window as unknown as {__reports?: number}).__reports ?? 0) + 1
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
    ;(window as unknown as {__map?: L.Map}).__map = map
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
  onBBox,
  onCursor,
  onZoom,
}: MapViewProps) {
  const [selectedCell, setSelectedCell] = useState<Cell | null>(null)
  const [cellSensors, setCellSensors] = useState<SensorTotals | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<PointDetection | null>(null)
  const [points, setPoints] = useState<PointDetection[]>([])
  const [viewBBox, setViewBBox] = useState<BBox | null>(null)

  const bothSensors = sensorsEnabled.MODIS && sensorsEnabled.VIIRS
  const noSensors = !sensorsEnabled.MODIS && !sensorsEnabled.VIIRS
  const singleSensor = !bothSensors && !noSensors
  const showPoints = zoom >= 8 || (cells.length > 0 && cells.length <= FEW_CELLS_THRESHOLD)
  const needPointsFetch = !noSensors && (showPoints || singleSensor)

  const effectivePointsBBox = useMemo<BBox>(() => {
    if (!viewBBox || zoom < 8) return bbox
    const minLon = Math.max(bbox[0], viewBBox[0])
    const minLat = Math.max(bbox[1], viewBBox[1])
    const maxLon = Math.min(bbox[2], viewBBox[2])
    const maxLat = Math.min(bbox[3], viewBBox[3])
    if (minLon < maxLon && minLat < maxLat) {
      return [minLon, minLat, maxLon, maxLat]
    }
    return bbox
  }, [bbox, viewBBox, zoom])

  const pointsQueryRef = useRef<{bbox: BBox; from: string; to: string; limit: number} | null>(
    null,
  )

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
    // Panning and half-level zoom steps only shift the view inside the area that is
    // already loaded; refetching there would rebuild thousands of markers for
    // nothing. Fetch again only when the view leaves the loaded area or gets small
    // enough that a denser query actually shows more fires.
    const previous = pointsQueryRef.current
    const reusable =
      previous !== null &&
      previous.from === rangeFrom &&
      previous.to === rangeTo &&
      previous.limit === limit &&
      bboxCovers(previous.bbox, effectivePointsBBox) &&
      bboxArea(effectivePointsBBox) > bboxArea(previous.bbox) * 0.4
    if (reusable) return
    pointsQueryRef.current = {
      bbox: effectivePointsBBox,
      from: rangeFrom,
      to: rangeTo,
      limit,
    }
    const controller = new AbortController()
    fetchPoints(
      {bbox: effectivePointsBBox, from: rangeFrom, to: rangeTo, limit, offset: 0},
      controller.signal,
    ).then(result => {
      if (result.status === 'ok' && result.data) {
        setPoints(result.data.points)
      }
    })
    return () => controller.abort()
  }, [needPointsFetch, showPoints, singleSensor, effectivePointsBBox, rangeFrom, rangeTo])

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
      {h3_cells: [selectedCell.h3], from: rangeFrom, to: rangeTo, res},
      controller.signal,
    ).then(result => {
      if (result.status === 'ok' && result.data?.totals.sensors) {
        setCellSensors(result.data.totals.sensors)
      }
    })
    return () => controller.abort()
  }, [selectedCell, rangeFrom, rangeTo, res])

  const selectedPos = useMemo<[number, number] | null>(() => {
    if (!selectedCell) return null
    const [lat = 0, lng = 0] = h3.h3ToGeo(selectedCell.h3)
    return [lat, lng]
  }, [selectedCell])

  const selectedAreaKm2 = useMemo(() => {
    if (!selectedCell) return 0
    return Math.round(h3.cellArea(selectedCell.h3, h3.UNITS.km2))
  }, [selectedCell])

  const sensorsToShow = cellSensors ?? areaSensors

  return (
    <div className="map" data-basemap={basemap}>
      <MapContainer
        center={[18, 8]}
        zoom={2}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        zoomSnap={0.5}
        zoomDelta={0.5}
        wheelPxPerZoomLevel={120}
        wheelDebounceTime={40}
        worldCopyJump
        preferCanvas
        attributionControl={false}
        style={{height: '100%', width: '100%'}}
      >
        {basemap === 'satellite' && (
          <TileLayer
            key="under-dark"
            url="https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={UNDERLAY_NATIVE_ZOOM}
            updateWhenZooming={false}
            keepBuffer={1}
            zIndex={0}
            attribution="OpenStreetMap contributors, CARTO"
          />
        )}
        {basemap === 'blue-marble' && (
          <TileLayer
            key="under-dark-marble"
            url="https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={UNDERLAY_NATIVE_ZOOM}
            updateWhenZooming={false}
            keepBuffer={1}
            zIndex={0}
            attribution="OpenStreetMap contributors, CARTO"
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
          zIndex={2}
        />
        {!showPoints && (
          <Hotspots
            cells={visibleCells}
            cuts={cuts}
            onSelect={setSelectedCell}
          />
        )}
        {showPoints && (
          <PointDetections
            points={filteredPoints}
            cuts={cuts}
            onSelect={setSelectedPoint}
          />
        )}
        {!showPoints && selectedCell && selectedPos && (
          <Popup
            position={selectedPos}
            eventHandlers={{remove: () => setSelectedCell(null)}}
          >
            <div className="cell-popup">
              <div className="popup-row">
                <span>Cell ID</span>
                <b className="num">{selectedCell.h3}</b>
              </div>
              <div className="popup-row">
                <span>Detections</span>
                <b className="num">{formatCount(selectedCell.detections)}</b>
              </div>
              <div className="popup-row">
                <span>Mean FRP</span>
                <b className="num">{selectedCell.mean_frp.toFixed(1)} MW</b>
              </div>
              <div className="popup-row">
                <span>Hexagon area (km²)</span>
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
            position={[selectedPoint.lat, selectedPoint.lon]}
            eventHandlers={{remove: () => setSelectedPoint(null)}}
          >
            <div className="cell-popup">
              <div className="popup-row">
                <span>Latitude</span>
                <b className="num">{selectedPoint.lat.toFixed(5)}</b>
              </div>
              <div className="popup-row">
                <span>Longitude</span>
                <b className="num">{selectedPoint.lon.toFixed(5)}</b>
              </div>
              <div className="popup-row">
                <span>Acquisition date</span>
                <b className="num">{selectedPoint.ts}</b>
              </div>
              <div className="popup-row">
                <span>Acquisition time (UTC)</span>
                <b className="num">{selectedPoint.time_utc ?? 'Daily (no UTC time)'}</b>
              </div>
              <div className="popup-row">
                <span>Confidence</span>
                <b className="num">
                  {formatConfidence(selectedPoint.sensor, selectedPoint.confidence_pct)}
                </b>
              </div>
              <div className="popup-row">
                <span>FRP (MW)</span>
                <b className="num">{selectedPoint.frp_mw.toFixed(2)} MW</b>
              </div>
              <div className="popup-row">
                <span>Sensor</span>
                <b className="num">{selectedPoint.sensor}</b>
              </div>
              <div className="popup-row">
                <span>Satellite</span>
                <b className="num">{formatSatellite(selectedPoint.satellite)}</b>
              </div>
              <div className="popup-row">
                <span>Day/Night</span>
                <b className="num">{formatDayNight(selectedPoint.daynight)}</b>
              </div>
            </div>
          </Popup>
        )}
        <AreaOutline bbox={bbox} />
        <FitToArea bbox={bbox} />
        <DrawRectangle active={drawing} onDone={onBBox} />
        <CursorReadout onCursor={onCursor} />
        <ZoomSync onZoom={onZoom} onViewBBox={setViewBBox} />
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
        <div className="map-legend-sub">
          {showPoints
            ? `Colour encodes detection FRP (MW) · ${formatCount(filteredPoints.length)} detections`
            : `Colour encodes mean FRP (MW) · ${formatCount(visibleCells.length)} H3 cells, size = detections`}
        </div>
      </div>

      <div className="nasa-corner" aria-hidden="true">
        NASA · FIRMS
      </div>
    </div>
  )
}
