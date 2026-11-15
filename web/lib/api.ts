export const API_BASE = import.meta.env.VITE_API_BASE || '/api'

export type Status = 'idle' | 'loading' | 'ok' | 'error' | 'not-ready'

export type BBox = [number, number, number, number]

export interface Health {
  status: 'ok'
  rows: number
  min_ts: string
  max_ts: string
  cells: number
}

export interface Cell {
  h3: string
  detections: number
  mean_frp: number
}

export interface CellsResponse {
  cells: Cell[]
  truncated: boolean
  res?: number
}

export interface PointDetection {
  ts: string
  time_utc: string | null
  lat: number
  lon: number
  sensor: string
  satellite: string
  confidence_pct: number
  frp_mw: number
  daynight: string
  h3_r8: string
}

export interface PointsResponse {
  points: PointDetection[]
  total: number
  truncated: boolean
}

export interface CalendarMonth {
  year: number
  month: number
  detections: number
  mean_frp: number
}

export interface CalendarDay {
  date: string
  detections: number
  mean_frp: number
}

export interface SensorTotals {
  MODIS: number
  VIIRS: number
}

export interface CalendarClimatology {
  month: number
  median_detections: number
  mean_detections?: number
}

export interface CalendarAnomaly {
  year: number
  month: number
  ratio: number
}

export interface CalendarResponse {
  months: CalendarMonth[]
  days: CalendarDay[]
  climatology: CalendarClimatology[]
  anomaly: CalendarAnomaly[]
  totals: {detections: number; cells: number; sensors?: SensorTotals}
  /** Extent covered by the years before the newest one; null when there is no history. */
  history_extent?: BBox | null
}

export interface Result<T> {
  status: Status
  data: T | null
  error: string | null
}

function fail<T>(status: Status, error: string): Result<T> {
  return {status, data: null, error}
}

async function request<T>(url: string, init: RequestInit | undefined, signal?: AbortSignal): Promise<Result<T>> {
  try {
    const res = await fetch(url, {...init, signal})
    if (res.status === 503) return fail<T>('not-ready', 'Data not ready')
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const body = await res.json()
        if (body?.detail) detail = String(body.detail)
      } catch {
        /* keep the status line */
      }
      return fail<T>('error', detail)
    }
    return {status: 'ok', data: (await res.json()) as T, error: null}
  } catch (err) {
    if ((err as Error).name === 'AbortError') return fail<T>('idle', 'Cancelled')
    return fail<T>('error', (err as Error).message || 'Request failed')
  }
}

export function fetchHealth(signal?: AbortSignal) {
  return request<Health>(`${API_BASE}/health`, undefined, signal)
}

export function fetchCells(
  {
    res,
    from,
    to,
    bbox,
    sensors,
  }: {res: number; from: string; to: string; bbox: BBox; sensors?: string[]},
  signal?: AbortSignal,
) {
  const params: Record<string, string> = {res: String(res), from, to, bbox: bbox.join(',')}
  if (sensors && sensors.length === 1 && sensors[0]) {
    params.sensor = sensors[0]
  }
  const query = new URLSearchParams(params)
  return request<CellsResponse>(`${API_BASE}/cells?${query.toString()}`, undefined, signal)
}

export function fetchPoints(
  {
    bbox,
    from,
    to,
    limit = 5000,
    offset = 0,
  }: {bbox: BBox; from: string; to: string; limit?: number; offset?: number},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    bbox: bbox.join(','),
    from,
    to,
    limit: String(limit),
    offset: String(offset),
  })
  return request<PointsResponse>(`${API_BASE}/points?${query.toString()}`, undefined, signal)
}

export function fetchCalendar(
  params: {bbox?: BBox; h3_cells?: string[]; from: string; to: string; res: number},
  signal?: AbortSignal,
) {
  return request<CalendarResponse>(
    `${API_BASE}/calendar`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(params),
    },
    signal,
  )
}

export function exportCsvHref({bbox, from, to}: {bbox: BBox; from: string; to: string}) {
  const query = new URLSearchParams({bbox: bbox.join(','), from, to})
  return `${API_BASE}/export.csv?${query.toString()}`
}
