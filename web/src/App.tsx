import {useEffect, useMemo, useRef, useState} from 'react'
import 'leaflet/dist/leaflet.css'
import '../styles/tokens.css'
import '../styles/app.css'
import type {BBox, CalendarResponse, Cell, Health, Status} from '../lib/api'
import {exportCsvHref, fetchCalendar, fetchCells, fetchHealth} from '../lib/api'
import {formatRange, frpCuts} from '../lib/ramp'
import {resForZoom} from '../lib/zoom'
import {TopBar} from './components/TopBar'
import {ControlPanel, type Preset} from './components/ControlPanel'
import {MapView, type Basemap} from './components/MapView'
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

function weightedFrp(months: CalendarResponse['months'] | undefined): number {
  if (!months || !months.length) return 0
  const weight = months.reduce((sum, item) => sum + item.detections, 0)
  if (!weight) return 0
  const total = months.reduce((sum, item) => sum + item.mean_frp * item.detections, 0)
  return total / weight
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthStatus, setHealthStatus] = useState<Status>('loading')

  const [bbox, setBBox] = useState<BBox>(PRESETS[0]?.bbox ?? [-180, -58, 180, 72])
  const [areaId, setAreaId] = useState('world')
  const [zoom, setZoom] = useState(2)
  const [pinnedRes, setPinnedRes] = useState<number | null>(null)
  const res = pinnedRes ?? resForZoom(zoom)
  const [basemap, setBasemap] = useState<Basemap>('dark')
  const [day, setDay] = useState<string | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(true)
  const [panelOpen, setPanelOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 960)
  const [reload, setReload] = useState(0)
  const [cursor, setCursor] = useState<{lat: number; lon: number} | null>(null)

  const [cells, setCells] = useState<Cell[]>([])
  const [cellsStatus, setCellsStatus] = useState<Status>('loading')
  const [cellsError, setCellsError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  const [calendar, setCalendar] = useState<CalendarResponse | null>(null)
  const [calendarStatus, setCalendarStatus] = useState<Status>('loading')

  const from = health?.min_ts ?? FALLBACK_WINDOW.from
  const to = health?.max_ts ?? FALLBACK_WINDOW.to
  const rangeFrom = day ?? from
  const rangeTo = day ?? to

  const dayRef = useRef(day)
  useEffect(() => {
    dayRef.current = day
  }, [day])

  useEffect(() => {
    const controller = new AbortController()
    setHealthStatus('loading')
    fetchHealth(controller.signal).then(result => {
      if (result.status === 'idle') return
      setHealthStatus(result.status)
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
    }, 900)
    return () => clearInterval(timer)
  }, [playing, calendar])

  const totals = useMemo(() => {
    const dayRow = day ? calendar?.days.find(item => item.date === day) : null
    const detections = dayRow ? dayRow.detections : calendar?.totals.detections ?? 0
    const meanFrp = dayRow ? dayRow.mean_frp : weightedFrp(calendar?.months)
    const peak = cells.reduce((max, cell) => Math.max(max, cell.detections), 0)
    const peakFrp = cells.reduce((max, cell) => Math.max(max, cell.mean_frp), 0)
    const cuts = frpCuts(cells)
    return {
      detections,
      cells: cells.length,
      meanFrp,
      truncated,
      peak,
      peakFrp,
      frpCuts: cuts,
      sensors: calendar?.totals.sensors,
    }
  }, [day, calendar, cells, truncated])

  const areaLabel = PRESETS.find(preset => preset.id === areaId)?.label ?? 'Custom box'
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

  const reset = () => {
    applyPreset('world')
    setPinnedRes(null)
    setDay(null)
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
      />

      <div className="scope">
        <span>
          Scope <b>{areaLabel}</b>
        </span>
        <span>{formatRange(rangeFrom, rangeTo)}</span>
        <span className="right">
          Source: NASA FIRMS · active fire hotspots, both sensors merged into one series
        </span>
      </div>

      <div className="stage">
        <MapView
          cells={cells}
          bbox={bbox}
          res={res}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          basemap={basemap}
          onBasemap={setBasemap}
          areaSensors={calendar?.totals.sensors}
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
          res={res}
          resAuto={pinnedRes === null}
          onRes={setPinnedRes}
          onResAuto={() => setPinnedRes(null)}
          drawing={drawing}
          onDrawing={setDrawing}
          totals={totals}
          status={status}
          error={cellsError}
          onRetry={() => setReload(value => value + 1)}
          onReset={reset}
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
        />
      </div>

      {calendarOpen && (
        <CalendarSheet
          months={calendar?.months ?? []}
          days={calendar?.days ?? []}
          selected={day}
          onSelect={setDay}
          from={from}
          to={to}
        />
      )}

      <TimelineBar
        days={calendar?.days ?? []}
        selected={day}
        onSelect={next => {
          setPlaying(false)
          setDay(next)
        }}
        from={from}
        to={to}
        playing={playing}
        onPlay={() => setPlaying(value => !value)}
        calendarOpen={calendarOpen}
        onToggleCalendar={() => setCalendarOpen(value => !value)}
      />
    </div>
  )
}
