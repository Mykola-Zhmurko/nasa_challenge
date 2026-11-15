import {useEffect, useMemo, useRef, useState} from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import '../styles/tokens.css'
import '../styles/app.css'
import type {BBox, CalendarResponse, Cell, Health, SensorTotals, Status} from '../lib/api'
import {exportCsvHref, fetchCalendar, fetchCells, fetchHealth} from '../lib/api'
import {formatDay, shiftIsoDate} from '../lib/ramp'
import {bboxAreaKm2, bboxInside, monthComparison, rangeActivity} from '../lib/insights'
import {resForZoom} from '../lib/zoom'
import {formatArea, formatDistance, pathLengthM, ringAreaM2, type LatLon} from '../lib/measure'
import {clampRange, isIsoDate, type DateWindow} from '../lib/range'
import {buildShareUrl} from './lib/share'
import {TopBar} from './components/TopBar'
import {ControlPanel, type ModeTab, type Preset, type TimeRangePreset} from './components/ControlPanel'
import {MapView, type Basemap, type MeasureMode, type SensorsEnabled} from './components/MapView'
import {TimelineBar} from './components/TimelineBar'
import {CalendarSheet} from './components/CalendarSheet'

const PRESETS: Preset[] = [
  {id: 'world', label: 'World', bbox: [-180, -58, 180, 72]},
  {id: 'africa', label: 'Africa', bbox: [-20, -35, 52, 38]},
  {id: 'asia', label: 'Asia', bbox: [26, -11, 180, 78]},
  {id: 'europe', label: 'Europe', bbox: [-25, 34, 45, 72]},
  {id: 'north-america', label: 'North America', bbox: [-170, 5, -50, 75]},
  {id: 'south-america', label: 'South America', bbox: [-82, -56, -34, 13]},
  {id: 'oceania', label: 'Oceania', bbox: [110, -48, 180, 0]},
]

const FALLBACK_WINDOW = {from: '2026-11-07', to: '2026-11-14'}
const DISCLAIMER_STORAGE_KEY = 'fire_calendar_disclaimer_hide'

/** A preset replaces a shared custom window, so drop it from the address bar too. */
function clearCustomWindowFromUrl() {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.search)
  if (!params.has('from') && !params.has('to')) return
  params.delete('from')
  params.delete('to')
  const query = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
}

interface InitialUrlState {
  bbox: BBox
  areaId: string
  rangePreset: TimeRangePreset
  day: string | null
  customRange: DateWindow | null
  pinnedRes: number | null
  basemap: Basemap
  sensorsEnabled: SensorsEnabled
}

function readInitialUrlState(): InitialUrlState {
  const defaults: InitialUrlState = {
    bbox: PRESETS[0]?.bbox ?? [-180, -58, 180, 72],
    areaId: 'world',
    rangePreset: '7d',
    day: null,
    customRange: null,
    pinnedRes: null,
    basemap: 'satellite',
    sensorsEnabled: {MODIS: true, VIIRS: true},
  }
  if (typeof window === 'undefined') return defaults

  const params = new URLSearchParams(window.location.search)
  const rawBBox = params.get('bbox')
  if (rawBBox) {
    const parts = rawBBox.split(',').map(Number)
    if (
      parts.length === 4 &&
      parts.every(Number.isFinite) &&
      (parts[0] ?? 0) < (parts[2] ?? 0) &&
      (parts[1] ?? 0) < (parts[3] ?? 0)
    ) {
      defaults.bbox = [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
      const matchingPreset = PRESETS.find(
        p => p.bbox.map(n => n.toFixed(2)).join(',') === defaults.bbox.map(n => n.toFixed(2)).join(','),
      )
      defaults.areaId = matchingPreset ? matchingPreset.id : 'custom'
    }
  }

  const rawRange = params.get('range')
  if (rawRange === '24h' || rawRange === '3d' || rawRange === '7d') {
    defaults.rangePreset = rawRange
  }

  const rawDay = params.get('day')
  if (rawDay && /^\d{4}-\d{2}-\d{2}$/.test(rawDay)) {
    defaults.day = rawDay
    defaults.rangePreset = 'day'
  }

  const rawFrom = params.get('from')
  const rawTo = params.get('to')
  if (!defaults.day && rawFrom && rawTo && isIsoDate(rawFrom) && isIsoDate(rawTo)) {
    defaults.customRange = rawFrom <= rawTo ? {from: rawFrom, to: rawTo} : {from: rawTo, to: rawFrom}
    defaults.rangePreset = 'custom'
  }

  const rawRes = params.get('res')
  if (rawRes && rawRes !== 'auto') {
    const parsed = Number(rawRes)
    if (Number.isInteger(parsed)) {
      defaults.pinnedRes = Math.min(7, Math.max(4, parsed))
    }
  }

  const rawBasemap = params.get('basemap')
  if (rawBasemap === 'satellite' || rawBasemap === 'dark' || rawBasemap === 'blue-marble') {
    defaults.basemap = rawBasemap
  }

  const rawSensors = params.get('sensors')
  if (rawSensors) {
    const tokens = rawSensors.toUpperCase().split(',')
    defaults.sensorsEnabled = {
      MODIS: tokens.includes('MODIS'),
      VIIRS: tokens.includes('VIIRS'),
    }
  }

  return defaults
}

export default function App() {
  const initial = useMemo(() => readInitialUrlState(), [])

  const [health, setHealth] = useState<Health | null>(null)
  const [bbox, setBBox] = useState<BBox>(initial.bbox)
  const [viewBBox, setViewBBox] = useState<BBox | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const [areaId, setAreaId] = useState(initial.areaId)
  const [zoom, setZoom] = useState(2)
  const [pinnedRes, setPinnedRes] = useState<number | null>(initial.pinnedRes)
  const res = pinnedRes ?? resForZoom(zoom)
  const [basemap, setBasemap] = useState<Basemap>(initial.basemap)
  const [sensorsEnabled, setSensorsEnabled] = useState<SensorsEnabled>(initial.sensorsEnabled)
  const [rangePreset, setRangePreset] = useState<TimeRangePreset>(initial.rangePreset)
  const [day, setDay] = useState<string | null>(initial.day)
  const [customRange, setCustomRange] = useState<DateWindow | null>(initial.customRange)
  const [modeTab, setModeTab] = useState<ModeTab>('simple')

  const [drawing, setDrawing] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  const [measureMode, setMeasureMode] = useState<MeasureMode>('distance')
  const [measurePoints, setMeasurePoints] = useState<LatLon[]>([])
  const [captureToken, setCaptureToken] = useState(0)
  const [captureState, setCaptureState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle')
  const [playing, setPlaying] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 960)
  const [shareCopied, setShareCopied] = useState(false)

  const [disclaimerOpen, setDisclaimerOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    try {
      return window.localStorage.getItem(DISCLAIMER_STORAGE_KEY) !== '1'
    } catch {
      return true
    }
  })
  const [dontShowAgain, setDontShowAgain] = useState(false)

  const [reload, setReload] = useState(0)
  const [cursor, setCursor] = useState<{lat: number; lon: number} | null>(null)

  const [cells, setCells] = useState<Cell[]>([])
  const [cellsStatus, setCellsStatus] = useState<Status>('loading')
  const [cellsError, setCellsError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  const [calendar, setCalendar] = useState<CalendarResponse | null>(null)
  const [calendarStatus, setCalendarStatus] = useState<Status>('loading')
  const [rangeSensors, setRangeSensors] = useState<SensorTotals | undefined>(undefined)

  const from = health?.min_ts ?? FALLBACK_WINDOW.from
  const to = health?.max_ts ?? FALLBACK_WINDOW.to

  const {rangeFrom, rangeTo} = useMemo(() => {
    if (day) return {rangeFrom: day, rangeTo: day}
    if (rangePreset === 'custom' && customRange) return {rangeFrom: customRange.from, rangeTo: customRange.to}
    if (rangePreset === '24h') return {rangeFrom: to, rangeTo: to}
    if (rangePreset === '3d') return {rangeFrom: shiftIsoDate(to, -2, from), rangeTo: to}
    return {rangeFrom: shiftIsoDate(to, -7, from), rangeTo: to}
  }, [day, customRange, rangePreset, from, to])

  const dayRef = useRef(day)
  useEffect(() => {
    dayRef.current = day
  }, [day])

  const enabledSensors = useMemo(
    () => (['MODIS', 'VIIRS'] as const).filter(s => sensorsEnabled[s]),
    [sensorsEnabled],
  )

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal).then(result => {
      if (result.status === 'idle') return
      setHealth(result.data)
    })
    return () => controller.abort()
  }, [reload])

  useEffect(() => {
    // From zoom 8 on the map draws individual detections, so hexagon cells are not
    // visible; refetching them on every zoom band only costs time.
    if (zoom >= 8) return
    const controller = new AbortController()
    setCellsStatus('loading')
    fetchCells({res, from: rangeFrom, to: rangeTo, bbox, sensors: enabledSensors}, controller.signal).then(result => {
      if (result.status === 'idle') return
      setCellsStatus(result.status)
      setCellsError(result.error)
      setCells(result.data?.cells ?? [])
      setTruncated(result.data?.truncated ?? false)
    })
    return () => controller.abort()
  }, [bbox, res, rangeFrom, rangeTo, reload, zoom, enabledSensors])

  useEffect(() => {
    const controller = new AbortController()
    setCalendarStatus('loading')
    fetchCalendar({bbox, from, to, res}, controller.signal).then(result => {
      if (result.status === 'idle') return
      setCalendarStatus(result.status)
      setCalendar(result.data)
    })
    return () => controller.abort()
  }, [bbox, from, to, res, reload])

  const calendarSensorsRef = useRef<CalendarResponse['totals']['sensors'] | undefined>(undefined)
  useEffect(() => {
    calendarSensorsRef.current = calendar?.totals.sensors
  }, [calendar])

  useEffect(() => {
    if (rangeFrom === from && rangeTo === to) {
      setRangeSensors(calendarSensorsRef.current)
      return
    }
    const controller = new AbortController()
    fetchCalendar({bbox, from: rangeFrom, to: rangeTo, res}, controller.signal).then(result => {
      if (result.status === 'ok' && result.data?.totals.sensors) {
        setRangeSensors(result.data.totals.sensors)
      }
    })
    return () => controller.abort()
  }, [bbox, from, to, rangeFrom, rangeTo, res])

  useEffect(() => {
    if (!playing) return
    const list = calendar?.days ?? []
    if (!list.length) {
      setPlaying(false)
      return
    }
    const timer = setInterval(() => {
      const current = dayRef.current
      const index = current ? list.findIndex(item => item.date === current) : -1
      const next = index + 1
      const upcoming = list[next]
      if (!upcoming) {
        setPlaying(false)
        return
      }
      setDay(upcoming.date)
      setRangePreset('day')
    }, 900)
    return () => clearInterval(timer)
  }, [playing, calendar])

  const totals = useMemo(() => {
    const activeDays = (calendar?.days ?? []).filter(
      item => item.date >= rangeFrom && item.date <= rangeTo,
    )
    // A window without rows must read 0, never the dataset total: otherwise an
    // empty period claims hundreds of thousands of hotspots while the map is blank.
    const rawDetections = activeDays.reduce((sum, item) => sum + item.detections, 0)

    const sensors = rangeSensors ?? calendar?.totals.sensors
    let detections = rawDetections
    if (sensors) {
      if (!sensorsEnabled.MODIS && !sensorsEnabled.VIIRS) {
        detections = 0
      } else if (sensorsEnabled.MODIS && !sensorsEnabled.VIIRS) {
        detections = sensors.MODIS
      } else if (!sensorsEnabled.MODIS && sensorsEnabled.VIIRS) {
        detections = sensors.VIIRS
      }
    }

    const meanFrp = activeDays.length
      ? activeDays.reduce((sum, item) => sum + item.mean_frp * item.detections, 0) /
        Math.max(1, rawDetections)
      : 0
    const peak = cells.reduce((max, cell) => Math.max(max, cell.detections), 0)
    const peakFrp = cells.reduce((max, cell) => Math.max(max, cell.mean_frp), 0)
    return {
      detections,
      hasData: activeDays.length > 0,
      pending: calendar === null,
      cells: !sensorsEnabled.MODIS && !sensorsEnabled.VIIRS ? 0 : cells.length,
      meanFrp,
      truncated,
      peak,
      peakFrp,
      sensors,
    }
  }, [rangeFrom, rangeTo, calendar, rangeSensors, sensorsEnabled, cells, truncated])

  const insights = useMemo(() => {
    const activity = calendar ? rangeActivity(calendar.days, rangeFrom, rangeTo) : null
    const rawComparison = calendar ? monthComparison(calendar.days, day ?? rangeTo) : null
    // Only compare where the earlier years actually cover the selected area, otherwise
    // "world" numbers would be measured against a Europe-only history.
    const extent = calendar?.history_extent ?? null
    const covered = rawComparison ? (!extent || bboxInside(bbox, extent)) : false
    const comparison = covered ? rawComparison : null
    return {
      comparison,
      activity,
      areaKm2: bboxAreaKm2(bbox),
      historyLimited: Boolean(rawComparison) && !covered,
      historyExtent: extent,
    }
  }, [calendar, rangeFrom, rangeTo, bbox, day])

  const csvHref = exportCsvHref({bbox, from: rangeFrom, to: rangeTo})
  const status: Status = cellsStatus === 'ok' ? calendarStatus : cellsStatus

  const applyPreset = (id: string) => {
    const preset = PRESETS.find(item => item.id === id)
    if (!preset) return
    setAreaId(id)
    setBBox(preset.bbox)
    setDrawing(false)
  }

  const applyBBox = (next: BBox) => {
    setAreaId('custom')
    setBBox(next)
    setDrawing(false)
  }

  const applySearchBBox = (next: BBox) => {
    setAreaId('custom')
    setBBox(next)
    setDrawing(false)
  }

  const applyRangePreset = (preset: '24h' | '3d' | '7d') => {
    setPlaying(false)
    setDay(null)
    setCustomRange(null)
    setRangePreset(preset)
    clearCustomWindowFromUrl()
  }

  const applyRangeSelect = (nextFrom: string, nextTo: string) => {
    if (!isIsoDate(nextFrom) || !isIsoDate(nextTo)) return
    setPlaying(false)
    setDay(null)
    setCustomRange(clampRange(nextFrom, nextTo, from, to))
    setRangePreset('custom')
  }

  const measureDistance = useMemo(() => pathLengthM(measurePoints), [measurePoints])
  const measureArea = useMemo(
    () => (measureMode === 'area' ? ringAreaM2(measurePoints) : 0),
    [measureMode, measurePoints],
  )

  const toggleMeasure = () => {
    const next = !measuring
    setMeasuring(next)
    setMeasurePoints([])
    if (next) {
      setDrawing(false)
      setCalendarOpen(false)
      setHelpOpen(false)
    }
  }

  const changeMeasureMode = (mode: MeasureMode) => {
    setMeasureMode(mode)
    setMeasurePoints([])
  }

  const addMeasurePoint = (point: LatLon) => {
    setMeasurePoints(previous => [...previous, point])
  }

  const handleCapture = () => {
    if (captureState === 'busy') return
    setCaptureState('busy')
    setCaptureToken(token => token + 1)
  }

  const handleCaptured = (result: {ok: boolean; error?: string}) => {
    setCaptureState(result.ok ? 'saved' : 'error')
  }

  useEffect(() => {
    if (captureState !== 'saved' && captureState !== 'error') return
    const timer = window.setTimeout(() => setCaptureState('idle'), 3200)
    return () => window.clearTimeout(timer)
  }, [captureState])

  const captureFooter = [
    'NASA FIRMS',
    `${formatDay(rangeFrom)} – ${formatDay(rangeTo)}`,
    measurePoints.length > 1
      ? measureMode === 'area' && measurePoints.length > 2
        ? `Measured ${formatDistance(measureDistance)} · ${formatArea(measureArea)}`
        : `Measured ${formatDistance(measureDistance)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const handleModeTab = (tab: ModeTab) => {
    setModeTab(tab)
    if (tab === 'time') {
      setCalendarOpen(true)
      setHelpOpen(false)
    } else {
      setCalendarOpen(false)
    }
  }

  const handleToggleSensor = (sensor: 'MODIS' | 'VIIRS') => {
    setSensorsEnabled(prev => ({...prev, [sensor]: !prev[sensor]}))
  }

  const handleShare = () => {
    if (typeof window === 'undefined') return
    const bounds = mapRef.current?.getBounds()
    const live: BBox | null = bounds
      ? [
          Math.max(-180, bounds.getWest()), Math.max(-90, bounds.getSouth()),
          Math.min(180, bounds.getEast()), Math.min(90, bounds.getNorth()),
        ]
      : null
    const shareBox = live && live[0] < live[2] && live[1] < live[3] ? live : viewBBox ?? bbox
    const nextUrl = buildShareUrl(window.location.origin + window.location.pathname, {
      bbox: shareBox,
      day,
      rangePreset,
      customRange,
      res,
      pinnedRes,
      basemap,
      sensorsEnabled,
    })
    window.history.replaceState(null, '', nextUrl)
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(nextUrl).catch(() => {})
    }
    setShareCopied(true)
    window.setTimeout(() => setShareCopied(false), 2200)
  }

  const handleDismissDisclaimer = () => {
    if (dontShowAgain && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(DISCLAIMER_STORAGE_KEY, '1')
      } catch {
        /* ignore storage restrictions */
      }
    }
    setDisclaimerOpen(false)
  }

  const reset = () => {
    applyPreset('world')
    setPinnedRes(null)
    setBasemap('satellite')
    setSensorsEnabled({MODIS: true, VIIRS: true})
    setDay(null)
    setCustomRange(null)
    setRangePreset('7d')
    setPlaying(false)
    // The address bar is a second copy of the state: without this, a reload
    // restores the area, range and layers that Reset just cleared.
    if (typeof window !== 'undefined' && (window.location.search || window.location.hash)) {
      window.history.replaceState(null, '', `${window.location.origin}${window.location.pathname}`)
    }
  }

  return (
    <div className="app">
      <TopBar
        detections={totals.detections}
        cursor={cursor}
        csvHref={csvHref}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen(open => !open)}
        onSearchBBox={applySearchBBox}
        onOpenAbout={() => {
          setHelpOpen(true)
          setCalendarOpen(false)
        }}
      />

      <main className="stage" aria-label="Active fire map workspace">
        <MapView
          cells={cells}
          bbox={bbox}
          res={res}
          zoom={zoom}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          basemap={basemap}
          sensorsEnabled={sensorsEnabled}
          areaSensors={totals.sensors}
          drawing={drawing}
          measuring={measuring}
          measureMode={measureMode}
          measurePoints={measurePoints}
          onMeasurePoint={addMeasurePoint}
          captureToken={captureToken}
          captureFooter={captureFooter}
          onCaptured={handleCaptured}
          onBBox={applyBBox}
          onViewBBox={setViewBBox}
          onCursor={setCursor}
          onZoom={setZoom}
          onMapReady={map => {
            mapRef.current = map
          }}
        />

        <ControlPanel
          bbox={bbox}
          areaId={areaId}
          presets={PRESETS}
          onPreset={applyPreset}
          onBBox={applyBBox}
          rangePreset={rangePreset}
          onRangePreset={applyRangePreset}
          onRangeSelect={applyRangeSelect}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          datasetFrom={from}
          datasetTo={to}
          modeTab={modeTab}
          onModeTab={handleModeTab}
          sensorsEnabled={sensorsEnabled}
          onToggleSensor={handleToggleSensor}
          basemap={basemap}
          onBasemap={setBasemap}
          drawing={drawing}
          onDrawing={setDrawing}
          csvHref={csvHref}
          totals={totals}
          insights={insights}
          status={status}
          error={cellsError}
          onRetry={() => setReload(value => value + 1)}
          onReset={reset}
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
        />

        {disclaimerOpen && (
          <div
            className="disclaimer-modal"
            role="dialog"
            aria-modal="false"
            aria-labelledby="disclaimer-title"
          >
            <div className="disclaimer-head">
              <h2 id="disclaimer-title">ACTIVE FIRES / THERMAL ANOMALIES</h2>
            </div>
            <div className="disclaimer-body">
              <p className="disclaimer-lead">
                Do not use for the preservation of life or property. Satellite-derived active fire and
                thermal anomalies have limited accuracy.
              </p>
              <ul className="disclaimer-list">
                <li>
                  Detections may come from wildfire, hot smoke, agricultural burning, industrial heat, or
                  other thermal sources.
                </li>
                <li>
                  Cloud cover, heavy smoke, or tree canopy can obscure active fires from satellite sensors.
                </li>
                <li>
                  MODIS (1 km) and VIIRS (375 m) detections are combined into one series covering{' '}
                  {formatDay(from)} to {formatDay(to)}.
                </li>
              </ul>
              <div className="disclaimer-foot">
                <label className="disclaimer-check">
                  <input
                    type="checkbox"
                    checked={dontShowAgain}
                    onChange={event => setDontShowAgain(event.target.checked)}
                  />
                  <span>Do not show again</span>
                </label>
                <button
                  type="button"
                  className="btn btn-understand"
                  onClick={handleDismissDisclaimer}
                >
                  OK, I understand
                </button>
              </div>
            </div>
          </div>
        )}

        {helpOpen && (
          <section className="help-sheet" role="dialog" aria-label="About Fire Calendar">
            <div className="sheet-bar">
              <h2>About Fire Calendar</h2>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setHelpOpen(false)}
                aria-label="Close help"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" fill="none" />
                </svg>
              </button>
            </div>
            <div className="help-grid">
              <div>
                <h3>MODIS + VIIRS combined</h3>
                <p>
                  MODIS (1 km) and VIIRS NOAA-20 (375 m) detections are filtered for nominal or high
                  confidence, then merged: several detections in the same small area on the same day
                  count once.
                </p>
              </div>
              <div>
                <h3>Using the interface</h3>
                <p>
                  Use the <b>MODE</b> panel to switch between 24HRS, 3 DAYS and 7 DAYS, toggle sensors,
                  and download the filtered detections as CSV. Zooming in shows individual detections.
                </p>
              </div>
              <div>
                <h3>Data and credit</h3>
                <p>
                  Fire detections: NASA FIRMS (MODIS C6.1, VIIRS C2 NOAA-20). Map imagery: Esri and
                  OpenStreetMap contributors. Cite as <b>NASA FIRMS / LANCE</b>,{' '}
                  <a href="https://firms.modaps.eosdis.nasa.gov" target="_blank" rel="noreferrer">
                    firms.modaps.eosdis.nasa.gov
                  </a>
                  .
                </p>
                <p>
                  Only NOAA-20 is listed for VIIRS because Suomi-NPP no longer delivers new detections in
                  this window; NOAA-21 is not imported yet.
                </p>
              </div>
            </div>
          </section>
        )}

        {calendarOpen && (
          <CalendarSheet
            months={calendar?.months ?? []}
            days={calendar?.days ?? []}
            climatology={calendar?.climatology ?? []}
            anomaly={calendar?.anomaly ?? []}
            selected={day}
            onSelect={next => {
              setPlaying(false)
              setDay(next)
              setRangePreset(next ? 'day' : '7d')
              // Picking a day filters the map — close the sheet, otherwise it covers
              // the very area the hotspots are drawn in.
              if (next) setCalendarOpen(false)
            }}
            from={from}
            to={to}
            rangeTo={rangeTo}
            onClose={() => {
              setCalendarOpen(false)
              setModeTab('simple')
            }}
          />
        )}

        {timelineOpen && (
          <TimelineBar
            days={calendar?.days ?? []}
            selected={day}
            rangePreset={rangePreset}
            onSelect={next => {
              setPlaying(false)
              setDay(next)
              setRangePreset(next ? 'day' : '7d')
            }}
            onRangePreset={applyRangePreset}
            from={shiftIsoDate(to, -7, from)}
            to={to}
            playing={playing}
            onPlay={() => setPlaying(value => !value)}
            onClose={() => setTimelineOpen(false)}
          />
        )}

        {measuring && (
          <section className="measure-card" role="dialog" aria-label="Measure tool">
            <div className="sheet-bar">
              <h2>Measure</h2>
              <button
                type="button"
                className="icon-btn"
                onClick={toggleMeasure}
                aria-label="Close measure tool"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" fill="none" />
                </svg>
              </button>
            </div>
            <div className="measure-modes" role="group" aria-label="Measure mode">
              <button
                type="button"
                className="measure-mode"
                aria-pressed={measureMode === 'distance'}
                onClick={() => changeMeasureMode('distance')}
              >
                Distance
              </button>
              <button
                type="button"
                className="measure-mode"
                aria-pressed={measureMode === 'area'}
                onClick={() => changeMeasureMode('area')}
              >
                Area
              </button>
            </div>
            <p className="measure-hint">
              {measureMode === 'distance'
                ? 'Click the map to set points. The line follows the pointer until you click.'
                : 'Click three or more points; the ring closes automatically.'}
            </p>
            <div className="measure-values">
              <div className="measure-value">
                <span>Distance</span>
                <b>{formatDistance(measureDistance)}</b>
              </div>
              {measureMode === 'area' && (
                <div className="measure-value">
                  <span>Area</span>
                  <b>{formatArea(measureArea)}</b>
                </div>
              )}
              <div className="measure-value">
                <span>Points</span>
                <b>{measurePoints.length}</b>
              </div>
            </div>
            <div className="measure-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setMeasurePoints([])}
                disabled={measurePoints.length === 0}
              >
                Clear
              </button>
              <button type="button" className="btn" onClick={toggleMeasure}>
                Done
              </button>
            </div>
          </section>
        )}

        {captureState !== 'idle' && (
          <div className="map-toast" role="status">
            {captureState === 'busy' && 'Rendering the PNG…'}
            {captureState === 'saved' && 'PNG saved to your downloads'}
            {captureState === 'error' && 'The PNG could not be created'}
          </div>
        )}

        <nav className="bottom-toolbar" aria-label="Map tools">
          <button
            type="button"
            className="tool-btn"
            aria-pressed={calendarOpen}
            onClick={() => {
              const next = !calendarOpen
              setCalendarOpen(next)
              setModeTab(next ? 'time' : 'simple')
              if (next) setHelpOpen(false)
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
              <path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4" stroke="currentColor" strokeWidth="1.3" fill="none" />
            </svg>
            <span>CALENDAR</span>
          </button>

          <button
            type="button"
            className="tool-btn"
            aria-pressed={measuring}
            onClick={toggleMeasure}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2.6 10.4L10.4 2.6L13.4 5.6L5.6 13.4L2.6 10.4Z"
                stroke="currentColor"
                strokeWidth="1.3"
                fill="none"
              />
              <path
                d="M5.2 7.8L6.7 9.3M7.2 5.8L8.7 7.3M9.2 3.8L10.7 5.3"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
              />
            </svg>
            <span>MEASURE</span>
          </button>

          <button
            type="button"
            className="tool-btn"
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen(open => !open)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 2L14 5.2L8 8.4L2 5.2L8 2ZM2 8.2L8 11.4L14 8.2M2 11.2L8 14.4L14 11.2"
                stroke="currentColor"
                strokeWidth="1.3"
                fill="none"
              />
            </svg>
            <span>LAYERS</span>
          </button>

          <button
            type="button"
            className="tool-btn"
            aria-pressed={timelineOpen}
            onClick={() => setTimelineOpen(open => !open)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2 12.5h12M4 10V6.5M8 10V3.5M12 10V5"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
              />
            </svg>
            <span>TIMELINE</span>
          </button>

          <button
            type="button"
            className="tool-btn"
            aria-pressed={captureState === 'busy'}
            onClick={handleCapture}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2 5.6h2.6l1-1.7h4.8l1 1.7H14v7.1H2V5.6Z"
                stroke="currentColor"
                strokeWidth="1.3"
                fill="none"
              />
              <circle cx="8" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.3" fill="none" />
            </svg>
            <span>CAPTURE</span>
          </button>

          <button
            type="button"
            className="tool-btn"
            aria-pressed={shareCopied}
            onClick={handleShare}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="12" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
              <circle cx="4" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
              <circle cx="12" cy="12.5" r="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
              <path d="M5.8 7L10.2 4.5M5.8 9L10.2 11.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
            </svg>
            <span>{shareCopied ? 'COPIED' : 'SHARE'}</span>
          </button>

          <button
            type="button"
            className="tool-btn"
            aria-pressed={helpOpen}
            onClick={() => {
              const next = !helpOpen
              setHelpOpen(next)
              if (next) setCalendarOpen(false)
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" fill="none" />
              <path
                d="M6.5 6.3a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.5-.7 1.1M8 11.3v.1"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
            <span>HELP</span>
          </button>
        </nav>
      </main>
    </div>
  )
}
