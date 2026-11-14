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
  AGE_LABELS,
  AGE_RAMP,
  type ColourMode,
  FIRE_RAMP,
  ageRampColor,
  formatConfidence,
  formatCount,
  formatDayNight,
  formatSatellite,
  frpCuts,
  frpRampColor,
  frpStepLabels,
  parseDetectionTimestampMs,
} from '../../lib/ramp'
import {
  BLUE_MARBLE_NATIVE_ZOOM,
  BORDERS_NATIVE_ZOOM,
  DARK_NATIVE_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
} from '../../lib/zoom'

export type Basemap = 'dark' | 'blue-marble'

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
  colourBy: ColourMode
  sensorsEnabled: SensorsEnabled
  areaSensors?: SensorTotals
  drawing: boolean
  onBBox: (bbox: BBox) => void
  onCursor: (position: {lat: number; lon: number} | null) => void
  onZoom: (zoom: number) => void
}

const MAX_CELLS = 20000
const FEW_CELLS_THRESHOLD = 150

function Hotspots({
  cells,
  cuts,
  colourBy,
  onSelect,
}: {
  cells: Cell[]
  cuts: number[]
  colourBy: ColourMode
  onSelect: (cell: Cell) => void
}) {
  const map = useMap()
  const group = useRef<L.LayerGroup | null>(null)
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
    const renderer = L.canvas({padding: 0.4})
    const maxDetections = visible.reduce((peak, cell) => Math.max(peak, cell.detections), 1)
    const scale = Math.sqrt(maxDetections)

    visible.forEach(cell => {
      const [lat = 0, lng = 0] = h3.h3ToGeo(cell.h3)
      const radius = 3 + (Math.sqrt(cell.detections) / scale) * 4
      const fillColor =
        colourBy === 'age' ? AGE_RAMP[3] : frpRampColor(cell.mean_frp, cuts)
      const marker = L.circleMarker([lat, lng], {
        renderer,
        radius,
        stroke: true,
        weight: 0.6,
        color: 'rgba(11, 12, 14, 0.72)',
        fillColor,
        fillOpacity: 0.92,
      })
      marker.bindTooltip(
        `${formatCount(cell.detections)} detections · ${cell.mean_frp.toFixed(1)} MW`,
        {direction: 'top', className: 'tip', sticky: true},
      )
      marker.on('click', event => {
        L.DomEvent.stopPropagation(event)
        onSelectRef.current(cell)
      })
      layer.addLayer(marker)
    })
  }, [cells, cuts, colourBy, map])

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
  colourBy,
  newestMs,
  onSelect,
}: {
  points: PointDetection[]
  cuts: number[]
  colourBy: ColourMode
  newestMs: number | null
  onSelect: (point: PointDetection) => void
}) {
  const map = useMap()
  const group = useRef<L.LayerGroup | null>(null)
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

    const renderer = L.canvas({padding: 0.4})

    points.forEach(point => {
      const fillColor =
        colourBy === 'age'
          ? ageRampColor(point.ts, point.time_utc, newestMs)
          : frpRampColor(point.frp_mw, cuts)
      const marker = L.circleMarker([point.lat, point.lon], {
        renderer,
        radius: 4.5,
        stroke: true,
        weight: 0.7,
        color: 'rgba(11, 12, 14, 0.8)',
        fillColor,
        fillOpacity: 0.94,
      })
      marker.bindTooltip(
        `${point.sensor} · ${point.frp_mw.toFixed(2)} MW · ${point.ts}`,
        {direction: 'top', className: 'tip', sticky: true},
      )
      marker.on('click', event => {
        L.DomEvent.stopPropagation(event)
        onSelectRef.current(point)
      })
      layer.addLayer(marker)
    })
  }, [points, cuts, colourBy, newestMs, map])

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

  useEffect(() => {
    onZoomRef.current = onZoom
  }, [onZoom])

  useEffect(() => {
    onViewBBoxRef.current = onViewBBox
  }, [onViewBBox])

  useEffect(() => {
    const report = () => {
      onZoomRef.current(map.getZoom())
      const b = map.getBounds()
      const w = Math.max(-180, Math.min(180, b.getWest()))
      const s = Math.max(-90, Math.min(90, b.getSouth()))
      const e = Math.max(-180, Math.min(180, b.getEast()))
      const n = Math.max(-90, Math.min(90, b.getNorth()))
      if (w < e && s < n) {
        onViewBBoxRef.current([w, s, e, n])
      }
    }
    report()
    map.on('zoomend', report)
    map.on('moveend', report)
    return () => {
      map.off('zoomend', report)
      map.off('moveend', report)
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
  colourBy,
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

  useEffect(() => {
    if (!needPointsFetch) {
      setPoints([])
      setSelectedPoint(null)
      return
    }
    if (showPoints) {
      setSelectedCell(null)
    }
    const controller = new AbortController()
    const limit = singleSensor && !showPoints ? 20000 : 5000
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

  const newestPointMs = useMemo<number | null>(() => {
    let best: number | null = null
    for (const p of filteredPoints) {
      const ms = parseDetectionTimestampMs(p.ts, p.time_utc)
      if (ms !== null && (best === null || ms > best)) {
        best = ms
      }
    }
    return best
  }, [filteredPoints])

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
        zoomSnap={1}
        zoomDelta={1}
        wheelPxPerZoomLevel={90}
        worldCopyJump
        preferCanvas
        attributionControl={false}
        style={{height: '100%', width: '100%'}}
      >
        {basemap === 'dark' ? (
          <TileLayer
            key="dark"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={DARK_NATIVE_ZOOM}
            attribution="Esri, HERE, Garmin, OpenStreetMap contributors"
          />
        ) : (
          <TileLayer
            key="blue-marble"
            url="https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={BLUE_MARBLE_NATIVE_ZOOM}
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
            colourBy={colourBy}
            onSelect={setSelectedCell}
          />
        )}
        {showPoints && (
          <PointDetections
            points={filteredPoints}
            cuts={cuts}
            colourBy={colourBy}
            newestMs={newestPointMs}
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
                <span>Cell area</span>
                <b className="num">{formatCount(selectedAreaKm2)} km2</b>
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

      {colourBy === 'frp' ? (
        <div className="map-legend" role="region" aria-label="Fire radiative power legend">
          <div className="map-legend-title">Fire radiative power (MW)</div>
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
              ? `Dots = ${formatCount(filteredPoints.length)} individual detections, ordered by FRP (MW)`
              : `Dots = ${formatCount(visibleCells.length)} H3 cells, size = detections`}
          </div>
        </div>
      ) : (
        <div className="map-legend" role="region" aria-label="Detection age legend">
          <div className="map-legend-title">Time since detection (hours)</div>
          <div className="legend" style={{gridTemplateColumns: 'repeat(4, 1fr)'}}>
            {AGE_LABELS.map((label, index) => (
              <span className="legend-step" key={label}>
                <span className="legend-bar" style={{background: AGE_RAMP[index]}} />
                <span className="legend-value">{label}</span>
              </span>
            ))}
          </div>
          <div className="map-legend-sub">
            Only date is known (no UTC time); whole days treated as older than 24 h
          </div>
        </div>
      )}

      <div className="nasa-corner" aria-hidden="true">
        NASA · FIRMS
      </div>
    </div>
  )
}
