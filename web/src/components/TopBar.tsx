import {type FormEvent, useState} from 'react'
import type {BBox} from '../../lib/api'
import {formatCount} from '../../lib/ramp'

interface TopBarProps {
  detections: number
  cursor: {lat: number; lon: number} | null
  csvHref: string
  panelOpen: boolean
  onTogglePanel: () => void
  onSearchBBox: (bbox: BBox, label: string) => void
  onOpenAbout: () => void
}

const NasaMark = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="10.5" fill="#1d222b" stroke="#3a3a3e" strokeWidth="1" />
    <rect x="5" y="13" width="3" height="6" fill="#f6df7f" />
    <rect x="9" y="10" width="3" height="9" fill="#f0a33e" />
    <rect x="13" y="7" width="3" height="12" fill="#df6324" />
    <rect x="17" y="4" width="3" height="15" fill="#b8321a" />
  </svg>
)

function buildSmallBBox(lat: number, lon: number, delta = 0.35): BBox | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  const minLon = Math.max(-180, Number((lon - delta).toFixed(4)))
  const minLat = Math.max(-90, Number((lat - delta).toFixed(4)))
  const maxLon = Math.min(180, Number((lon + delta).toFixed(4)))
  const maxLat = Math.min(90, Number((lat + delta).toFixed(4)))
  if (minLon >= maxLon || minLat >= maxLat) return null
  return [minLon, minLat, maxLon, maxLat]
}

function parseRawCoords(raw: string): {lat: number; lon: number} | null {
  const match = raw
    .trim()
    .match(/^([+-]?\d+(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)$/)
  if (!match) return null
  const lat = Number(match[1])
  const lon = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return {lat, lon}
}

export function TopBar({
  detections,
  cursor,
  csvHref,
  panelOpen,
  onTogglePanel,
  onSearchBBox,
  onOpenAbout,
}: TopBarProps) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed || busy) return

    const coords = parseRawCoords(trimmed)
    if (coords) {
      const box = buildSmallBBox(coords.lat, coords.lon)
      if (box) {
        onSearchBBox(box, `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`)
      }
      return
    }

    setBusy(true)
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(trimmed)}&limit=1`
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'NASA-SpaceApps-FireCalendar/1.0 (https://firms.modaps.eosdis.nasa.gov)',
        },
      })
      if (!res.ok) return
      const list = (await res.json()) as Array<{
        lat?: string
        lon?: string
        display_name?: string
      }>
      const first = list?.[0]
      if (!first) return
      const lat = Number(first.lat)
      const lon = Number(first.lon)
      const box = buildSmallBBox(lat, lon)
      if (box) {
        const shortLabel = first.display_name?.split(',')[0]?.trim() || trimmed
        onSearchBBox(box, shortLabel)
      }
    } catch {
      /* handle errors quietly */
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="topbar">
      <div className="brand">
        <button
          type="button"
          className="icon-btn menu-btn"
          onClick={onTogglePanel}
          aria-expanded={panelOpen}
          aria-controls="mode-panel"
          aria-label="Toggle mode panel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
        </button>
        <NasaMark />
        <div className="brand-copy">
          <h1>Fire Calendar</h1>
          <span className="sub">Harmonized MODIS + VIIRS active fire hotspots</span>
        </div>
      </div>

      <form className="top-search" role="search" onSubmit={handleSubmit}>
        <label htmlFor="place-search" className="sr-only">
          Search place or coordinates
        </label>
        <input
          id="place-search"
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Place or lat, lon…"
          aria-label="Search place or lat, lon"
        />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? '…' : 'Go'}
        </button>
      </form>

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

      <nav className="top-links" aria-label="Reference links">
        <a className="btn" href={csvHref} download>
          Download CSV
        </a>
        <a
          className="quiet-link"
          href="https://firms.modaps.eosdis.nasa.gov/map/"
          target="_blank"
          rel="noreferrer"
        >
          Data: NASA FIRMS
        </a>
        <button type="button" className="quiet-link" onClick={onOpenAbout}>
          About
        </button>
      </nav>
    </header>
  )
}
