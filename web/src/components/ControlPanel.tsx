import {useEffect, useState} from 'react'
import * as h3 from 'h3-js'
import type {BBox, SensorTotals, Status} from '../../lib/api'
import {FIRE_RAMP, formatCount, frpStepLabels} from '../../lib/ramp'

export interface Preset {
  id: string
  label: string
  bbox: BBox
}

interface ControlPanelProps {
  bbox: BBox
  areaId: string
  presets: Preset[]
  onPreset: (id: string) => void
  onBBox: (bbox: BBox) => void
  res: number
  resAuto: boolean
  onRes: (res: number) => void
  onResAuto: () => void
  drawing: boolean
  onDrawing: (value: boolean) => void
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

const RES_OPTIONS = [3, 4, 5, 6, 7, 8]

export function ControlPanel({
  bbox,
  areaId,
  presets,
  onPreset,
  onBBox,
  res,
  resAuto,
  onRes,
  onResAuto,
  drawing,
  onDrawing,
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

  return (
    <aside
      className={open ? 'panel panel-open' : 'panel'}
      id="layers-panel"
      aria-label="Map layers and totals"
    >
      <div className="panel-head">
        <h2>Layers</h2>
        <div className="spacer" />
        <button type="button" className="btn btn-quiet" onClick={onReset}>
          Reset
        </button>
        <button type="button" className="icon-btn only-mobile" onClick={onClose} aria-label="Close layers">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
        </button>
      </div>

      <div className="panel-body">
        <section className="section">
          <h3>Totals</h3>
          <div className="totals">
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
          {totals.sensors && (totals.sensors.MODIS > 0 || totals.sensors.VIIRS > 0) && (
            <p className="note">
              Sensors: MODIS {formatCount(totals.sensors.MODIS)} · VIIRS {formatCount(totals.sensors.VIIRS)}
            </p>
          )}

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
          <h3>Area of interest</h3>
          <div className="presets">
            {presets.map(preset => (
              <button
                key={preset.id}
                type="button"
                className="preset"
                aria-pressed={areaId === preset.id}
                onClick={() => onPreset(preset.id)}
              >
                {preset.label}
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
            <span className="note" style={{margin: 0}}>
              {areaId === 'custom' ? 'Custom box' : 'Preset'}
            </span>
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

        <section className="section">
          <h3>Hexagon size</h3>
          <div className="seg" role="group" aria-label="Hexagon size">
            <button
              type="button"
              aria-pressed={resAuto}
              onClick={onResAuto}
              aria-label="Hexagon resolution follows map zoom"
            >
              Auto
            </button>
            {RES_OPTIONS.map(option => (
              <button
                key={option}
                type="button"
                aria-pressed={!resAuto && res === option}
                onClick={() => onRes(option)}
                aria-label={`Hexagon resolution ${option}`}
              >
                {option}
              </button>
            ))}
          </div>
          <p className="note">
            {status === 'loading'
              ? 'Loading hexagons…'
              : `${formatCount(totals.cells)}${totals.truncated ? '+' : ''} hexagons at level ${res} (~${formatCount(Math.round(h3.hexArea(res, h3.UNITS.km2)))} km2 each)${resAuto ? ', following the zoom' : ''}, coloured by mean FRP (MW):`}
          </p>
          <div className="legend">
            {frpStepLabels(totals.frpCuts).map((label, index) => (
              <span className="legend-step" key={index}>
                <span className="legend-bar" style={{background: FIRE_RAMP[index]}} />
                <span className="legend-value">{label}</span>
              </span>
            ))}
          </div>
          <p className="note">
            Busiest hexagon: {formatCount(totals.peak)} hotspots · Peak FRP {totals.peakFrp.toFixed(1)} MW. Click a dot for details.
          </p>
        </section>

      </div>
    </aside>
  )
}
