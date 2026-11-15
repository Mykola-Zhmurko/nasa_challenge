import {type FormEvent, useEffect, useMemo, useRef, useState} from 'react'
import type {BBox} from '../../lib/api'
import {
  boxAroundPoint,
  parseCoordinates,
  type PlaceSuggestion,
  suggestPlaces,
} from '../../lib/geocode'
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
    <rect x="5" y="13" width="3" height="6" fill="#3b528b" />
    <rect x="9" y="10" width="3" height="9" fill="#269994" />
    <rect x="13" y="7" width="3" height="12" fill="#5ec962" />
    <rect x="17" y="4" width="3" height="15" fill="#fde725" />
  </svg>
)

const DEBOUNCE_MS = 220

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
  const [places, setPlaces] = useState<PlaceSuggestion[]>([])
  const [listOpen, setListOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const skipFetchRef = useRef(false)

  const coords = useMemo(() => parseCoordinates(query), [query])

  const rows = useMemo<PlaceSuggestion[]>(() => {
    if (coords) {
      return [
        {
          id: 'coords',
          name: `${coords.lat.toFixed(3)}, ${coords.lon.toFixed(3)}`,
          detail: 'Coordinates',
          isCoords: true,
          lat: coords.lat,
          lon: coords.lon,
          bbox: boxAroundPoint(coords.lat, coords.lon),
        },
      ]
    }
    return places
  }, [coords, places])

  useEffect(() => {
    const trimmed = query.trim()
    if (coords) {
      setPlaces([])
      setActive(0)
      setListOpen(true)
      return
    }
    if (trimmed.length < 2) {
      setPlaces([])
      setActive(-1)
      return
    }
    if (skipFetchRef.current) {
      // The query was just filled in by picking a suggestion — do not reopen the list.
      skipFetchRef.current = false
      setPlaces([])
      setActive(-1)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      suggestPlaces(trimmed, controller.signal)
        .then(list => {
          setPlaces(list)
          setActive(list.length ? 0 : -1)
          setListOpen(true)
        })
        .catch(() => {
          /* aborted or offline — keep the previous list */
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, coords])

  useEffect(() => {
    if (!listOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setListOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [listOpen])

  const choose = (row: PlaceSuggestion) => {
    const box = row.bbox ?? boxAroundPoint(row.lat, row.lon)
    if (!box) return
    onSearchBBox(box, row.detail && !row.isCoords ? `${row.name}, ${row.detail}` : row.name)
    skipFetchRef.current = true
    setQuery(row.name)
    setPlaces([])
    setListOpen(false)
    setActive(-1)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed || busy) return

    if (coords) {
      const box = boxAroundPoint(coords.lat, coords.lon)
      if (box) {
        onSearchBBox(box, `${coords.lat.toFixed(2)}, ${coords.lon.toFixed(2)}`)
        setListOpen(false)
      }
      return
    }

    const highlighted = active >= 0 ? rows[active] : undefined
    if (highlighted) {
      choose(highlighted)
      return
    }

    setBusy(true)
    try {
      const list = await suggestPlaces(trimmed)
      const first = list[0]
      if (first) choose(first)
    } catch {
      /* handle errors quietly */
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      if (!rows.length) return
      event.preventDefault()
      setListOpen(true)
      setActive(prev => (prev + 1) % rows.length)
    } else if (event.key === 'ArrowUp') {
      if (!rows.length) return
      event.preventDefault()
      setListOpen(true)
      setActive(prev => (prev <= 0 ? rows.length - 1 : prev - 1))
    } else if (event.key === 'Escape') {
      setListOpen(false)
      setActive(-1)
    }
  }

  const showList = listOpen && rows.length > 0

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
          <span className="sub">MODIS + VIIRS active fire hotspots</span>
        </div>
      </div>

      <div className="search-wrap" ref={wrapRef}>
        <form className="top-search" role="search" onSubmit={handleSubmit}>
          <label htmlFor="place-search" className="sr-only">
            Search city or coordinates
          </label>
          <input
            id="place-search"
            type="search"
            value={query}
            onChange={event => {
              skipFetchRef.current = false
              setQuery(event.target.value)
            }}
            onFocus={() => {
              if (rows.length) setListOpen(true)
            }}
            onKeyDown={onKeyDown}
            placeholder="City or lat, lon…"
            aria-label="Search city or lat, lon"
            role="combobox"
            aria-expanded={showList}
            aria-controls="place-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={showList && active >= 0 ? `place-option-${active}` : undefined}
            autoComplete="off"
          />
          <button type="submit" className="btn" disabled={busy}>
            {busy ? '…' : 'Go'}
          </button>
        </form>
        {showList && (
          <ul className="search-suggest" id="place-suggestions" role="listbox" aria-label="Matching cities">
            {rows.map((row, index) => (
              <li key={row.id} role="option" aria-selected={index === active} id={`place-option-${index}`}>
                <button
                  type="button"
                  className={index === active ? 'suggest-row is-active' : 'suggest-row'}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(row)}
                >
                  <span className="suggest-name">{row.name}</span>
                  {row.detail && <span className="suggest-detail">{row.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
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

      <nav className="top-links" aria-label="Reference links">
        <a className="btn" href={csvHref} download>
          Download CSV
        </a>
        <button type="button" className="quiet-link" onClick={onOpenAbout}>
          About
        </button>
      </nav>
    </header>
  )
}
