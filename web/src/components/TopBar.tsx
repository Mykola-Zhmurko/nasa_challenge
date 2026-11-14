import {formatCount} from '../../lib/ramp'

interface TopBarProps {
  detections: number
  cursor: {lat: number; lon: number} | null
  csvHref: string
  panelOpen: boolean
  onTogglePanel: () => void
}

const Mark = () => (
  <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
    <rect x="2" y="12" width="3.5" height="8" fill="#e8c48a" />
    <rect x="7.5" y="8" width="3.5" height="12" fill="#e39a4a" />
    <rect x="13" y="4" width="3.5" height="16" fill="#d9692b" />
    <rect x="18.5" y="1" width="3.5" height="19" fill="#b63a1e" />
  </svg>
)

export function TopBar({detections, cursor, csvHref, panelOpen, onTogglePanel}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <Mark />
        <h1>Fire Calendar</h1>
        <span className="sub">Harmonized hotspots, one series</span>
      </div>

      <div className="readout">
        <span className="pair">
          <span>Lat</span>
          <b>{cursor ? cursor.lat.toFixed(3) : '—'}</b>
        </span>
        <span className="pair">
          <span>Lon</span>
          <b>{cursor ? cursor.lon.toFixed(3) : '—'}</b>
        </span>
        <span className="pair lead">
          <span>Hotspots</span>
          <b>{formatCount(detections)}</b>
        </span>
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn only-mobile"
          onClick={onTogglePanel}
          aria-expanded={panelOpen}
          aria-controls="layers-panel"
        >
          Layers
        </button>
        <a className="btn btn-primary" href={csvHref} download>
          Download CSV
        </a>
      </div>
    </header>
  )
}
