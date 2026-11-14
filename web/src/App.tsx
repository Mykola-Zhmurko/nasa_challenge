import {useEffect, useMemo, useRef, useState} from 'react'
import 'leaflet/dist/leaflet.css'
import '../styles/tokens.css'
import '../styles/app.css'
import type {BBox, CalendarResponse, Cell, Health, SensorTotals, Status} from '../lib/api'
import {exportCsvHref, fetchCalendar, fetchCells, fetchHealth} from '../lib/api'
import {type ColourMode, formatDay, frpCuts, shiftIsoDate} from '../lib/ramp'
import {resForZoom} from '../lib/zoom'
import {TopBar} from './components/TopBar'
import {ControlPanel, type ModeTab, type Preset, type TimeRangePreset} from './components/ControlPanel'
import {MapView, type Basemap, type SensorsEnabled} from './components/MapView'
import {TimelineBar} from './components/TimelineBar'
import {CalendarSheet} from './components/CalendarSheet'

const PRESETS: Preset[] = [
  {id: 'world', label: 'World', bbox: [-180, -58, 180, 72]},
  {id: 'europe', label: 'Europe', bbox: [-12, 34, 32, 72]},
  {id: 'mediterranean', label: 'Mediterranean', bbox: [-10, 29, 42, 46]},
  {id: 'ukraine', label: 'Ukraine', bbox: [22, 44, 41, 52]},
  {id: 'amazon', label: 'Amazon', bbox: [-74, -20, -44, 6]},
  {id: 'california', label: 'California', bbox: [-125, 32, -114, 42]},
]

const FALLBACK_WINDOW = {from: '2026-11-07', to: '2026-11-14'}
const DISCLAIMER_STORAGE_KEY = 'fire_calendar_disclaimer_hide'

interface InitialUrlState {
  bbox: BBox
  areaId: string
  rangePreset: TimeRangePreset
  day: string | null
  pinnedRes: number | null
  basemap: Basemap
  colourBy: ColourMode
  sensorsEnabled: SensorsEnabled
}

function readInitialUrlState(): InitialUrlState {
  const defaults: InitialUrlState = {
    bbox: PRESETS[0]?.bbox ?? [-180, -58, 180, 72],
    areaId: 'world',
    rangePreset: '7d',
    day: null,
    pinnedRes: null,
    basemap: 'satellite',
    colourBy: 'frp',
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

  const rawRes = params.get('res')
  if (rawRes && rawRes !== 'auto') {
    const parsed = Number(rawRes)
    if (Number.isInteger(parsed) && parsed >= 3 && parsed <= 8) {
      defaults.pinnedRes = parsed
    }
  }

  const rawBasemap = params.get('basemap')
  if (rawBasemap === 'satellite' || rawBasemap === 'dark' || rawBasemap === 'blue-marble') {
    defaults.basemap = rawBasemap
  }

  const rawColour = params.get('colour')
  if (rawColour === 'frp' || rawColour === 'age') {
    defaults.colourBy = rawColour
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

function weightedFrp(months: CalendarResponse['months'] | undefined): number {
  if (!months || !months.length) return 0
  const weight = months.reduce((sum, item) => sum + item.detections, 0)
  if (!weight) return 0
  const total = months.reduce((sum, item) => sum + item.mean_frp * item.detections, 0)
  return total / weight
}

export default function App() {
  const initial = useMemo(() => readInitialUrlState(), [])

  const [health, setHealth] = useState<Health | null>(null)
  const [bbox, setBBox] = useState<BBox>(initial.bbox)
  const [areaId, setAreaId] = useState(initial.areaId)
  const [zoom, setZoom] = useState(2)
  const [pinnedRes, setPinnedRes] = useState<number | null>(initial.pinnedRes)
  const res = pinnedRes ?? resForZoom(zoom)
  const [basemap, setBasemap] = useState<Basemap>(initial.basemap)
  const [colourBy, setColourBy] = useState<ColourMode>(initial.colourBy)
  const [sensorsEnabled, setSensorsEnabled] = useState<SensorsEnabled>(initial.sensorsEnabled)
  const [rangePreset, setRangePreset] = useState<TimeRangePreset>(initial.rangePreset)
  const [day, setDay] = useState<string | null>(initial.day)
  const [modeTab, setModeTab] = useState<ModeTab>('simple')

  const [drawing, setDrawing] = useState(false)
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
    if (rangePreset === '24h') return {rangeFrom: to, rangeTo: to}
    if (rangePreset === '3d') return {rangeFrom: shiftIsoDate(to, -2, from), rangeTo: to}
    return {rangeFrom: shiftIsoDate(to, -7, from), rangeTo: to}
  }, [day, rangePreset, from, to])

  const dayRef = useRef(day)
  useEffect(() => {
    dayRef.current = day
  }, [day])

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal).then(result => {
      if (result.status === 'idle') return
      setHealth(result.data)
    })
    return () => controller.abort()
  }, [reload])

  useEffect(() => {
    const controller = new AbortController()
    setCellsStatus('loading')
    fetchCells({res, from: rangeFrom, to: rangeTo, bbox}, controller.signal).then(result => {
      if (result.status === 'idle') return
      setCellsStatus(result.status)
      setCellsError(result.error)
      setCells(result.data?.cells ?? [])
      setTruncated(result.data?.truncated ?? false)
    })
    return () => controller.abort()
  }, [bbox, res, rangeFrom, rangeTo, reload])

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

  useEffect(() => {
    if (rangeFrom === from && rangeTo === to) {
      setRangeSensors(calendar?.totals.sensors)
      return
    }
    const controller = new AbortController()
    fetchCalendar({bbox, from: rangeFrom, to: rangeTo, res}, controller.signal).then(result => {
      if (result.status === 'ok' && result.data?.totals.sensors) {
        setRangeSensors(result.data.totals.sensors)
      }
    })
    return () => controller.abort()
  }, [bbox, from, to, rangeFrom, rangeTo, res, calendar?.totals.sensors])

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
    const rawDetections = activeDays.length
      ? activeDays.reduce((sum, item) => sum + item.detections, 0)
      : calendar?.totals.detections ?? 0

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
      : weightedFrp(calendar?.months)
    const peak = cells.reduce((max, cell) => Math.max(max, cell.detections), 0)
    const peakFrp = cells.reduce((max, cell) => Math.max(max, cell.mean_frp), 0)
    const cuts = frpCuts(cells)
    return {
      detections,
      cells: !sensorsEnabled.MODIS && !sensorsEnabled.VIIRS ? 0 : cells.length,
      meanFrp,
      truncated,
      peak,
      peakFrp,
      frpCuts: cuts,
      sensors,
    }
  }, [rangeFrom, rangeTo, calendar, rangeSensors, sensorsEnabled, cells, truncated])

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
    setRangePreset(preset)
  }

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
    const params = new URLSearchParams()
    params.set('bbox', bbox.map(n => Number(n.toFixed(2))).join(','))
    if (day) {
      params.set('day', day)
    } else {
      params.set('range', rangePreset === 'day' ? '7d' : rangePreset)
    }
    params.set('res', pinnedRes === null ? 'auto' : String(res))
    params.set('basemap', basemap)
    params.set('colour', colourBy)
    const activeSensors = [
      sensorsEnabled.MODIS ? 'MODIS' : null,
      sensorsEnabled.VIIRS ? 'VIIRS' : null,
    ].filter(Boolean)
    params.set('sensors', activeSensors.join(','))

    const nextUrl = `${window.location.origin}${window.location.pathname}?${params.toString()}`
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
    setColourBy('frp')
    setBasemap('satellite')
    setSensorsEnabled({MODIS: true, VIIRS: true})
    setDay(null)
    setRangePreset('7d')
    setPlaying(false)
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
          colourBy={colourBy}
          sensorsEnabled={sensorsEnabled}
          areaSensors={totals.sensors}
          drawing={drawing}
          onBBox={applyBBox}
          onCursor={setCursor}
          onZoom={setZoom}
        />

        <ControlPanel
          bbox={bbox}
          areaId={areaId}
          presets={PRESETS}
          onPreset={applyPreset}
          onBBox={applyBBox}
          rangePreset={rangePreset}
          onRangePreset={applyRangePreset}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          modeTab={modeTab}
          onModeTab={handleModeTab}
          sensorsEnabled={sensorsEnabled}
          onToggleSensor={handleToggleSensor}
          basemap={basemap}
          onBasemap={setBasemap}
          res={res}
          resAuto={pinnedRes === null}
          onRes={setPinnedRes}
          onResAuto={() => setPinnedRes(null)}
          colourBy={colourBy}
          onColourBy={setColourBy}
          drawing={drawing}
          onDrawing={setDrawing}
          csvHref={csvHref}
          totals={totals}
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
                  MODIS (1 km) and VIIRS (375 m) detections are harmonized into one H3 series covering{' '}
                  {formatDay(from)} to {formatDay(to)}, with anomalies measured against the multi-year
                  monthly median.
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
                <h3>Harmonized MODIS + VIIRS series</h3>
                <p>
                  MODIS Collection 6.1 (1 km) and VIIRS NOAA-20 (375 m) active fire detections are
                  filtered for nominal/high confidence and deduplicated within the same H3 resolution-8 cell
                  (~0.74 km2) per UTC day, keeping the highest-confidence, highest-FRP observation.
                </p>
              </div>
              <div>
                <h3>Using the interface</h3>
                <p>
                  Use the right <b>MODE</b> panel to switch between 24HRS, 3 DAYS, and 7 DAYS, toggle
                  sensors, change hexagon resolution or colour mode (Fire power in MW vs Age in hours), and
                  export filtered detections as CSV. Zoom to level 8+ to inspect individual FIRMS points.
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
            }}
            from={from}
            to={to}
            onClose={() => {
              setCalendarOpen(false)
              setModeTab('simple')
            }}
          />
        )}

        {timelineOpen && (
          <TimelineBar
            days={(calendar?.days ?? []).slice(-14)}
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
