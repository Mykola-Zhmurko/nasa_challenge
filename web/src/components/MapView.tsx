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
import type {BBox, Cell, SensorTotals} from '../../lib/api'
import {fetchCalendar} from '../../lib/api'
import {FIRE_RAMP, formatCount, frpCuts, frpRampColor, frpStepLabels} from '../../lib/ramp'
import {MAX_ZOOM, MIN_ZOOM, SAT_NATIVE_ZOOM} from '../../lib/zoom'

export type Basemap = 'dark' | 'canvas'

interface MapViewProps {
  cells: Cell[]
  bbox: BBox
  res: number
  rangeFrom: string
  rangeTo: string
  basemap: Basemap
  onBasemap: (basemap: Basemap) => void
  areaSensors?: SensorTotals
  drawing: boolean
  onBBox: (bbox: BBox) => void
  onCursor: (position: {lat: number; lon: number} | null) => void
  onZoom: (zoom: number) => void
}

const MAX_CELLS = 20000

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
      const marker = L.circleMarker([lat, lng], {
        renderer,
        radius,
        stroke: true,
        weight: 0.6,
        color: 'rgba(11, 12, 14, 0.72)',
        fillColor: frpRampColor(cell.mean_frp, cuts),
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
  }, [cells, cuts, map])

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
      {paddingTopLeft: [24, 24], paddingBottomRight: [352, 24], animate: false},
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

function ZoomSync({onZoom}: {onZoom: (zoom: number) => void}) {
  const map = useMap()
  const onZoomRef = useRef(onZoom)

  useEffect(() => {
    onZoomRef.current = onZoom
  }, [onZoom])

  useEffect(() => {
    const report = () => onZoomRef.current(map.getZoom())
    report()
    map.on('zoomend', report)
    return () => {
      map.off('zoomend', report)
    }
  }, [map])

  return null
}

export function MapView({
  cells,
  bbox,
  res,
  rangeFrom,
  rangeTo,
  basemap,
  onBasemap,
  areaSensors,
  drawing,
  onBBox,
  onCursor,
  onZoom,
}: MapViewProps) {
  const [selectedCell, setSelectedCell] = useState<Cell | null>(null)
  const [cellSensors, setCellSensors] = useState<SensorTotals | null>(null)

  const cuts = useMemo(() => frpCuts(cells), [cells])
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
            url="https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={SAT_NATIVE_ZOOM}
            attribution='<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>'
          />
        ) : (
          <TileLayer
            key="canvas"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"
            maxZoom={MAX_ZOOM}
            maxNativeZoom={16}
            attribution="Esri, HERE, Garmin, OpenStreetMap contributors"
          />
        )}
        <Hotspots cells={cells} cuts={cuts} onSelect={setSelectedCell} />
        {selectedCell && selectedPos && (
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
        <AreaOutline bbox={bbox} />
        <FitToArea bbox={bbox} />
        <DrawRectangle active={drawing} onDone={onBBox} />
        <CursorReadout onCursor={onCursor} />
        <ZoomSync onZoom={onZoom} />
        <ScaleControl position="bottomleft" imperial metric maxWidth={150} />
        <AttributionControl position="bottomleft" prefix={false} />
      </MapContainer>

      <div className="map-switch" role="group" aria-label="Basemap">
        <button
          type="button"
          aria-pressed={basemap === 'dark'}
          onClick={() => onBasemap('dark')}
        >
          Dark
        </button>
        <button
          type="button"
          aria-pressed={basemap === 'canvas'}
          onClick={() => onBasemap('canvas')}
        >
          Canvas
        </button>
      </div>

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
        <div className="map-legend-sub">Dots = H3 cells, size = number of detections</div>
      </div>
    </div>
  )
}
