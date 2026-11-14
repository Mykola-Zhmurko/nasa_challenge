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

export interface CalendarResponse {
  months: CalendarMonth[]
  days: CalendarDay[]
  climatology: {month: number; mean_detections: number}[]
  anomaly: {year: number; month: number; ratio: number}[]
  totals: {detections: number; cells: number; sensors?: SensorTotals}
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
  {res, from, to, bbox}: {res: number; from: string; to: string; bbox: BBox},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({res: String(res), from, to, bbox: bbox.join(',')})
  return request<CellsResponse>(`${API_BASE}/cells?${query.toString()}`, undefined, signal)
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
