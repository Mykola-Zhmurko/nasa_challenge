import {useEffect, useState} from 'react'
import type {BBox, SensorTotals, Status} from '../../lib/api'
import {
  FIRE_RAMP,
  formatCount,
  formatDay,
  frpStepLabels,
} from '../../lib/ramp'
import type {Basemap, SensorsEnabled} from './MapView'

export interface Preset {
  id: string
  label: string
  bbox: BBox
}

export type TimeRangePreset = '24h' | '3d' | '7d' | 'day'
export type ModeTab = 'simple' | 'time'

interface ControlPanelProps {
  bbox: BBox
  areaId: string
  presets: Preset[]
  onPreset: (id: string) => void
  onBBox: (bbox: BBox) => void
  rangePreset: TimeRangePreset
  onRangePreset: (preset: '24h' | '3d' | '7d') => void
  rangeFrom: string
  rangeTo: string
  modeTab: ModeTab
  onModeTab: (tab: ModeTab) => void
  sensorsEnabled: SensorsEnabled
  onToggleSensor: (sensor: 'MODIS' | 'VIIRS') => void
  basemap: Basemap
  onBasemap: (basemap: Basemap) => void
  drawing: boolean
  onDrawing: (value: boolean) => void
  csvHref: string
  totals: {
    detections: number
    cells: number
    meanFrp: number
    truncated: boolean
    peak: number
    peakFrp: number
    frpCuts: number[]
    sensors?: SensorTotals
  }
  status: Status
  error: string | null
  onRetry: () => void
  onReset: () => void
  open: boolean
  onClose: () => void
}

const CheckIcon = ({active}: {active: boolean}) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    {active ? (
      <path
        d="M2.5 7.2L5.6 10.3L11.5 3.8"
        stroke="#44a282"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ) : (
      <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" stroke="#6e7178" strokeWidth="1.2" fill="none" />
    )}
  </svg>
)

const EyeIcon = ({active}: {active: boolean}) => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M1.5 8C3.2 4.8 5.5 3.3 8 3.3C10.5 3.3 12.8 4.8 14.5 8C12.8 11.2 10.5 12.7 8 12.7C5.5 12.7 3.2 11.2 1.5 8Z"
      stroke={active ? '#44a282' : '#8d9096'}
      strokeWidth="1.3"
      fill="none"
    />
    <circle cx="8" cy="8" r="2.1" fill={active ? '#44a282' : '#8d9096'} />
  </svg>
)

export function ControlPanel({
  bbox,
  areaId,
  presets,
  onPreset,
  onBBox,
  rangePreset,
  onRangePreset,
  rangeFrom,
  rangeTo,
  modeTab,
  onModeTab,
  sensorsEnabled,
  onToggleSensor,
  basemap,
  onBasemap,
  drawing,
  onDrawing,
  csvHref,
  totals,
  status,
  error,
  onRetry,
  onReset,
  open,
  onClose,
}: ControlPanelProps) {
  const [draft, setDraft] = useState({
    minLon: bbox[0].toFixed(2),
    minLat: bbox[1].toFixed(2),
    maxLon: bbox[2].toFixed(2),
    maxLat: bbox[3].toFixed(2),
  })

  useEffect(() => {
    setDraft({
      minLon: bbox[0].toFixed(2),
      minLat: bbox[1].toFixed(2),
      maxLon: bbox[2].toFixed(2),
      maxLat: bbox[3].toFixed(2),
    })
  }, [bbox])

  const applyDraft = () => {
    const next: BBox = [
      Number(draft.minLon),
      Number(draft.minLat),
      Number(draft.maxLon),
      Number(draft.maxLat),
    ]
    if (next.some(value => !Number.isFinite(value))) return
    if (next[0] >= next[2] || next[1] >= next[3]) return
    onBBox(next)
  }

  const modisCount = totals.sensors?.MODIS ?? 0
  const viirsCount = totals.sensors?.VIIRS ?? 0

  return (
    <aside
      className={open ? 'panel panel-open' : 'panel'}
      id="mode-panel"
      aria-label="Mode, sensors, layers, and overlays"
    >
      <div className="panel-head">
        <h2>MODE</h2>
        <div className="spacer" />
        <button type="button" className="btn btn-quiet" onClick={onReset}>
          Reset
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close mode panel">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
        </button>
      </div>

      <div className="panel-body">
        <section className="section">
          <div className="range-btns" role="group" aria-label="Time range">
            <button
              type="button"
              className="range-btn"
              aria-pressed={rangePreset === '24h'}
              onClick={() => onRangePreset('24h')}
            >
              24HRS
            </button>
            <button
              type="button"
              className="range-btn"
              aria-pressed={rangePreset === '3d'}
              onClick={() => onRangePreset('3d')}
            >
              3 DAYS
            </button>
            <button
              type="button"
              className="range-btn"
              aria-pressed={rangePreset === '7d'}
              onClick={() => onRangePreset('7d')}
            >
              7 DAYS
            </button>
          </div>
          <p className="range-line">
            From <b>{formatDay(rangeFrom)}</b> to <b>{formatDay(rangeTo)}</b>
          </p>

          <div className="mode-tabs" role="tablist" aria-label="Display mode">
            <button
              type="button"
              role="tab"
              aria-selected={modeTab === 'simple'}
              className={modeTab === 'simple' ? 'mode-tab active' : 'mode-tab'}
              onClick={() => onModeTab('simple')}
            >
              Simple
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={modeTab === 'time'}
              className={modeTab === 'time' ? 'mode-tab active' : 'mode-tab'}
              onClick={() => onModeTab('time')}
            >
              Time based
            </button>
          </div>
          {modeTab === 'time' && (
            <p className="note">
              Burning calendar sheet is open below. Select any day cell to filter the map to that date.
            </p>
          )}
        </section>

        <section className="section">
          <h3>Sensors</h3>
          <div className="sensor-list" role="group" aria-label="Satellite sensors">
            <button
              type="button"
              className="sensor-row"
              aria-pressed={sensorsEnabled.MODIS}
              onClick={() => onToggleSensor('MODIS')}
            >
              <CheckIcon active={sensorsEnabled.MODIS} />
              <span className="sensor-name">MODIS</span>
              <span className="sensor-meta">1 km</span>
              <span className="sensor-count">{formatCount(modisCount)}</span>
            </button>
            <button
              type="button"
              className="sensor-row"
              aria-pressed={sensorsEnabled.VIIRS}
              onClick={() => onToggleSensor('VIIRS')}
            >
              <CheckIcon active={sensorsEnabled.VIIRS} />
              <span className="sensor-name">VIIRS NOAA-20</span>
              <span className="sensor-meta">375 m</span>
              <span className="sensor-count">{formatCount(viirsCount)}</span>
            </button>
          </div>

          <div className="totals" style={{marginTop: 10}}>
            <div className="total">
              <span className="k">Hotspots</span>
              <span className="v">{formatCount(totals.detections)}</span>
            </div>
            <div className="total">
              <span className="k">Hexagons</span>
              <span className="v">{formatCount(totals.cells)}</span>
            </div>
            <div className="total">
              <span className="k">Mean FRP</span>
              <span className="v">{totals.meanFrp > 0 ? `${totals.meanFrp.toFixed(1)} MW` : '—'}</span>
            </div>
          </div>

          {status === 'not-ready' && (
            <div className="notice">
              Data not ready.
              <button type="button" className="link" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
          {status === 'error' && (
            <div className="notice">
              {error ?? 'Could not load hotspots.'}
              <button type="button" className="link" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
        </section>

        <section className="section">
          <h3>Layers</h3>
          <div className="sub-label">Fire power (MW)</div>
          <p className="note">
            {status === 'loading'
              ? 'Loading hexagons…'
              : `Viridis ramp encodes mean FRP (MW) across ${formatCount(totals.cells)}${totals.truncated ? '+' : ''} H3 cells:`}
          </p>
          <div className="legend">
            {frpStepLabels(totals.frpCuts).map((label, index) => (
              <span className="legend-step" key={index}>
                <span className="legend-bar" style={{background: FIRE_RAMP[index]}} />
                <span className="legend-value">{label}</span>
              </span>
            ))}
          </div>

          <div className="sub-label" style={{marginTop: 10}}>
            Static backgrounds
          </div>
          <div className="sensor-list" role="group" aria-label="Basemap">
            <button
              type="button"
              className="sensor-row"
              aria-pressed={basemap === 'satellite'}
              onClick={() => onBasemap('satellite')}
            >
              <EyeIcon active={basemap === 'satellite'} />
              <span className="sensor-name">Satellite</span>
              <span className="sensor-meta">Esri World Imagery</span>
            </button>
            <button
              type="button"
              className="sensor-row"
              aria-pressed={basemap === 'dark'}
              onClick={() => onBasemap('dark')}
            >
              <EyeIcon active={basemap === 'dark'} />
              <span className="sensor-name">Dark</span>
              <span className="sensor-meta">Esri canvas + borders</span>
            </button>
            <button
              type="button"
              className="sensor-row"
              aria-pressed={basemap === 'blue-marble'}
              onClick={() => onBasemap('blue-marble')}
            >
              <EyeIcon active={basemap === 'blue-marble'} />
              <span className="sensor-name">Blue Marble</span>
              <span className="sensor-meta">NASA GIBS, sharp to zoom 8</span>
            </button>
          </div>
        </section>

        <section className="section">
          <h3>Overlays (1/{presets.length})</h3>
          <div className="presets">
            {presets.map(preset => (
              <button
                key={preset.id}
                type="button"
                className="preset"
                aria-pressed={areaId === preset.id}
                onClick={() => onPreset(preset.id)}
              >
                <EyeIcon active={areaId === preset.id} />
                <span>{preset.label}</span>
              </button>
            ))}
          </div>

          <div className="row-between" style={{marginTop: 10}}>
            <button
              type="button"
              className="btn"
              aria-pressed={drawing}
              onClick={() => onDrawing(!drawing)}
              style={drawing ? {borderColor: 'var(--accent)'} : undefined}
            >
              {drawing ? 'Drag on the map…' : 'Draw a rectangle'}
            </button>
            <a className="btn" href={csvHref} download>
              Download CSV
            </a>
          </div>

          <div className="coords">
            <div className="field">
              <label htmlFor="min-lon">West</label>
              <input
                id="min-lon"
                inputMode="decimal"
                value={draft.minLon}
                onChange={event => setDraft({...draft, minLon: event.target.value})}
                onBlur={applyDraft}
                onKeyDown={event => event.key === 'Enter' && applyDraft()}
              />
            </div>
            <div className="field">
              <label htmlFor="min-lat">South</label>
              <input
                id="min-lat"
                inputMode="decimal"
                value={draft.minLat}
                onChange={event => setDraft({...draft, minLat: event.target.value})}
                onBlur={applyDraft}
                onKeyDown={event => event.key === 'Enter' && applyDraft()}
              />
            </div>
            <div className="field">
              <label htmlFor="max-lon">East</label>
              <input
                id="max-lon"
                inputMode="decimal"
                value={draft.maxLon}
                onChange={event => setDraft({...draft, maxLon: event.target.value})}
                onBlur={applyDraft}
                onKeyDown={event => event.key === 'Enter' && applyDraft()}
              />
            </div>
            <div className="field">
              <label htmlFor="max-lat">North</label>
              <input
                id="max-lat"
                inputMode="decimal"
                value={draft.maxLat}
                onChange={event => setDraft({...draft, maxLat: event.target.value})}
                onBlur={applyDraft}
                onKeyDown={event => event.key === 'Enter' && applyDraft()}
              />
            </div>
          </div>
        </section>
      </div>
    </aside>
  )
}
